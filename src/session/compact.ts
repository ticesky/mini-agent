/**
 * 上下文压缩（auto-compaction）。
 *
 * 对应 nanobot/agent/autocompact.py（极简版）。
 *
 * 触发条件：
 *   - messages 里累积的 token 数超过阈值
 *
 * 压缩策略：
 *   1. 保留 system 消息（messages[0]）
 *   2. 保留最近 KEEP_RECENT 条消息（默认 6，3 轮对话）
 *   3. 中间消息让 LLM 总结成一段话，作为新的 user 消息（标记为 [历史摘要]）插到 system 后面
 *
 * 不做的事（vs nanobot 的 autocompact.py）：
 *   - 不在 turn 中间检测，只在 turn 之间检测（更安全）
 *   - 不做 streaming compact
 *   - 不做"摘要的摘要"层级——超出 maxTokens 多次时就反复压
 *   - 不分 user / assistant / tool 分别记 token，统一估算
 */
import { encode } from "gpt-tokenizer";
import type { LLMResponse, Message } from "../types.ts";
import type { Provider } from "../providers/base.ts";

/** 上下文压缩选项。 */
export interface CompactOptions {
  /** token 阈值。超过就触发压缩。 */
  thresholdTokens: number;
  /** 保留最近 N 条消息（不参与压缩），默认 6。 */
  keepRecent?: number;
  /** 调 LLM 用的 provider。 */
  provider: Provider;
  /** 模型名。一般跟主对话用同一个。 */
  model: string;
}

/**
 * 估算消息总 token 数。
 *
 * 注意：gpt-tokenizer 用的是 GPT 系列分词器，跟 Claude 的真实分词有差异。
 * 但作为"判断要不要压缩"的粗略阈值够用——MVP 不在意 ±20% 误差。
 *
 * 如果以后想要更准确，可以：
 *   - Anthropic：用 client.messages.countTokens()（额外一次 API）
 *   - OpenAI：tiktoken 用 cl100k_base 编码
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += encode(m.content).length + 4; // 4 ≈ role/分隔符的 token 额度
    for (const tc of m.toolCalls ?? []) {
      total += encode(tc.name).length;
      total += encode(JSON.stringify(tc.arguments)).length;
    }
    if (m.name) total += encode(m.name).length;
  }
  return total;
}

/**
 * 检查是否需要压缩，需要的话原地修改 messages：
 *   保留 messages[0] (system) → 摘要消息 → 最近 keepRecent 条
 *
 * 返回是否真的执行了压缩（true 表示 messages 被改了）。
 *
 * messages 必须是 [system, ...] 开头，否则不压缩。
 */
export async function maybeCompact(
  messages: Message[],
  opts: CompactOptions,
): Promise<{ compacted: boolean; before: number; after: number }> {
  const before = estimateTokens(messages);
  if (before < opts.thresholdTokens) {
    return { compacted: false, before, after: before };
  }

  if (messages.length === 0 || messages[0]?.role !== "system") {
    // 不符合预期结构（没有 system），不压
    return { compacted: false, before, after: before };
  }

  const keepRecent = opts.keepRecent ?? 6;
  // 至少要有 system + keepRecent + 1 条要压的，才有意义
  if (messages.length <= 1 + keepRecent + 1) {
    return { compacted: false, before, after: before };
  }

  const system = messages[0]!;
  const tail = messages.slice(messages.length - keepRecent);
  const middle = messages.slice(1, messages.length - keepRecent);

  // 调 LLM 把 middle 摘要成一段话
  const summary = await summarize(middle, opts);

  // 替换 messages
  messages.length = 0;
  messages.push(system);
  messages.push({
    role: "user",
    content: `[历史摘要] 以下是早期对话的精简摘要，供你延续上下文：\n\n${summary}`,
  });
  messages.push(...tail);

  const after = estimateTokens(messages);
  return { compacted: true, before, after };
}

/** 调 LLM 把一组消息总结成一段文本。 */
async function summarize(
  msgs: Message[],
  opts: CompactOptions,
): Promise<string> {
  // 把消息序列化成可读形式喂给 LLM
  const transcript = msgs
    .map((m) => {
      if (m.role === "tool") {
        return `[tool ${m.name}] ${truncate(m.content, 500)}`;
      }
      const text = m.content || "";
      const tools = (m.toolCalls ?? [])
        .map((tc) => `→ ${tc.name}(${JSON.stringify(tc.arguments)})`)
        .join(" ");
      return `[${m.role}] ${truncate(text, 500)}${tools ? "\n  " + tools : ""}`;
    })
    .join("\n");

  const prompt: Message[] = [
    {
      role: "system",
      content:
        "你是一个对话摘要器。把下面这段对话压缩成简洁的中文摘要，要求：" +
        "1) 列出已经讨论过的关键事实/决定；" +
        "2) 列出已经查过的文件/命令及其结论；" +
        "3) 列出未完成的任务（如有）。" +
        "不要复述完整对话，只保留对后续对话有用的信息。",
    },
    { role: "user", content: transcript },
  ];

  const resp: LLMResponse = await opts.provider.chat({
    messages: prompt,
    tools: [],
    model: opts.model,
    maxTokens: 1024,
  });

  return resp.content || "（摘要失败，原文已被丢弃）";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}
