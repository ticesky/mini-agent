/**
 * 异步队列：单生产者 / 单消费者风格的 FIFO，配合 Node event loop 用。
 *
 * 对应 nanobot/bus/queue.py 里的内部队列实现（Python 用 asyncio.Queue 现成的，
 * Node 没原生异步队列，我们手撸一个最小版）。
 *
 * 行为约定：
 *   - push() 同步：要么唤醒一个等待者，要么进 buffer
 *   - pop() 异步：buffer 有就立刻拿，没有就挂着等 push
 *   - close() 后所有 waiter 立即 resolve(undefined)，新 pop 也直接拿到 undefined
 *   - 关闭后再 push 会抛异常（"队列已关闭"）
 *
 * 简化点（vs nanobot）：
 *   - 不做容量上限（Node 内存够用，agent 场景消息量小）
 *   - 不做优先级（不需要）
 *   - 不分 multi-consumer（MVP 第一版只有一个 agent loop 在消费）
 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: T | undefined) => void> = [];
  private closed = false;

  /** 入队。被等待者立即拿走，否则进 buffer。 */
  push(item: T): void {
    if (this.closed) throw new Error("AsyncQueue: 队列已关闭，无法 push");
    const w = this.waiters.shift();
    if (w) w(item);
    else this.items.push(item);
  }

  /**
   * 出队。buffer 有就立刻返回；没有就挂起等 push 或 close。
   * 队列关闭且 buffer 空时返回 undefined（消费者据此退出循环）。
   */
  async pop(): Promise<T | undefined> {
    if (this.items.length > 0) return this.items.shift();
    if (this.closed) return undefined;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** 关闭队列：所有等待者收到 undefined，新 push 抛错。 */
  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(undefined);
    }
  }

  /** 当前 buffer 中的项数。 */
  get size(): number {
    return this.items.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
