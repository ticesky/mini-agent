# 步骤 2.1 — 流式响应

> 对应 plan.md 的 Day 2 第 1 步。让 LLM 边生成边输出，CLI 看到的不再是"等几秒蹦出整段"。

## 目标

把 `provider.chat()` 改造成 `provider.chatStream()`，让 runner 和 CLI 能实时拿到：
- 每个 token 的文本增量
- 工具调用的 JSON 参数分片增量

## 交付清单

```
src/
├── providers/
│   ├── base.ts        新增 chatStream 抽象 + defaultChatStream fallback
│   └── anthropic.ts   新增 chatStream 实现，消费 messages.stream()
├── agent/
│   └── runner.ts      新增 stream 选项 + 三个新 ProgressEvent
├── channels/
│   └── cli.ts         新增 token 级渲染、跨流式/非流式兼容
└── index.ts           新增 --no-stream 选项 + 工作区修复
```

## Anthropic 流式协议要点

`messages.stream()` 返回一个 async iterable，事件序列大致是：

```
message_start                           ← 整体开始，含 input_tokens
  content_block_start (text)            ← 一段 text 块开始
    content_block_delta (text_delta) × N    ← 文本逐字增量
  content_block_stop                    ← 该块结束
  content_block_start (tool_use)        ← 一段 tool_use 块开始（含 id + name）
    content_block_delta (input_json_delta) × M ← 参数 JSON 字符串分片
  content_block_stop                    ← 该工具的参数到齐
  ... 可能还有更多 content_block ...
message_delta                           ← 收尾，含 stop_reason / usage.output_tokens
message_stop                            ← 整体结束
```

### 最容易踩的坑：tool_use 的 input 是**逐字符 JSON 字符串**

不是对象。每个 `input_json_delta` 都是 JSON 字符串的一片：

```
Δ "{\"pa"
Δ "th\":"
Δ " \"src/i"
Δ "ndex.ts\"}"
```

直到 `content_block_stop` 才能把整段拼起来 `JSON.parse` 成对象。

我们在 `anthropic.ts` 里用一个 Map 累积每块的状态：

```ts
const blocks = new Map<
  number,
  | { kind: "text" }
  | { kind: "tool_use"; id: string; name: string; jsonAccum: string }
>();
```

`content_block_stop` 的时候不立刻 parse（`jsonAccum` 还可能在后面被追加），而是等所有事件消费完再统一遍历 Map 把 tool_use 块解析成 ToolCall[]。这跟 nanobot Python 那边的做法一致。

## StreamEvent 设计

```ts
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_args"; id: string; deltaJson: string }
  | { type: "done"; response: LLMResponse };
```

注意：**没有 `tool_call_end` 事件**。原因是 runner 等 `chatStream()` 的 Promise resolve 后会自然处理工具执行——不需要"块结束"的中间通知。极简化原则。

`done` 事件里携带的 `response` 才是最终拼好的 `LLMResponse`，含完整 content、toolCalls[]、usage。

## Runner 的最小改动

新增 `stream: boolean` 选项，分支调用：

```ts
if (opts.stream) {
  lastResponse = await opts.provider.chatStream(chatOpts, async (ev) => {
    // 把 provider 的 StreamEvent 转成 runner 的 ProgressEvent
    switch (ev.type) {
      case "text":
        await opts.onProgress?.({ type: "llm_text_delta", delta: ev.delta });
        break;
      case "tool_call_start":
        await opts.onProgress?.({ type: "llm_tool_call_start", id: ev.id, name: ev.name });
        break;
      case "tool_call_args":
        await opts.onProgress?.({ type: "llm_tool_call_args", id: ev.id, deltaJson: ev.deltaJson });
        break;
      case "done":
        break;  // chatStream 返回后 runner 自己继续推动
    }
  });
} else {
  lastResponse = await opts.provider.chat(chatOpts);
}
```

后面的工具执行、回灌历史等逻辑**完全不变**——这是 ProgressEvent 抽象的红利。

新增三个 ProgressEvent，加 `llm_` 前缀和已有的 `tool_start` / `tool_end`（runner 自己执行工具时触发）区分开：

```ts
| { type: "llm_text_delta"; delta: string }            // 流式文本 token
| { type: "llm_tool_call_start"; id; name }            // 流式工具调用开始
| { type: "llm_tool_call_args"; id; deltaJson }        // 流式工具参数增量
```

## CLI 的渲染策略

要同时漂亮地渲染流式 + 非流式两种模式，需要小心。最终方案：

