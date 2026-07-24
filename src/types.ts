/**
 * 框架内共享的核心类型。
 *
 * 对应 nanobot 的：
 *   - nanobot/agent/runner.py（LLMResponse、ToolCallRequest 等数据类）
 *   - nanobot/providers/base.py
 *
 * 这里刻意保持精简：只放 runner / providers / tools 三方都需要约定的类型；
 * provider 自家的私有字段（reasoning、provider_specific_fields 等）不污染这里。
 */

/** 喂给 LLM 的对话历史中的一条消息。 */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * 对 assistant 来说是模型回复的正文（可能为空，比如它只输出了 tool_calls）；
   * 对 tool 来说是工具执行结果的字符串；
   * 对 user / system 来说就是普通文本。
   */
  content: string;
  /** assistant 这一轮想调用工具时，把待调用的工具列表挂在这里。 */
  toolCalls?: ToolCall[];
  /** tool 消息专用：与 assistant 那条 tool_call.id 一一对应。 */
  toolCallId?: string;
  /** tool 消息专用：产生这个结果的工具名。 */
  name?: string;
}

/**
 * 模型一次想要调用的某个工具。
 *
 * 字段刻意做成 provider 中立：
 * provider 自己负责把 Anthropic content blocks / OpenAI tool_calls 等格式
 * 翻译进/出这个结构。
 */
export interface ToolCall {
  /** provider 给的唯一 id，用于把工具结果回传时对得上。 */
  id: string;
  /** 工具名，必须与 ToolRegistry 里注册的名字完全一致。 */
  name: string;
  /** 已经解析成对象的参数。无参数工具传 `{}`。 */
  arguments: Record<string, unknown>;
}

/**
 * 一次 LLM 往返调用的归一化响应。
 *
 * 同一次返回可能只有文字、只有 tool_calls、或两者都有。
 * runner 根据这三种情况决定下一步：直接结束 / 执行工具再回灌 / 边输出边等工具。
 */
export interface LLMResponse {
  /** 助手输出的自由文本（如果模型只发了 tool_calls，这里可能是空字符串）。 */
  content: string;
  /** 模型希望 runner 去执行的工具调用列表。 */
  toolCalls: ToolCall[];
  /** 模型为何停下：'stop' | 'tool_use' | 'max_tokens' | 'error' | ... */
  stopReason: string;
  /** 如果 provider 报告了 token 用量，记在这里。 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** 这次返回代表 provider 端报错时填入。 */
  error?: {
    message: string;
    retryable: boolean;
  };
}

/** 流式响应中可能出现的事件，供 provider 与 runner 之间通信。 */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_args"; id: string; deltaJson: string }
  | { type: "done"; response: LLMResponse };

/** runner 注册给 provider.chatStream() 的回调。 */
export type StreamHandler = (event: StreamEvent) => void | Promise<void>;
