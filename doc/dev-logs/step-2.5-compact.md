# 步骤 2.5 — 上下文压缩（auto-compaction）

> 对应 plan.md 的 Day 2 第 5 步。Day 2 收官。

## 目标

对话变长后，把早期消息让 LLM 总结成一段话，腾出 context 空间继续对话。

## 交付清单

```
src/session/compact.ts   ≈ 130 行 — estimateTokens + maybeCompact + summarize
src/index.ts              接线：每轮结束后 maybeCompact，触发时打日志
```

## 触发与策略

### 触发

```ts
const before = estimateTokens(messages);
if (before < opts.thresholdTokens) return { compacted: false, ... };
```

每轮结束后估算总 token，超过阈值才压缩。默认阈值 `32000`，可通过：
- 环境变量 `COMPACT_THRESHOLD_TOKENS`
- 命令行 `--compact-threshold <n>`

刻意只在 turn 之间检测、不在 turn 中间检测——压缩需要调一次额外 LLM，turn 中间触发会卡用户。

### 策略

```
[system] [u1 a1 t1 u2 a2 t2 ...... u29 a29 t29 u30 a30 t30]
   ↓
[system] [user 历史摘要] [u28 a28 t28 u29 a29 t29 u30 a30 t30]
                          ↑ 保留最近 keepRecent=6 条
```

1. 永远保留 `messages[0]`（system prompt）
2. 保留最后 `keepRecent` 条（默认 6，即最近 3 轮 user/assistant）
3. 中间消息让 LLM 总结成一段话，作为 user 消息插到 system 后面，前缀 `[历史摘要]`

## 关键设计

### 1. token 估算用 gpt-tokenizer

```ts
import { encode } from "gpt-tokenizer";

export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += encode(m.content).length + 4;      // 4 ≈ role/分隔符
    for (const tc of m.toolCalls ?? []) {
      total += encode(tc.name).length;
      total += encode(JSON.stringify(tc.arguments)).length;
    }
  }
  return total;
}
```

要点：
- `gpt-tokenizer` 用的是 GPT 系列分词器（`cl100k_base`），跟 Claude 不完全一致
- 但作为"判断要不要压缩"的粗略阈值够用——MVP 不在意 ±20% 误差
- 如果想更精确，Anthropic 提供 `client.messages.countTokens()`（要额外一次 API 调用）

对应 nanobot：用 `tiktoken` Python 包，`agent/autocompact.py` 里有 `estimate_prompt_tokens_chain`。

### 2. summarize 用一次"光秃 LLM 调用"

```ts
const prompt: Message[] = [
  { role: "system", content: "你是一个对话摘要器。把下面这段对话压缩成简洁的中文摘要..." },
  { role: "user", content: transcript },
];
const resp = await opts.provider.chat({
  messages: prompt,
  tools: [],                  // ← 注意：禁用工具
  model: opts.model,
  maxTokens: 1024,
});
```

注意点：
- `tools: []` 禁用工具——总结任务不需要工具，给了反而可能让模型瞎调
- 用一个**新的对话**做总结，不在原 messages 上做，避免污染
- 指令用结构化要求："1) 列出已讨论的关键事实 2) 列出查过的文件/命令 3) 列出未完成任务"——比"请总结"效果好得多

### 3. transcript 序列化

```ts
const transcript = msgs.map(m => {
  if (m.role === "tool") {
    return `[tool ${m.name}] ${truncate(m.content, 500)}`;
  }
  const tools = (m.toolCalls ?? [])
    .map(tc => `→ ${tc.name}(${JSON.stringify(tc.arguments)})`)
    .join(" ");
  return `[${m.role}] ${truncate(m.content, 500)}${tools ? "\n  " + tools : ""}`;
}).join("\n");
```

把消息序列化成可读形式：
- 每条消息用 `[role]` 标注
- 工具调用以 `→ tool_name(args)` 形式附在 assistant 行后
- 工具结果用 `[tool name] content` 形式
- 单条消息内容截到 500 字（防止单条工具结果就把摘要 prompt 撑爆）

### 4. 安全条件：消息太少不压

```ts
if (messages.length <= 1 + keepRecent + 1) {
  return { compacted: false, before, after: before };
}
```

至少要有 system + keepRecent + 1 条要压的，才有意义。否则压完反而更长（因为多了一条摘要消息）。

## 验证

跑了一个 fake provider 的单元测试（已删除文件）：

```
before: 10144 tokens, 61 messages

threshold=100k → { compacted: false, before: 10144, after: 10144 }
threshold=100  → { compacted: true,  before: 10144, after: 1345 }

after compaction: 8 messages
[system] 你是助手。你是助手。…
[user] [历史摘要] 以下是早期对话的精简摘要：用户讨论了 X 主题，已查看 a.ts，未完成 Y。
[user] 第 27 轮的问题。…    ← keepRecent=6 的开头
[assistant] 第 27 轮的回答。…
[user] 第 28 轮的问题。…
[assistant] 第 28 轮的回答。…
[user] 第 29 轮的问题。…
[assistant] 第 29 轮的回答。…
```

61 条消息 → 8 条，10144 tokens → 1345 tokens。压缩率约 **87%**。
结构正确：
- system 在最前
- 摘要消息插在第 2 位（user 角色 + `[历史摘要]` 前缀）
- 最后 6 条原样保留（keepRecent=6）

集成到 agent loop 里，每轮结束自动检测：

```ts
const compacted = await maybeCompact(messages, {
  provider, model: opts.model, thresholdTokens: opts.compactThreshold,
});
if (compacted.compacted) {
  stdout.write(`[compact] ${before} → ${after} tokens\n`);
}
```

触发时会打印：
```
[compact] 35421 → 4830 tokens
```

## 跟 nanobot 的差异

| 议题 | nanobot 做法 | mini-agent 做法 |
|---|---|---|
| 触发时机 | turn 中间也可触发（流式压缩） | 只在 turn 之间 |
| Token 计数 | tiktoken（精确到模型） | gpt-tokenizer（粗略） |
| 多层摘要 | "摘要的摘要"递归压缩 | 反复压同一个摘要 |
| user/tool/assistant 分别配额 | 有 | 没有，统一计数 |
| 保留策略 | 可配置 keep_recent / keep_first | 仅 keepRecent |

## Day 2 收官

到此为止 Day 2 全部 5 步完成：

```
2.1 流式响应                  ✅
2.2 MessageBus + AsyncQueue   ✅
2.3 会话历史持久化            ✅
2.4 MCP 客户端                ✅
2.5 上下文压缩                ✅
```

学习目标全部达成：

| 目标 | 状态 | 文件 |
|---|---|---|
| Agent loop 的本质 | ✅ | `src/agent/runner.ts` |
| LLM provider 抽象与 SDK 包装 | ✅ | `src/providers/{base,anthropic}.ts` |
| Tool 系统：定义/注册/校验/并发执行/错误回填 | ✅ | `src/tools/{base,registry,...}.ts` |
| MCP 协议接入 | ✅ | `src/mcp/client.ts` |
| 会话记忆与历史压缩 | ✅ | `src/session/{memory,compact}.ts` |
| channel ↔ agent 解耦的消息总线 | ✅ | `src/agent/loop.ts`, `src/bus/queue.ts` |

总代码量：约 1700 行 TypeScript（含中文注释）。比目标 1500 行多了一些主要在错误处理和注释上。
