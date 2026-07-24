/**
 * LLM Provider 抽象基类。
 *
 * 对应 nanobot/providers/base.py 的 BaseLLMProvider，但极度精简：
 *   - 暴露 chat（非流式）+ chatStream（流式）两个能力
 *   - 错误分类只分"可重试 / 不可重试"两档（nanobot 分了 6+ 档）
 *   - 不做配额识别、不做指数退避、不做 fallback
 *
 * 设计核心：runner 永远只看到 `LLMResponse`，不关心后面是 Claude / GPT / Bedrock。
 * 每个具体 provider 负责把自家 SDK 的输入输出翻译成这个统一形状。
 */
import type { LLMResponse, Message, StreamHandler } from "../types.ts";
import type { Tool } from "../tools/base.ts";

export interface ChatOptions {
  /** 完整对话历史。system 消息放在 messages[0]（如有），其余按时间序。 */
  messages: Message[];
  /** 这一轮可用的工具列表。空数组表示禁用工具调用。 */
  tools: Tool[];
  /** 模型名。例如 'claude-sonnet-4-5'。 */
  model: string;
  /** 单次回复 token 上限。 */
  maxTokens?: number;
  /** 采样温度 0~1。 */
  temperature?: number;
}

/** Provider 抽象：所有具体 provider（anthropic / openai / ...）都实现这个接口。 */
export interface Provider {
  /** Provider 名字，仅用于日志。 */
  readonly name: string;

  /** 一次完整往返调用，返回归一化的 LLMResponse。 */
  chat(opts: ChatOptions): Promise<LLMResponse>;

  /**
   * 流式版本。逐事件回调 onEvent，并在末尾返回完整 LLMResponse。
   * 默认实现是 fallback 到 chat() 然后一次性 emit 'done'，
   * 真要"边出边显示"必须 provider 自己重写。
   */
  chatStream(opts: ChatOptions, onEvent: StreamHandler): Promise<LLMResponse>;
}

/**
 * 把异常翻成统一的"错误响应"，让 runner 不必区分异常 vs LLMResponse.error。
 *
 * 简化版：只看 status code 和 'timeout' / 'ECONNRESET' 等标志位。
 * 对应 nanobot/providers/base.py 的 `_is_transient_response` 一类逻辑。
 */
export function errorToResponse(err: unknown): LLMResponse {
  const msg =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  // Anthropic / OpenAI SDK 抛的错误带 status 字段
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status: unknown }).status)
      : NaN;

  // 5xx / 429 / 网络错误视作可重试
  const retryable =
    (Number.isFinite(status) && (status === 429 || status >= 500)) ||
    /timeout|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(msg);

  return {
    content: "",
    toolCalls: [],
    stopReason: "error",
    error: { message: msg, retryable },
  };
}

/**
 * 默认的 chatStream fallback：内部跑非流式 chat，结束时把整段一次性 emit 给 handler。
 * provider 没有真流式能力时（或测试 mock 时）可以用它。
 */
export async function defaultChatStream(
  provider: Pick<Provider, "chat">,
  opts: ChatOptions,
  onEvent: StreamHandler,
): Promise<LLMResponse> {
  const resp = await provider.chat(opts);
  if (resp.content) {
    await onEvent({ type: "text", delta: resp.content });
  }
  for (const tc of resp.toolCalls) {
    await onEvent({ type: "tool_call_start", id: tc.id, name: tc.name });
    await onEvent({
      type: "tool_call_args",
      id: tc.id,
      deltaJson: JSON.stringify(tc.arguments),
    });
  }
  await onEvent({ type: "done", response: resp });
  return resp;
}
