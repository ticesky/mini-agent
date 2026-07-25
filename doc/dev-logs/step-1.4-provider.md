# 步骤 1.4 — Provider 抽象 + Anthropic 实现（非流式）

> 对应 plan.md 的 Day 1 第 4 步。第一次跑通"我们的类型 ↔ Anthropic API"双向翻译。

## 目标

把"调 LLM"这件事抽象成一个统一接口，runner 不必关心后面是 Claude / GPT / Bedrock。
本步只实现 Anthropic 一个 provider，且暂不做流式（流式留到步骤 2.1）。

## 交付清单

```
src/providers/
├── base.ts        ≈ 70 行  — Provider 接口、ChatOptions、errorToResponse
└── anthropic.ts   ≈ 130 行 — AnthropicProvider 实现 + 双向翻译
```

## 关键设计

### 1. Provider 用接口而不是 abstract class

nanobot 用 abstract class（`BaseLLMProvider`），我们用 TS interface：

```ts
export interface Provider {
  readonly name: string;
  chat(opts: ChatOptions): Promise<LLMResponse>;
  chatStream?(opts: ChatOptions, onEvent: StreamHandler): Promise<LLMResponse>;
}
```

interface 比 class 灵活：
- 测试时直接写一个对象字面量当 mock
- 不用 super 调用，不用考虑继承复用
- 共享逻辑（如 `errorToResponse`）做成顶层函数，不绑死在 class 上

### 2. 错误归一只分两档

```ts
return {
  content: "",
  toolCalls: [],
  stopReason: "error",
  error: { message, retryable },
};
```

retryable 的判定：

```ts
const retryable =
  (status === 429 || status >= 500) ||
  /timeout|ECONNRESET|.../.test(msg);
```

nanobot 在 `providers/base.py` 把错误分了 6+ 档（transient / arrearage / retryable_429 / billing / fatal / ...），是被各家 SDK 的不同错误格式喂出来的。MVP 第一版只分两档，**等真遇到具体问题再加**。

### 3. 翻译层：四个关键差异

Anthropic Messages API 跟 OpenAI 格式差别比想象中大，下面是我们在 `anthropic.ts` 里处理的四个关键点：

#### a) `system` 消息独立放顶层

```ts
{ role: "system", content: "..." }   // 我们的格式（沿用 OpenAI）
        ↓
this.client.messages.create({
  system: "...",                     // Anthropic 顶层参数
  messages: [...],                   // 不含 system
})
```

`splitSystem()` 函数负责把它拆出来。

#### b) assistant 回复是 content blocks 数组

OpenAI 风格：assistant 消息 content 是字符串，tool_calls 是单独字段。
Anthropic 风格：assistant 消息 content 是 `(text | tool_use)[]` 混排数组。

```ts
{
  role: "assistant",
  content: [
    { type: "text", text: "我来帮你查一下..." },
    { type: "tool_use", id: "...", name: "read_file", input: {...} },
  ],
}
```

我们在 `toAnthropicMessage` 里把 `Message.content` + `Message.toolCalls[]` 合并成这种数组。

#### c) 工具结果用 user 角色 + tool_result block

OpenAI 风格：`{ role: "tool", tool_call_id: "...", content: "..." }`
Anthropic 风格：`{ role: "user", content: [{ type: "tool_result", tool_use_id: "...", content: "..." }] }`

注意是 **user 角色**！Anthropic 没有专门的 "tool" 角色。这是新手最容易踩的坑。

#### d) 工具 schema 顶层是 input_schema

OpenAI: `{ type: "function", function: { name, description, parameters } }`
Anthropic: `{ name, description, input_schema }`

`input_schema` 直接就是参数的 JSON Schema 对象，不再嵌套。

### 4. 响应解析：把 content blocks 拍平

```ts
for (const block of resp.content) {
  if (block.type === "text") content += block.text;
  else if (block.type === "tool_use") toolCalls.push({...});
}
```

把 Anthropic 的混排 blocks 拆成我们 `LLMResponse` 里的 `content` (字符串) + `toolCalls[]` 两个字段。
信息没丢——只是格式重排——下一轮往回发的时候 `toAnthropicMessage` 又能合回 blocks 数组。

## 跟 nanobot 的差异表

| 议题 | nanobot 做法 | mini-agent 做法 | 为什么 |
|---|---|---|---|
| Provider 抽象 | abstract class | TS interface | TS 写 mock/共享逻辑更顺 |
| 客户端创建 | lazy init（首次调用时建） | 构造函数里直接建 | MVP 不在意启动开销 |
| 错误分档 | 6+ 档 + status code 表 + arrearage 识别 | 2 档（retryable / 不） | 真遇到再加 |
| 重试 | `chat_with_retry`、指数退避 | 不做，runner 层第一版直接报错 | 简化 |
| HTTP 客户端配置 | 自定义 httpx 透传/代理 | 默认 SDK | 没需求 |
| 工具 schema 转换 | dict 操作 | zodToJsonSchema | zod 生态 |
| reasoning 字段 | 单独保留 | 直接丢弃 | MVP 不展示 |

## 对照 nanobot 看什么

读这两段最有收获：

1. **`nanobot/providers/base.py:359-388`** —— `chat()` 抽象方法签名
   特别是它的 retry / error_kind / arrearage 一整套，对照我们 `errorToResponse` 的 2 行实现，看一个项目"长出工程包浆"的样子。

2. **`nanobot/providers/anthropic_provider.py:580-650`** —— `_build_kwargs` + `_parse_response`
   核心翻译逻辑。我们做的事一模一样，但它考虑了 cache_control（prompt cache）、prefill、thinking 模式等等——MVP 没有这些字段就特别清爽。

## 验证

`pnpm typecheck` 通过。**真正的 LLM 调用要等到步骤 1.5 把 runner 写完才能跑** —— 单独测 provider.chat() 没意义，它需要 runner 提供 messages 历史。

但翻译逻辑本身可以静态校验：上面四个差异点的 TS 类型都被 `@anthropic-ai/sdk` 的 `MessageParam` / `Tool` 等类型定义约束着，写错就编译不过。

## 下一步

**步骤 1.5 — Agent runner（多轮对话状态机）** ≈ 180 行：

整个项目最核心的一步。runner 干的事：

```
1. 把 messages + tools 喂给 provider.chat()
2. 拿回 LLMResponse
3. 如果有 toolCalls → 并发执行（read-only）+ 串行（写）→ 拼成 tool 消息追加到 messages
4. 回到 1，循环直到 stopReason !== 'tool_use'
```

写完这一步，project 就第一次能"跑起来"了。
