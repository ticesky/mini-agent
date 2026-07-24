/**
 * CLI channel —— 用 readline 在终端跟 agent 对话。
 *
 * 没有对应的 nanobot 文件（nanobot 的 CLI 走的是 prompt-toolkit + 复杂 TUI）。
 * 我们的 CLI 就是最朴素的："> " 提示符 + readline + 颜色化的工具调用打印。
 *
 * 行为约定：
 *   - 输入 "/exit" 或 Ctrl-D 退出
 *   - 输入 "/clear" 清空对话历史
 *   - 其余输入都作为用户消息丢给 onMessage
 */
import { stdin, stdout } from "node:process";
import * as readline from "node:readline/promises";
import type { ProgressEvent, RunResult } from "../agent/runner.ts";
import type { MessageBus } from "../agent/loop.ts";
import { getTodos, type Todo } from "../tools/todoWrite.ts";
import type { Channel, ChannelMessage } from "./base.ts";

// 极简 ANSI 颜色，避免再装一个 chalk
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export interface CliChannelOptions {
  /** 提示符。默认 "> "。 */
  prompt?: string;
  /** 用户清空历史时调用。可以是异步的（持久化时需要 flush）。 */
  onClear?: () => void | Promise<void>;
  /**
   * 可选：bus 模式。提供 bus 后，CLI 会把用户输入 push 到 inbound，
   * 同时启动一个后台循环消费 outbound 显示 agent 回复。
   * 不提供则走 callback 模式（兼容步骤 2.1 的用法）。
   */
  bus?: MessageBus;
  /** 是否流式模式。bus 模式下用它决定是否要在 outbound 时打文本（流式下已逐字打过）。 */
  streaming?: boolean;
}

export class CliChannel implements Channel {
  readonly name = "cli";
  private rl: readline.Interface | null = null;
  private readonly prompt: string;
  private readonly onClear: (() => void | Promise<void>) | undefined;
  private readonly bus: MessageBus | undefined;
  private readonly streaming: boolean;
  /** 流式模式下，记录已通过 llm_tool_call_start 打开过括号的 tool_call id。 */
  private streamingToolCallIds = new Set<string>();

  constructor(opts: CliChannelOptions = {}) {
    this.prompt = opts.prompt ?? c.bold("> ");
    this.onClear = opts.onClear;
    this.bus = opts.bus;
    this.streaming = opts.streaming ?? false;
  }

  async start(onMessage: (msg: ChannelMessage) => Promise<void>): Promise<void> {
    this.rl = readline.createInterface({ input: stdin, output: stdout });

    stdout.write(
      c.dim(
        "mini-agent CLI — 输入 /exit 退出，/clear 清空历史，Ctrl-D 也可退出。\n",
      ),
    );

    while (true) {
      let line: string;
      try {
        line = await this.rl.question(this.prompt);
      } catch {
        // Ctrl-D / Ctrl-C：rl.question 在关闭时会 reject
        break;
      }

      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (trimmed === "/exit" || trimmed === "/quit") break;
      if (trimmed === "/clear") {
        await this.onClear?.();
        stdout.write(c.dim("[历史已清空]\n"));
        continue;
      }

      if (this.bus) {
        // bus 模式：把消息 push 到 inbound，等当前轮的 outbound 回复
        this.bus.inbound.push({
          sessionId: "cli",
          text: trimmed,
          source: "cli",
        });
        const reply = await this.bus.outbound.pop();
        // 流式下文本已逐字打过；非流式下还需要打整段。
        // 通过 reply.result.final 的 stopReason 不能区分模式，简单按"是否已流式打过"
        // 的 streamingToolCallIds 状态来判断：流式至少打过一段文本（即使没工具调用）。
        // 这里更简单：看 result 是否存在以及有没有 onTurnEnd 信号——直接区分模式由
        // index.ts 通过 channel.streaming 标记会更干净，但 MVP 不那么折腾。
        // 折中方案：bus.outbound 的 text 是 final.content，
        //   - 流式：CLI 已经 token-by-token 打过 → 我们打一个换行就好
        //   - 非流式：CLI 没打过 → 我们打整段
        // 用 channel.streaming 字段告诉 CLI 当前是哪种模式。
        if (this.streaming) {
          stdout.write("\n");
        } else if (reply && reply.text) {
          stdout.write(`\n${reply.text}\n`);
        }
        if (reply?.result) {
          this.onTurnEnd(reply.result);
        }
      } else {
        await onMessage({ role: "user", text: trimmed, sessionId: "cli" });
      }
    }

    this.rl.close();
    this.rl = null;

    // bus 模式下关闭队列，让 agent loop 的 while 退出
    if (this.bus) {
      this.bus.close();
    }
  }

