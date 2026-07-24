/**
 * Anthropic provider —— 把我们的 Message/ToolCall 翻译成 Anthropic Messages API
 * 的格式，再把响应翻译回我们的 LLMResponse。
 *
 * 对应 nanobot/providers/anthropic_provider.py（精简到主干）。
 *
 * 翻译要点（和 OpenAI 不一样的地方）：
 *   1. system 消息不放在 messages 里，而是顶层 system 参数
 *   2. 助手回复内容是 content blocks 数组：text / tool_use 两种类型混排
 *   3. 工具结果用 user 角色的 tool_result content block 表达，不是单独的 tool 角色
 *   4. 工具 schema 顶层就是 input_schema（不是 OpenAI 的 function.parameters 嵌套）
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LLMResponse, Message, StreamHandler, ToolCall } from "../types.ts";
import type { Tool } from "../tools/base.ts";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ChatOptions, Provider } from "./base.ts";
import { errorToResponse } from "./base.ts";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(opts: { apiKey: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async chat(opts: ChatOptions): Promise<LLMResponse> {
    const { system, messages } = splitSystem(opts.messages);
    const tools = opts.tools.map(toAnthropicTool);

    try {
      const resp = await this.client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(system ? { system } : {}),
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      });
      return parseAnthropicResponse(resp);
    } catch (e) {
      return errorToResponse(e);
    }
  }

  /**
   * 流式调用。Anthropic SDK 的 `messages.stream()` 返回一个 async iterable，
   * 我们消费它的 RawMessageStreamEvent，把里面的事件翻成我们自己的 StreamEvent。
   *
   * Anthropic 流式事件序列大致是：
   *   message_start
   *     content_block_start (type: text)
   *       content_block_delta (type: text_delta) × N
   *     content_block_stop
   *     content_block_start (type: tool_use)              ← 工具调用开始
   *       content_block_delta (type: input_json_delta) × M ← 参数 JSON 字符串分片
   *     content_block_stop                                ← 这块工具的参数到齐
   *     ... 可能还有更多 content_block ...
   *   message_delta (含 stop_reason / usage)
   *   message_stop
   *
   * 关键点：tool_use 块的 input 是**逐字符 JSON 字符串**到达的，
   * 直到 content_block_stop 才能把整段拼起来 JSON.parse 成对象。
   */
  async chatStream(
    opts: ChatOptions,
    onEvent: StreamHandler,
  ): Promise<LLMResponse> {
    const { system, messages } = splitSystem(opts.messages);
    const tools = opts.tools.map(toAnthropicTool);

    // 累积器：一个流式响应里可能有多段文本和多个工具调用
    let textAccum = "";
    /** index → { id, name, jsonAccum } */
    const blocks = new Map<
      number,
      { kind: "text" } | { kind: "tool_use"; id: string; name: string; jsonAccum: string }
    >();
    let stopReason = "stop";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const stream = this.client.messages.stream({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(system ? { system } : {}),
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      });

      for await (const ev of stream) {
        switch (ev.type) {
          case "message_start": {
            inputTokens = ev.message.usage.input_tokens ?? 0;
            break;
          }

          case "content_block_start": {
            const cb = ev.content_block;
            if (cb.type === "text") {
              blocks.set(ev.index, { kind: "text" });
            } else if (cb.type === "tool_use") {
              blocks.set(ev.index, {
                kind: "tool_use",
                id: cb.id,
                name: cb.name,
                jsonAccum: "",
              });
              await onEvent({
                type: "tool_call_start",
                id: cb.id,
                name: cb.name,
              });
            }
            break;
          }

          case "content_block_delta": {
            const block = blocks.get(ev.index);
            if (!block) break;
            const delta = ev.delta;
            if (delta.type === "text_delta" && block.kind === "text") {
              textAccum += delta.text;
              await onEvent({ type: "text", delta: delta.text });
            } else if (
              delta.type === "input_json_delta" &&
              block.kind === "tool_use"
            ) {
              block.jsonAccum += delta.partial_json;
              await onEvent({
                type: "tool_call_args",
                id: block.id,
                deltaJson: delta.partial_json,
              });
            }
            // thinking_delta 等其它类型暂不处理
            break;
          }

          case "content_block_stop": {
            // 单个块结束，无需特殊处理（解析在 done 里统一做）
            break;
          }

          case "message_delta": {
            if (ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
            if (ev.usage) outputTokens = ev.usage.output_tokens;
            break;
          }

          case "message_stop":
            break;
        }
      }

      // 把累积好的 tool_use 块解析成 ToolCall[]
      const toolCalls: ToolCall[] = [];
      for (const block of blocks.values()) {
        if (block.kind !== "tool_use") continue;
        let args: Record<string, unknown> = {};
        if (block.jsonAccum.trim()) {
          try {
            args = JSON.parse(block.jsonAccum);
          } catch {
            // 极少数情况下 JSON 不完整——交给 registry 里的 zod 校验报错
            args = { __raw: block.jsonAccum };
          }
        }
        toolCalls.push({ id: block.id, name: block.name, arguments: args });
      }

      const response: LLMResponse = {
        content: textAccum,
        toolCalls,
        stopReason,
        usage: { inputTokens, outputTokens },
      };

      await onEvent({ type: "done", response });
      return response;
    } catch (e) {
      const errResp = errorToResponse(e);
      await onEvent({ type: "done", response: errResp });
      return errResp;
    }
  }
}