```ts
case "llm_text_delta":            stdout.write(event.delta);
case "llm_tool_call_start":       stdout.write(`\n  ⚙ ${name}(`);     // 注意没闭括号
case "llm_tool_call_args":        stdout.write(c.cyan(event.deltaJson));
case "tool_start":                                                       // ↓
  if (this.streamingToolCallIds.has(event.toolCall.id)) {
    stdout.write(c.cyan(")\n"));                       // 流式：补 ")"
  } else {
    stdout.write(`  ⚙ ${name}(${args})\n`);            // 非流式：完整一行
  }
case "tool_end":                  stdout.write(c.dim(`    ↳ ${preview}\n`));
```

观感：

**流式（默认）**：
```
> 请读 package.json，告诉我项目名

  ⚙ read_file({"path": "package.json"})
    ↳ {

`name` 字段的值是 **`mini-agent`**。
```

文本 / 工具名 / 工具参数都是**逐字浮现**的，看起来跟 ChatGPT 网页版很像。

**非流式（`--no-stream`）**：
```
> 请读 package.json，告诉我项目名
  ⚙ read_file(path="package.json")
    ↳ {

`name` 字段的值是 **`mini-agent`**。
```

工具调用一行打完，然后整段文本一次性出现。

## 一个工程小坑：`pnpm dev` 改了 cwd

测试时发现：从其它目录启动 `pnpm dev chat` 时，workspace 总是变成 mini-agent 项目根，而不是用户当前所在的目录。

原因：pnpm 在执行 script 前会先 `cd` 到 `package.json` 所在目录，所以 `process.cwd()` 总是项目根。

修复：改用 `INIT_CWD` 环境变量，pnpm 会把"用户启动时的目录"塞到这个变量里：

```ts
const workspace = resolve(
  opts.workspace ?? process.env.INIT_CWD ?? process.cwd(),
);
```

现在 `cd /tmp/foo && pnpm dev --prefix ~/caozhong/source-code/mini-agent chat` 这种用法也能正确把 `/tmp/foo` 当 workspace 了。

## 跟 nanobot 的差异

| 议题 | nanobot 做法 | mini-agent 做法 |
|---|---|---|
| 流式接口 | `chat_stream(...)` 多个独立 callback | 单 handler + StreamEvent union |
| tool_call 增量 | `on_tool_call_delta` 回调 | `tool_call_args` 事件 |
| 中断 | CancelToken | 不做 |
| live file edit | 边流边 apply patch | 不做 |
| 重试 | `chat_stream_with_retry` | 不做 |

## 验证

实测端到端：

**流式（默认）** — 文本和工具参数都逐字浮现：
```
$ pnpm dev chat
> 请读 package.json 文件，告诉我里面的 name 字段值。

  ⚙ read_file({"path": "package.json"})       ← 工具名 + JSON 参数逐字
    ↳ {                                         ← 工具结果首行预览

`name` 字段的值是 **`mini-agent`**。            ← 最终回答逐字
[steps=2 in=935 out=18]
```

**非流式** — 一次性出现：
```
$ pnpm dev chat --no-stream
> 请读 package.json 文件，告诉我里面的 name 字段值。
  ⚙ read_file(path="package.json")             ← 工具名 + 参数一次出现
    ↳ {

`name` 字段的值是 **`mini-agent`**。            ← 整段一次出现
[steps=2 in=5792 out=18]
```

两种模式行为一致、token 用量一致，只是用户感知的延迟差很多。

## 项目当前进度

```
mini-agent/
├── doc/ (8 份文档)
└── src/
    ├── types.ts
    ├── tools/  (5 个文件)
    ├── providers/
    │   ├── base.ts        ✅ + chatStream 抽象
    │   └── anthropic.ts   ✅ + 流式实现
    ├── agent/
    │   └── runner.ts      ✅ + stream 选项 + 3 个新事件
    ├── channels/
    │   ├── base.ts
    │   └── cli.ts         ✅ + token 级渲染
    └── index.ts           ✅ + --no-stream + INIT_CWD 修复
```

## 下一步

**步骤 2.2 — MessageBus + AsyncQueue** ≈ 150 行：

把"channel 收到消息 → 直接回调 runner"改造成"channel push 进 bus → runner 从 bus pop 出来跑"，让两边真正解耦。

学习重点：
- `AsyncQueue<T>` 的实现（Node 没原生异步队列）
- 多个 channel / 多个 session 时怎么调度
