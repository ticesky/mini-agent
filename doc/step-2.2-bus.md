# 步骤 2.2 — MessageBus + AsyncQueue（channel ↔ runner 解耦）

> 对应 plan.md 的 Day 2 第 2 步。把"channel 直接 callback runner"改成"两个 async 队列"。

## 目标

让 channel 跟 agent runner 之间通过总线传递消息，互相不再持有对方的引用。
为后续多 channel / 多 session 场景做准备。

## 交付清单

```
src/
├── bus/
│   └── queue.ts       ≈ 50 行 — AsyncQueue<T>：单队列、close 唤醒所有 waiter
├── agent/
│   └── loop.ts        ≈ 90 行 — MessageBus + runAgentLoop（消费 inbound、产出 outbound）
├── channels/
│   └── cli.ts         改造：可接 bus，也可走老 callback 模式（兼容步骤 2.1）
└── index.ts           接线：MessageBus + runAgentLoop + channel.start()
```

## 关键设计

### 1. AsyncQueue 的最小实现

Node 没有内置异步队列。手写一个：

```ts
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: T | undefined) => void> = [];
  private closed = false;

  push(item: T) {
    if (this.closed) throw new Error("...");
    const w = this.waiters.shift();
    if (w) w(item);                    // 有 waiter 直接唤醒
    else this.items.push(item);        // 没 waiter 进 buffer
  }

  async pop(): Promise<T | undefined> {
    if (this.items.length > 0) return this.items.shift();
    if (this.closed) return undefined;
    return new Promise((r) => this.waiters.push(r));
  }

  close() {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.(undefined);
  }
}
```

三个不变式：
1. `push` 把 item 给"等得最久的"那个 waiter，FIFO
2. `pop` 在 `close()` 后能立即拿到 `undefined`，不会卡死
3. close 后再 push 抛异常，避免数据丢失静默

对应 nanobot 的 `bus/queue.py`，但它直接用了 `asyncio.Queue`（Python 标准库）。

### 2. 双队列 vs 单队列

```ts
class MessageBus {
  inbound  = new AsyncQueue<InboundMessage>();   // channel → agent
  outbound = new AsyncQueue<OutboundMessage>();  // agent → channel
}
```

为啥不用一个队列？因为 channel 和 agent 是两个独立的循环，方向相反：

```
[CLI 输入循环] ──push──> inbound ──pop──> [agent loop]
[CLI 输出消费] <──pop── outbound <──push── [agent loop]
```

如果合并成一个 bus，channel 自己 push 自己 pop 会形成消息环，需要复杂的过滤逻辑判断"这条消息归谁"。两个队列方向清晰，零歧义。

### 3. 进度事件不走 bus

ProgressEvent（流式 token、tool_start 等）**不**经过 bus，仍然由 runner 直接调 `onProgress` 回调到 channel：

```ts
runTurn({
  onProgress: (e) => channel.renderProgress?.(e),  // 直连，不过 bus
});
```

为什么？三个理由：
- **延迟**：流式输出每个 token 都过队列会引入毫秒级延迟，体验明显变卡
- **背压**：用户来不及看，token 一直堆积在队列里
- **抽象目的**：bus 是为了解耦"会话级消息"，不是"事件级信号"

nanobot 也是这样：progress hook 跟 message bus 是两条独立通路。

### 4. CLI 同时支持 bus 模式 + callback 模式

为了不破坏步骤 2.1 已经能跑的代码，`CliChannel` 加了一个**可选** `bus` 参数：

```ts
new CliChannel({ bus, streaming, onClear })  // 走 bus 模式
new CliChannel({ onClear })                   // 走 callback 模式
```

`start()` 内部根据 `this.bus` 是否存在分支：

```ts
if (this.bus) {
  this.bus.inbound.push({ sessionId: "cli", text: trimmed, source: "cli" });
  const reply = await this.bus.outbound.pop();
  // ... 渲染
} else {
  await onMessage({ ... });   // 老路径
}
```

这样上层（`index.ts`）在哪种模式下都能工作。学习项目兼容老 API 的成本很低，但能给读者展示"重构如何不破坏现有调用方"。

### 5. agent loop 的标准形态

```ts
async function runAgentLoop(opts) {
  while (true) {
    const msg = await opts.bus.inbound.pop();
    if (!msg) break;                         // 队列关闭

    const out = await opts.handleTurn(msg);
    opts.bus.outbound.push({
      sessionId: msg.sessionId,
      text: out?.text ?? "",
      target: msg.source,
      result: out?.result,
    });
  }
  opts.bus.outbound.close();                 // 收尾让 channel 退出
}
```

注意：**runAgentLoop 不直接持有 provider/registry/messages**，它只接一个 `handleTurn` 函数。这样：
- agent loop 只负责消息调度，不管会话历史
- `index.ts` 在 `handleTurn` 里捕获闭包变量（messages、registry、provider），保持职责分离

对应 nanobot：`agent/loop.py` 的 `AgentLoop` 类，结构基本一致。