/** 拆出 system 消息（Anthropic 把它放顶层），其余翻成 Anthropic messages。 */
function splitSystem(messages: Message[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  let system: string | undefined;
  const out: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      // 多条 system 拼接（一般只有一条）
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }
    out.push(toAnthropicMessage(m));
  }

  // Anthropic 要求第一条必须是 user。如果 caller 没传 user 消息，加一个空的占位会被 API 拒。
  // 这里就让它原样报错——是 caller 的 bug。
  return { system, messages: out };
}

/** 把我们的 Message 翻成 Anthropic 的 MessageParam。 */
function toAnthropicMessage(m: Message): Anthropic.MessageParam {
  if (m.role === "user") {
    return { role: "user", content: m.content };
  }

  if (m.role === "assistant") {
    // 助手轮可能既有文本又有 tool_use
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (m.content) {
      blocks.push({ type: "text", text: m.content });
    }
    for (const tc of m.toolCalls ?? []) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      });
    }
    // 兼容只有 text 的简单情况：直接传字符串
    return {
      role: "assistant",
      content: blocks.length === 1 && blocks[0]?.type === "text"
        ? m.content
        : blocks,
    };
  }

  if (m.role === "tool") {
    // 工具结果在 Anthropic 里是 user 消息里的 tool_result block
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: m.content,
        },
      ],
    };
  }

  // role === "system" 已在上层处理；为完整性保留
  return { role: "user", content: m.content };
}

/** 把工具翻成 Anthropic 的 tool 定义（input_schema 直接是 JSON Schema 顶层）。 */
function toAnthropicTool(tool: Tool): Anthropic.Tool {
  const schema = zodToJsonSchema(tool.schema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  delete schema["$schema"];

  return {
    name: tool.name,
    description: tool.description,
    // Anthropic SDK 要求 input_schema 至少是 { type: "object" }
    input_schema: schema as Anthropic.Tool.InputSchema,
  };
}

/** 把 Anthropic 响应翻成我们的 LLMResponse。 */
function parseAnthropicResponse(resp: Anthropic.Message): LLMResponse {
  let content = "";
  const toolCalls: ToolCall[] = [];

  for (const block of resp.content) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        // Anthropic 已经把 input 解析成对象了
        arguments: (block.input as Record<string, unknown>) ?? {},
      });
    }
    // 其它类型（thinking 等）暂时忽略
  }

  return {
    content,
    toolCalls,
    stopReason: resp.stop_reason ?? "stop",
    usage: {
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
    },
  };
}
