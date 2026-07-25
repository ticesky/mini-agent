# 步骤 1.5 — Agent runner（多轮对话状态机）

> 对应 plan.md 的 Day 1 第 5 步。**整个项目最核心的一步**——这是 agent 框架的"心脏"。

## 目标

把"调 LLM → 执行工具 → 回灌结果 → 再调 LLM"这个循环编码成一个状态机。
完成这一步，给它接上 CLI 输入（下一步），就能跟 Claude 真正对话了。

## 交付清单

```
src/agent/
└── runner.ts    ≈ 200 行 — runTurn() + executeBatched() + runOne()
```

注：本步还顺手往 `tools/registry.ts` 加了一个 `getAll()` 方法，让 runner 不必从内部 Map 读私有字段。

## Agent loop 的本质

最容易混淆的概念：

| 概念 | 是什么 |
|---|---|
| **Event loop**（Node 的） | JS runtime 调度异步任务的底层循环。`fs.readFile` 的回调由它调度 |
| **Agent loop**（我们写的） | 跑在 event loop 之上的一个状态机：发消息 → 拿 tool_calls → 执行 → 再发 |

> Agent loop 是**业务循环**，event loop 是**调度循环**。
> 我们的 `runTurn()` 内部的 `for` 循环就是 agent loop；它每一轮内部的 `await` 让 event loop 接管去跑 HTTP / fs。

## 状态机示意

```
[构造 messages] ──► provider.chat()
                       │
                       ▼
              LLMResponse
                       │
            ┌──────────┴──────────┐
            │                     │
     有 toolCalls           没有 toolCalls
            │                     │
[并发/串行执行工具]            [结束 turn]
            │                     │
[把 tool 结果追加到 messages]    返回最终消息
            │
            └─► 回到顶端
```

伪代码（这就是 agent 框架"无框架"的核心，记住这 30 行你就懂了）：

```ts
for (let step = 1; step <= maxSteps; step++) {
  const resp = await provider.chat({ messages, tools, ... });
  if (resp.error) return { final: resp, ... };

  messages.push({ role: "assistant", content: resp.content, toolCalls: resp.toolCalls });

  if (resp.toolCalls.length === 0) return { final: resp, ... };

  const results = await executeBatched(resp.toolCalls, registry, ctx);
  for (const { call, result } of results) {
    messages.push({ role: "tool", content: result, toolCallId: call.id, name: call.name });
  }
}
return { final: resp, truncated: true };
```

整个 nanobot 的 `agent/runner.py` 1500 行代码，去掉所有 hook / 流式 / 错误分类 / file edit 跟踪 / 进度上报 / reasoning 处理 / 重试 / fail_on_tool_error / external_lookup 计数 / workspace violation 计数……剩下的就是这 30 行。

## 关键设计

### 1. 工具批次切分（read-only 并发，写工具串行）

```ts
async function executeBatched(toolCalls, registry, ctx, onProgress) {
  // 标记每个 call 是否只读
  const flags = toolCalls.map((c) => registry.get(c.name)?.readOnly ?? false);

  let i = 0;
  while (i < toolCalls.length) {
    if (flags[i]) {
      // 收集连续的只读批次
      let j = i;
      while (j < toolCalls.length && flags[j]) j++;
      const batch = toolCalls.slice(i, j);
      // 整批 Promise.all 并发
      const batchResults = await Promise.all(batch.map(...));
      ...
    } else {
      // 写工具：单独串行跑
      out[i] = await runOne(toolCalls[i], ...);
      i++;
    }
  }
}
```

LLM 一次同时要 3 个 `read_file` + 1 个 `write_file` + 2 个 `read_file`，会切成：

```
[read,read,read]  →  [write]  →  [read,read]
   并发              单独          并发
```

**顺序保留**：返回的 results 数组顺序和入参 toolCalls 一一对应——这一点很重要，下游往 messages 里 push 的顺序必须跟 LLM 期望的 tool_call_id 顺序一致。

对应 nanobot：`agent/runner.py:1018-1053` 的 `_execute_tools` + `_partition_tool_batches`。

### 2. ProgressEvent discriminated union

```ts
type ProgressEvent =
  | { type: "step_start"; step: number }
  | { type: "assistant_text"; text: string }
  | { type: "tool_start"; toolCall: ToolCall }
  | { type: "tool_end"; toolCall: ToolCall; result: string }
  | { type: "step_end"; step: number; response: LLMResponse }
  | { type: "done"; result: RunResult };
```

下一步 CLI 会订阅这个回调，把"正在调 read_file..."这种状态实时打印出来。

nanobot 用了三套 hook 系统 (`agent/hook.py` + `progress_hook.py` + `agent/runner.py` 内部状态)。我们用一个 union 类型 + 一个回调函数就够了。

### 3. maxSteps 防死循环

```ts
const maxSteps = opts.maxSteps ?? 10;
for (let step = 1; step <= maxSteps; step++) { ... }
return { ..., truncated: true };
```

Agent 死循环最常见两种：
- LLM 一直要调同一个工具（参数错误它不改）
- 工具一直返回 Error，LLM 一直重试

