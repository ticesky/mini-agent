# 06 — `agent/hook.py`：扩展点设计

> 187 行，nanobot **"核心精简，边缘扩展"原则的标志性实现**。
>
> 它本身是核心（提供扩展点），但服务于边缘（让加新关注点不污染主流程）。

## Python 语法速通：3 个关键概念

读 hook.py 之前先扫这一节。

### 1. `class CompositeHook(AgentHook):` 是什么

```python
class CompositeHook(AgentHook):
    ...
```

**= TypeScript 的 `class CompositeHook extends AgentHook { ... }`**。

括号里是父类。Python 用 `()` 表达继承，TS 用 `extends`。

多继承用 `class Foo(A, B, C):`——TS 没有，但 nanobot 几乎不用，看见单括号就当 `extends` 读。

### 2. `AgentHook` 这种"基类带空实现"

```python
class AgentHook:
    """Base class for hooks."""
    async def before_turn(self, ctx): pass
    async def after_turn(self, ctx): pass
    async def before_tool(self, ctx, tc): pass
    async def after_tool(self, ctx, tc, result): pass
```

每个方法 `pass` = 默认啥都不做的空实现。

→ 这是 Python 的**模板方法模式**：基类定义所有钩子点 + 空实现，子类**只重写自己关心的方法**，不必每次都写 7 个空函数。

如果用真正的 abstract method（`@abstractmethod`），子类必须实现所有方法——太重。空 `pass` 风格更轻。

### 3. `async def` + `await`

```python
async def before_turn(self, ctx):
    for h in self._hooks:
        await h.before_turn(ctx)
```

跟 TS 的 `async / await` **完全一样**，连关键字都一样。

### Python ↔ TypeScript 速查

| Python | TypeScript |
|---|---|
| `class Foo(Bar):` | `class Foo extends Bar {` |
| `def foo(self, x):` | `foo(x) {` |
| `async def foo(self, x):` | `async foo(x) {` |
| `pass` | `{}` 空 body |
| `self` | `this` |
| `__init__` | `constructor` |
| `super().__init__(...)` | `super(...)` |
| `@classmethod` | `static` |
| `@property` | `get foo() {` |

会这十个，nanobot 90% 的代码都能读懂。

## CompositeHook —— 把多个 hook 串成一个

```python
class CompositeHook(AgentHook):
    def __init__(self, hooks: list[AgentHook]):
        self._hooks = hooks

    async def before_turn(self, ctx):
        for h in self._hooks:
            await h.before_turn(ctx)

    async def after_turn(self, ctx):
        # 注意是反向遍历：先注册的最后被通知
        for h in reversed(self._hooks):
            await h.after_turn(ctx)

    # ... 每个钩子点都这样转发
```

**经典 Composite 设计模式**：把"多个对象"伪装成"一个对象"。

调用方拿到 `CompositeHook` 后**完全不用知道内部有几个 hook**：

```python
self.hook = CompositeHook([
    LoggingHook(),
    ProgressHook(),
    BillingHook(),
])

# 然后只需要：
await self.hook.before_turn(ctx)   # 自动通知所有 3 个
```

### before / after 的方向是 LIFO

```
注册顺序：    [Logging, Progress, Billing]
before:        Logging  → Progress  → Billing
执行核心
after:         Billing  → Progress  → Logging
```

为什么 after 要反向？想象 `BillingHook.before` 计了一笔时间戳，`BillingHook.after` 算总耗时。如果中间某个 hook 出错了，**栈式撤销**保证最先建立的状态最后被销毁——跟 `try/finally` 嵌套是一回事。

→ 一行 `reversed()`，**很容易忽略但一旦没做就出 bug 的细节**。

## AgentProgressHook —— 一个具体实现

```python
class AgentProgressHook(AgentHook):
    def __init__(self, bus: MessageBus):
        self.bus = bus

    async def before_turn(self, ctx):
        # 把"开始一轮"的事件推到 bus
        await self.bus.publish_progress(...)

    async def before_tool(self, ctx, tool_call):
        # 把"开始调工具"的事件推到 bus
        await self.bus.publish_progress(...)

    async def after_tool(self, ctx, tool_call, result):
        # ...
```

**职责单一**：只把进度事件推到 bus，让 channel 去渲染。
其他职责（日志、计费、错误统计）不是它的事。

