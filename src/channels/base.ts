/**
 * Channel 抽象 —— 把"消息从哪来、回哪去"这件事统一建模。
 *
 * 对应 nanobot/channels/base.py（极简版）。
 *
 * MVP 第一版只有 CLI 一个 channel，但仍写出抽象，理由：
 *   1. 步骤 2.2 加 MessageBus 时需要"channel ↔ runner 解耦"
 *   2. 暴露给读者一个清晰的扩展点：日后想加 Slack/Telegram 直接实现这个接口
 *
 * 设计上和 nanobot 的差异：
 *   - 不区分 InboundMessage / OutboundMessage 两个类，统一用 ChannelMessage
 *   - channel 自己负责把"用户输入"转 ChannelMessage、把"agent 回复"显示出去
 */

import type { ProgressEvent, RunResult } from "../agent/runner.ts";

/** 一条进出 channel 的消息。 */
export interface ChannelMessage {
  /** 谁发的。'user' 是终端用户，'agent' 是助手回复。 */
  role: "user" | "agent";
  /** 文本正文。 */
  text: string;
  /** 会话 id：哪一组对话历史。CLI 默认只有一个，但保留字段为后续多 channel 准备。 */
  sessionId: string;
}

/**
 * Channel 接口。
 * 一个 channel 负责：
 *   - 启动监听（start）
 *   - 把入站消息交给 onMessage 回调
 *   - 把出站消息显示出去（send）
 *   - 把 runner 进度事件渲染出去（renderProgress，可选）
 */
export interface Channel {
  /** Channel 名字，仅用于日志。 */
  readonly name: string;

  /**
   * 启动 channel。注册 onMessage 回调，channel 拿到用户输入后调用它。
   * 返回的 Promise 在 channel 关闭（如用户按 Ctrl-D）时 resolve。
   */
  start(onMessage: (msg: ChannelMessage) => Promise<void>): Promise<void>;

  /** 把 agent 回复发送到 channel（CLI 就是 println）。 */
  send(msg: ChannelMessage): Promise<void> | void;

  /** 渲染 runner 进度事件（可选；CLI 用它显示"正在调 X 工具"）。 */
  renderProgress?(event: ProgressEvent): void;

  /** turn 结束时的回调（可选）。CLI 用它打印 token 用量。 */
  onTurnEnd?(result: RunResult): void;

  /** 关闭 channel。 */
  close?(): Promise<void> | void;
}