  send(msg: ChannelMessage): void {
    if (msg.role === "agent") {
      // 流式下文本已经被 llm_text_delta 一字字打出来了，这里只补一个换行
      stdout.write("\n");
    }
  }

  /** 非流式模式下用，runTurn 完成后一次性打出 agent 回复。 */
  sendBlocking(msg: ChannelMessage): void {
    if (msg.role === "agent") {
      stdout.write(`\n${msg.text}\n\n`);
    }
  }

  /** 把 runner 的进度事件染色后打印出来。 */
  renderProgress(event: ProgressEvent): void {
    switch (event.type) {
      case "llm_text_delta": {
        // 流式：每个 token 立刻打到屏幕上（默认色）
        stdout.write(event.delta);
        break;
      }
      case "llm_tool_call_start": {
        // 文本结束后换行，再打工具调用提示
        stdout.write(`\n${c.cyan(`  ⚙ ${event.name}(`)}`);
        this.streamingToolCallIds.add(event.id);
        break;
      }
      case "llm_tool_call_args": {
        // 参数 JSON 增量染成青色，逐字显示
        stdout.write(c.cyan(event.deltaJson));
        break;
      }
      case "tool_start": {
        // 如果流式时已经打开过这个工具调用，只需补 ")"
        // 否则（非流式）打完整提示行
        if (this.streamingToolCallIds.has(event.toolCall.id)) {
          stdout.write(c.cyan(")\n"));
        } else {
          const args = compactJson(event.toolCall.arguments);
          stdout.write(c.cyan(`  ⚙ ${event.toolCall.name}(${args})\n`));
        }
        break;
      }
      case "tool_end": {
        // TodoWrite 单独处理：把 ↳ 一行预览换成整张彩色清单
        if (event.toolCall.name === "TodoWrite") {
          this.renderTodoList(getTodos());
          break;
        }
        // 把工具结果首行打出来，超长截断
        const firstLine = event.result.split("\n")[0] ?? "";
        const preview =
          firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
        stdout.write(c.dim(`    ↳ ${preview}\n`));
        break;
      }
      case "step_start": {
        // 第一步前不需要换行；后续每步开始前打一道空行分隔
        if (event.step > 1) stdout.write("\n");
        break;
      }
      // assistant_text / step_end / done 不在这里展示
      default:
        break;
    }
  }

  onTurnEnd(result: RunResult): void {
    // 一轮结束后清掉流式状态
    this.streamingToolCallIds.clear();
    const usage = result.final.usage;
    const parts: string[] = [`steps=${result.steps}`];
    if (result.truncated) parts.push(c.yellow("truncated"));
    if (usage) parts.push(`in=${usage.inputTokens} out=${usage.outputTokens}`);
    if (result.final.error) parts.push(c.red(`error: ${result.final.error.message}`));
    stdout.write(c.dim(`[${parts.join(" ")}]\n`));
  }

  async close(): Promise<void> {
    this.rl?.close();
  }

  /**
   * 把当前 todolist 用色块画在终端：
   *   ✓ 已完成（绿）
   *   ▸ 进行中（黄）
   *   ○ 待办  （灰）
   */
  private renderTodoList(todos: readonly Todo[]): void {
    if (todos.length === 0) {
      stdout.write(c.dim("    ↳ (empty)\n"));
      return;
    }
    for (const t of todos) {
      const [icon, color] =
        t.status === "completed"
          ? ["✓", c.green]
          : t.status === "in_progress"
          ? ["▸", c.yellow]
          : ["○", c.dim];
      const text =
        t.status === "completed"
          ? c.dim(t.content)         // 完成的灰一点，视觉上"划掉"
          : t.status === "in_progress"
          ? c.bold(t.content)        // 进行中的加粗
          : t.content;
      stdout.write(`    ${color(icon)} ${text}\n`);
    }
  }
}

/** 把 args 对象压成单行 JSON，太长的字段截断显示。 */
function compactJson(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).map(([k, v]) => {
    let s = JSON.stringify(v);
    if (s !== undefined && s.length > 60) s = s.slice(0, 60) + "…\"";
    return `${k}=${s}`;
  });
  return entries.join(", ");
}