→ 每个关注点一个 hook 类，**加新功能不污染主流程**。

## 为什么 hook 系统是"核心精简"的标志

反例（不好的写法）：

```python
async def run_turn(self, ...):
    if self.config.enable_progress: ...
    if self.config.enable_logging: ...
    if self.config.enable_billing: ...
```

每加一个新关注点，**runner.py 这个核心文件就被改一次**。改一次意味着：
- 多一种代码路径需要测试
- 多一种 bug 风险
- 多一处影响 prompt cache 的地方

hook 系统的真正价值：**让"加新关注点"不需要碰核心文件**。

```python
async def run_turn(self, ...):
    await self.hook.before_turn(ctx)   # 这一行不变
    # 核心逻辑（30 行）
    await self.hook.after_turn(ctx)    # 这一行也不变
```

加新关注点只加一个新文件 `BillingHook(AgentHook)`，注册到 CompositeHook 里就行。**runner.py 不动一行。**

## hook 系统的"核心 vs 边缘"判断

| 问题 | 答案 |
|---|---|
| 这是核心还是边缘？ | **核心**（提供扩展点） |
| 它解决的是真实问题还是想象问题？ | 真实——每加一个关注点都不污染 runner |
| 它能不能不存在？ | 能，但每个关注点都要 if/else 进 runner |

→ **hook 是"为了让边缘扩展不污染核心"而存在的核心机制**。它本身是核心，但服务于边缘。

这就是为什么 `agent/hook.py` 只有 187 行（**核心代码总是短的**），而 `agent/runner.py` 有 1500 行（一旦没用 hook，每个关注点都堆在主流程里了）。

## 跟 mini-agent 的对照

mini-agent 的 `ProgressEvent` union + `onProgress` callback **本质上就是个超极简版的 hook 系统**：

```ts
// mini-agent runner.ts
type ProgressEvent =
  | { type: "step_start"; ... }
  | { type: "tool_start"; ... }
  | ...;

runTurn({
  onProgress: (e) => channel.renderProgress?.(e),
});
```

对比 nanobot：

| 维度 | mini-agent | nanobot |
|---|---|---|
| 数据形态 | discriminated union | 多个虚方法 |
| 注册方式 | 一个 callback | 多个 hook 实例 |
| 多消费者 | 调用方自己包一个 callback 转发 | CompositeHook 自动 |
| 加新事件类型 | union 加一项 + 各处 switch case | 基类加一个虚方法 |
| 加新关注点 | 改 callback | 加一个 hook 类 |
| 顺序保证 | 由调用方控 | LIFO 反向 after |

→ **本质相同，规模不同**。mini-agent 的简版在 1 个 callback 时最简洁；nanobot 的 hook 系统在多关注点时更优雅。

## mini-agent 要不要加 hook 系统？

按"何时该抽抽象"原则反推：

**现在不需要**——mini-agent 只有一个进度上报关注点（CLI 渲染），用一个 callback 就够。

**何时该加**：
- 加第二个独立关注点（比如：日志写文件 + 屏幕渲染同时要）
- 想把"自动重试"做成可插拔（hook 拦截 LLM 调用）
- 想做"调用计费/统计"

最小可行抽象（不要直接照抄 nanobot）：

```ts
// 先这样
type ProgressHandler = (e: ProgressEvent) => void | Promise<void>;

class CompositeProgress {
  constructor(private handlers: ProgressHandler[]) {}
  async fire(e: ProgressEvent) {
    for (const h of this.handlers) await h(e);
  }
}
```

7 行实现 CompositeHook 的核心。
**等真有了 5 个 hook 类需要 lifecycle 钩子（before/after），再扩展成 nanobot 的形态。**

→ "用最少的改动解决真实问题"的实践方式。

## 阅读练习

回去看 hook.py，回答 3 个问题：

1. **AgentHook 的所有虚方法** —— 数一下有几个钩子点（before_turn / before_tool / ...）
2. **CompositeHook 中哪些方法用 `reversed()`** —— 哪些是 LIFO 哪些是 FIFO
3. **AgentProgressHook 实际重写了 AgentHook 的几个方法** —— 它只关心哪些钩子点

3 个问题答完，hook.py 就完全读透了。
