/**
 * Agent Runner —— 整个项目的心脏。
 *
 * 对应 nanobot/agent/runner.py（精简到主干，约 180 行）。
 *
 * 它做的事就一句话：
 *   循环调 LLM，遇到 tool_calls 就执行并把结果回灌，直到 LLM 不再要工具或达到上限。
 *
 * 状态机示意（一个 turn 内）：
 *
 *   [构造 messages] ──► provider.chat()
 *                             │
 *                             ▼
 *                    LLMResponse
 *                             │
 *                  ┌──────────┴──────────┐
 *                  │                     │
 *           有 toolCalls           没有 toolCalls
 *                  │                     │
 *      [并发/串行执行工具]            [结束 turn]
 *                  │                     │
 *      [把 tool 结果追加到 messages]    返回最终消息
 *                  │
 *                  └─► 回到顶端
 *
 * 关键设计点：
 *   1. 工具批次：把 toolCalls 切成"连续的只读批次"和"单个写工具批次"，
 *      只读批次用 Promise.all 并发，写工具串行。对应 nanobot _partition_tool_batches。
 *   2. 错误回填：工具异常被 registry.execute() 翻译成字符串塞回，LLM 自纠错。
 *   3. 安全上限：硬编码 maxSteps（默认 10），防止 LLM 死循环烧钱。
 *   4. progress 回调：可选，用于 CLI / WebUI 实时显示"正在调 X 工具"。
 */
import type { LLMResponse, Message, ToolCall } from "../types.ts";
import type { Provider } from "../providers/base.ts";
import type { ToolContext } from "../tools/base.ts";
import type { ToolRegistry } from "../tools/registry.ts";

/** runner 跑一次完整对话所需的全部信息。 */
export interface RunOptions {
  provider: Provider;
  registry: ToolRegistry;
  /** 完整对话历史，runner 会在原数组上 push 新消息。 */
  messages: Message[];
  /** 工具运行时上下文（workspace 等）。 */
  ctx: ToolContext;
  /** 模型名。 */
  model: string;
  /** 单次回复 token 上限。 */
  maxTokens?: number;
  /** 采样温度。 */
  temperature?: number;
  /**
   * 同一个 turn 内最多跑几步（一步 = 一次 LLM 调用 + 0~N 个工具）。
   * 超过就强制结束。默认 10。
   */
  maxSteps?: number;
  /**
   * 是否流式调 LLM。流式下，runner 会调 provider.chatStream 而非 chat，
   * 文本/工具调用增量会通过 onProgress 的 'llm_text' / 'llm_tool_args' 事件传出。
   * 默认 false（保持原有行为）。
   */
  stream?: boolean;
  /**
   * 进度回调。runner 在关键节点调用它（开始一步、调工具、工具完成、turn 结束）。
   * 上层（CLI）拿到事件后做实时展示。
   */
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
}

/** runner 一次 run 的结果。 */
export interface RunResult {
  /** 最后一次 LLM 响应（拿它的 content 当作"最终回复"）。 */
  final: LLMResponse;
  /** 实际执行了多少步。 */
  steps: number;
  /** 是否是因为达到 maxSteps 才退出（true 表示被截断）。 */
  truncated: boolean;
}

/** runner 在执行过程中向上抛的事件。 */
export type ProgressEvent =
  | { type: "step_start"; step: number }
  | { type: "assistant_text"; text: string }
  /** 流式：文本增量到达。流式模式下逐字触发，非流式不触发。 */
  | { type: "llm_text_delta"; delta: string }
  /** 流式：某工具调用开始（参数还没到齐）。 */
  | { type: "llm_tool_call_start"; id: string; name: string }
  /** 流式：工具调用 JSON 参数增量。 */
  | { type: "llm_tool_call_args"; id: string; deltaJson: string }
  | { type: "tool_start"; toolCall: ToolCall }
  | { type: "tool_end"; toolCall: ToolCall; result: string }
  | { type: "step_end"; step: number; response: LLMResponse }
  | { type: "done"; result: RunResult };

/**
 * 跑一次完整 turn：从用户最新消息开始，一直到 LLM 不再要工具。
 *
 * 注意：调用方负责往 messages 里 push 用户的最新输入；本函数只追加 assistant / tool 消息。
 */
