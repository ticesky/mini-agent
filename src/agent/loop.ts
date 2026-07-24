/**
 * 消息总线 + agent loop 调度器。
 *
 * 对应 nanobot/agent/loop.py + nanobot/bus/queue.py。
 *
 * 设计：
 *   - 两个队列：inbound（用户输入）/ outbound（agent 回复）
 *   - channel 只跟 bus 打交道：push 到 inbound、从 outbound 消费
 *   - agent loop 也只跟 bus 打交道：从 inbound pop、push 到 outbound
 *   - 进度事件不走 bus：保持低延迟，直接由 agent loop 调 onProgress 回调
 *     （跟 nanobot 一致——nanobot 的 progress 也是走 hook 系统而非 message bus）
 *
 * 这是整个项目"channel ↔ agent 解耦"的核心：
 *   未来加 Slack/Telegram channel 时，channel 不必感知 agent runner 的存在，
 *   agent loop 也不必知道当前消息从哪个 channel 来。
 */
import { AsyncQueue } from "../bus/queue.ts";
import type { ProgressEvent, RunResult } from "./runner.ts";

/** channel 推进 bus 的入站消息。 */
export interface InboundMessage {
  /** 会话 id：决定用哪一组对话历史。 */
  sessionId: string;
  /** 用户输入的文本。 */
  text: string;
  /** 来源 channel 名字（仅用于日志/路由）。 */
  source: string;
}

/** agent loop 推进 bus 的出站消息（一次 turn 的最终回复）。 */
export interface OutboundMessage {
  sessionId: string;
  text: string;
  /** 目标 channel 名字（默认就是消息来源）。 */
  target: string;
  /** 关联的 RunResult，channel 可以用它显示 token 用量等。 */
  result?: RunResult;
}

/** 消息总线：两个独立队列。 */
export class MessageBus {
  readonly inbound = new AsyncQueue<InboundMessage>();
  readonly outbound = new AsyncQueue<OutboundMessage>();

  close(): void {
    this.inbound.close();
    this.outbound.close();
  }
}

/** Agent loop 一次完整跑动需要的所有零件。 */
export interface AgentLoopOptions {
  bus: MessageBus;
  /**
   * 给定一个 InboundMessage，跑完一个 turn 并返回最终输出文本（可空表示无回复）。
   * 实现里通常是：往 sessionId 对应的 messages 里 push、调 runTurn、返回 final.content。
   */
  handleTurn: (msg: InboundMessage) => Promise<{ text: string; result: RunResult } | null>;
  /** 进度事件回调，agent loop 不消费，只是给上层订阅 channel 用。 */
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
}

/**
 * 启动 agent loop：阻塞式从 bus.inbound 消费消息，处理后 push 到 bus.outbound。
 * 在 bus.inbound 关闭后退出。
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  while (true) {
    const msg = await opts.bus.inbound.pop();
    if (!msg) break; // 队列关闭

    try {
      const out = await opts.handleTurn(msg);
      if (out) {
        opts.bus.outbound.push({
          sessionId: msg.sessionId,
          text: out.text,
          target: msg.source,
          result: out.result,
        });
      } else {
        // 无文本回复（例如 LLM 报错且 final.content 为空），仍 push 一个空消息让 channel 解锁
        opts.bus.outbound.push({
          sessionId: msg.sessionId,
          text: "",
          target: msg.source,
        });
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      opts.bus.outbound.push({
        sessionId: msg.sessionId,
        text: `[runner error] ${err}`,
        target: msg.source,
      });
    }
  }

  // inbound 关闭后，把 outbound 也收尾，让 channel 的消费循环退出
  opts.bus.outbound.close();
}