不设上限就是无限烧钱。**这是必须的**。
对应 nanobot：`agent/runner.py` 的 `max_iterations` 参数。

### 4. messages 是 in-place 修改的

注意 runner 直接 push 到调用方传进来的 `opts.messages` 数组，**不返回新数组**。这样：
- 调用方天然拿到完整历史
- 下次调 runTurn 不需要拼数组，直接 push 新用户消息再调即可

代价：messages 不能被多个 turn 并发使用——但 agent 本来就是串行的，这不是问题。

### 5. 暂未实现：流式 / hook / 重试

| 功能 | 状态 | 何时加 |
|---|---|---|
| 流式输出 | ❌ | 步骤 2.1 |
| Hook 系统（before/after） | ❌ | stretch goal |
| 自动重试 | ❌ | 不做，留给 caller |
| Subagent | ❌ | stretch goal |
| Token 预算检查 | ❌ | 步骤 2.5 压缩 |

## 跟 nanobot 的差异表

| 议题 | nanobot 做法 | mini-agent 做法 |
|---|---|---|
| 调度入口 | AgentLoop 跑在 bus 之上 | runTurn() 直接用 | 简化（步骤 2.2 加 bus） |
| 进度上报 | 三套 hook 系统叠加 | 一个 ProgressEvent union | 极简 |
| 工具批次 | _partition_tool_batches | executeBatched | 等价但更短 |
| 流式 | tools/runner 各种 callback | 暂未实现 | 步骤 2.1 加 |
| 错误分类 | repeated_external_lookup / workspace_violation 计数 | 不做 | MVP 不需要 |
| 中断 | CancelToken / asyncio.CancelledError | 不做 | Node 没有原生 cancel，要加得用 AbortController |
| 上下文压缩触发 | autocompact 在 turn 之间 | 步骤 2.5 加 | — |

## 对照 nanobot 看什么

读这两段对你启发最大：

1. **`nanobot/agent/runner.py:400-500`** —— 主循环骨架
   你会发现它跟我们的 for 循环一一对应，只是中间穿插了大量 progress / fail_on_tool_error / 各种 counter 的处理。**抓主线就是我们写的这 30 行。**

2. **`nanobot/agent/runner.py:1018-1210`** —— `_execute_tools` + `_run_tool`
   我们的 `executeBatched` + `runOne` 是这部分的精简版。看它处理了多少 file_edit_trackers / external_lookup_counts / workspace_violation_counts—— 都是被生产 bug 喂出来的。

## 验证

跑了 4 个 fake-provider smoke 场景（已删除测试文件）：

### 场景 1：两个 read_file 并发，然后 LLM 总结

```
steps: 2 truncated: false
final content: a.txt 是 AAA，b.txt 是 BBB。
messages count: 5
event types: step_start → assistant_text → tool_start → tool_start → tool_end → tool_end → step_end → step_start → assistant_text → step_end → done
```

注意 event 顺序：两个 `tool_start` **连续触发**（说明并发开始了），然后两个 `tool_end` 才回来。这是 read-only 批次并发的可观测证据。

最终 `messages.length === 5`：
1. user
2. assistant（带 toolCalls）
3. tool a.txt
4. tool b.txt
5. assistant（最终回答）

### 场景 2：read 后 write 必须分批

```
steps: 2
final: 完成。
elapsed ms: 1
```

两个工具被切成两批跑：[read] → [write]。runner 内部串行执行了写工具——验证了批次切分逻辑。

### 场景 3：maxSteps 截断

```
steps: 3 truncated: true
```

LLM 一直要重复读，3 步后被强制截断。

### 场景 4：provider 报错

```
steps: 1 error: rate limited
```

provider 返回带 error 的 LLMResponse 时，runner 立刻结束 turn。

## 项目当前进度

```
mini-agent/
├── package.json / tsconfig.json / .gitignore / .env.example / README.md ✅
├── doc/ (5 份文档) ✅
└── src/
    ├── types.ts                        ✅
    ├── tools/
    │   ├── base.ts                     ✅
    │   ├── registry.ts                 ✅ (+ getAll)
    │   ├── readFile.ts                 ✅
    │   ├── writeFile.ts                ✅
    │   └── bash.ts                     ✅
    ├── providers/
    │   ├── base.ts                     ✅
    │   └── anthropic.ts                ✅
    └── agent/
        └── runner.ts                   ✅ ← 本步
```

**距离 Day 1 跑通就差最后一步**：把 CLI 接上去，让用户能在终端输入。

## 下一步

**步骤 1.6 — CLI channel + 入口** ≈ 120 行：

- `src/channels/base.ts` —— Channel 接口（InboundMessage / OutboundMessage）
- `src/channels/cli.ts` —— stdin readline + stdout 渲染
- `src/index.ts` —— commander 命令入口，串起 provider + registry + tools + runner + CLI

写完这一步就能：
```bash
pnpm dev chat
> 读一下 package.json 然后告诉我项目名
[正在读 package.json...]
项目名是 mini-agent。
> 在 /tmp/test 下建个 hello.txt 写"你好"
[正在写 hello.txt...]
完成。
```