export async function runTurn(opts: RunOptions): Promise<RunResult> {
  const maxSteps = opts.maxSteps ?? 10;
  const tools = opts.registry.getAll();

  let lastResponse: LLMResponse = {
    content: "",
    toolCalls: [],
    stopReason: "stop",
  };

  for (let step = 1; step <= maxSteps; step++) {
    await opts.onProgress?.({ type: "step_start", step });

    // ── 1. 调 LLM（流式或非流式）─────────────────────────────────
    const chatOpts = {
      messages: opts.messages,
      tools,
      model: opts.model,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };

    if (opts.stream) {
      lastResponse = await opts.provider.chatStream(chatOpts, async (ev) => {
        // 把 provider 的 StreamEvent 转成 runner 的 ProgressEvent
        switch (ev.type) {
          case "text":
            await opts.onProgress?.({ type: "llm_text_delta", delta: ev.delta });
            break;
          case "tool_call_start":
            await opts.onProgress?.({
              type: "llm_tool_call_start",
              id: ev.id,
              name: ev.name,
            });
            break;
          case "tool_call_args":
            await opts.onProgress?.({
              type: "llm_tool_call_args",
              id: ev.id,
              deltaJson: ev.deltaJson,
            });
            break;
          // 'done' 事件在 chatStream 返回后由 runner 自己继续推动，无需上抛
          case "done":
            break;
        }
      });
    } else {
      lastResponse = await opts.provider.chat(chatOpts);
    }

    // provider 报错就直接结束 turn（runner 不做重试，留给上层）
    if (lastResponse.error) {
      await opts.onProgress?.({ type: "step_end", step, response: lastResponse });
      const result = { final: lastResponse, steps: step, truncated: false };
      await opts.onProgress?.({ type: "done", result });
      return result;
    }

    // ── 2. 把 assistant 这一轮的输出记入历史 ───────────────────────
    const assistantMsg: Message = {
      role: "assistant",
      content: lastResponse.content,
      ...(lastResponse.toolCalls.length > 0
        ? { toolCalls: lastResponse.toolCalls }
        : {}),
    };
    opts.messages.push(assistantMsg);

    if (lastResponse.content) {
      // 流式下文本已经通过 llm_text_delta 一字字打出来了，
      // 这里就不再触发 assistant_text 防止重复显示。
      if (!opts.stream) {
        await opts.onProgress?.({
          type: "assistant_text",
          text: lastResponse.content,
        });
      }
    }

    // ── 3. 没有 toolCalls 就结束 turn ──────────────────────────────
    if (lastResponse.toolCalls.length === 0) {
      await opts.onProgress?.({ type: "step_end", step, response: lastResponse });
      const result = { final: lastResponse, steps: step, truncated: false };
      await opts.onProgress?.({ type: "done", result });
      return result;
    }

    // ── 4. 执行工具，把结果追加到 messages ─────────────────────────
    const results = await executeBatched(
      lastResponse.toolCalls,
      opts.registry,
      opts.ctx,
      opts.onProgress,
    );

    for (const { call, result } of results) {
      opts.messages.push({
        role: "tool",
        content: result,
        toolCallId: call.id,
        name: call.name,
      });
    }

    await opts.onProgress?.({ type: "step_end", step, response: lastResponse });
    // 然后回到顶端继续下一步
  }

  // 跑到这里 = 达到 maxSteps 上限
  const result = { final: lastResponse, steps: maxSteps, truncated: true };
  await opts.onProgress?.({ type: "done", result });
  return result;
}

/**
 * 把 toolCalls 按"只读批次 / 单个写工具"切片，分批执行。
 *
 * 比如 LLM 一次同时要 3 个 read_file + 1 个 write_file + 2 个 read_file，
 * 会切成：[read,read,read] → [write] → [read,read]，
 * 每个只读批次内部并发，写批次单独跑。
 *
 * 顺序保留：返回的 results 数组顺序和入参 toolCalls 一一对应。
 */
async function executeBatched(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  onProgress: RunOptions["onProgress"],
): Promise<{ call: ToolCall; result: string }[]> {
  // 标记每个 call 是否只读
  const flags = toolCalls.map((c) => registry.get(c.name)?.readOnly ?? false);
  const out: { call: ToolCall; result: string }[] = new Array(toolCalls.length);

  let i = 0;
  while (i < toolCalls.length) {
    if (flags[i]) {
      // 收集连续的只读批次
      let j = i;
      while (j < toolCalls.length && flags[j]) j++;
      const batch = toolCalls.slice(i, j);
      const batchResults = await Promise.all(
        batch.map((call) => runOne(call, registry, ctx, onProgress)),
      );
      for (let k = 0; k < batch.length; k++) {
        out[i + k] = batchResults[k]!;
      }
      i = j;
    } else {
      // 写工具：单独串行跑
      out[i] = await runOne(toolCalls[i]!, registry, ctx, onProgress);
      i++;
    }
  }

  return out;
}

async function runOne(
  call: ToolCall,
  registry: ToolRegistry,
  ctx: ToolContext,
  onProgress: RunOptions["onProgress"],
): Promise<{ call: ToolCall; result: string }> {
  await onProgress?.({ type: "tool_start", toolCall: call });
  const result = await registry.execute(call.name, call.arguments, ctx);
  await onProgress?.({ type: "tool_end", toolCall: call, result });
  return { call, result };
}
