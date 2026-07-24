# 00 — 设计原则："核心精简，边缘扩展"

> 来源：`nanobot/.agent/design.md` 读后总结。
>
> 这是 nanobot 整个项目的脊梁。**它说起来漂亮，做起来反直觉**——读源码时会反复撞到它。

## 核心原则

> **核心保持精简；在边缘扩展，用最少的改动解决真实的问题。**

## 在 nanobot 里的具体体现

### 1. Tool 接口几十年不变

```
agent/tools/base.py  ── 296 行，几乎没动过
agent/tools/         ── 20+ 个文件，自由增删
```

**核心（接口）冻结，扩展（实现）开放。**

mini-agent 也在走同一条路：5 个工具都 implements 同一个 `Tool` interface。以后加 webFetch / applyPatch 时**不需要改 base.ts**——这就是核心精简的实际收益。

### 2. Provider 只规定 chat() 一个抽象方法

```python
# providers/base.py
class BaseLLMProvider:
    abstract chat(...)
    abstract chat_stream(...)
    # 完了，没有别的抽象方法
```

但 `openai_compat_provider.py` 具体实现可以 1500 行。**抽象不为实现妥协**。

反例是 LangChain：base 里塞了一堆 method（`with_retry` / `with_fallback` / `with_config` / `bind_tools`），每个 provider 必须实现/绕过几十个方法 → 核心臃肿，扩展沉重。

### 3. Hook 系统替代 if/else

不好的写法（核心被污染）：

```python
async def run_turn(self, ...):
    if self.config.enable_progress: ...
    if self.config.workspace_violation_check: ...
    if self.config.fail_on_tool_error: ...
```

nanobot 实际做法（`agent/hook.py`）：

```python
async def run_turn(self, ...):
    for hook in self.hooks:
        await hook.before_turn(ctx)
    # 核心逻辑（30 行）
    for hook in self.hooks:
        await hook.after_turn(ctx)
```

新功能 = 新 hook 类挂上去，**runner.py 这条主线一行不改**。

> **`runner.py` 1570 行里真正的状态机就 ~30 行**——其他 1500 行都是 hook、错误分类、流式增量、跟踪等"边缘"代码。
> 主线和边缘**物理隔离**：你能一眼定位"这是核心吗？"。

### 4. Channel 通过 entry_points 插件化

```toml
[project.entry-points."nanobot.channels"]
telegram = "nanobot.channels.telegram:TelegramChannel"
slack    = "nanobot.channels.slack:SlackChannel"
```

加新 channel 不用 patch nanobot 主代码——做成独立 pip 包，注册 entry_point 就被自动发现。

## 这条原则反直觉在哪

新手最容易犯的错：**因为可能需要，所以提前抽象**。

```ts
// 反例：还没有第二个 channel 时就开始抽象
abstract class BaseChannel {
  abstract authenticate(): Promise<void>;
  abstract sendMessage(...): Promise<void>;
  abstract handleEdit(...): Promise<void>;     // 万一以后要支持编辑呢？
  abstract handleReact(...): Promise<void>;     // 万一以后要支持表情呢？
  abstract handleVoice(...): Promise<void>;    // 万一以后要支持语音呢？
}
```

结果：每加一个 channel 都要实现 / mock 一堆**根本用不到**的方法。**核心臃肿，扩展沉重**。

正确做法（nanobot 走的路）：

1. **先做一个具体实现**（CLI 或 WebSocket）
2. **再做第二个**（Telegram）
3. **从两个里抽公共部分** → Channel interface 自然浮现
4. 第三个、第四个加进来时，interface 又长出新方法——但都是**真正普遍需要**的

## mini-agent 的对照

mini-agent 现在的状态：CLI 是唯一 channel，但仍写了 `Channel` interface。**为什么这不算过早抽象？**

因为 Channel 接口只有 3 个方法（`start` / `send` / `renderProgress`），都是真实需要的，且未来加新 channel 不会让这 3 个方法变形。

## 给读 nanobot 的检查清单

带着这条原则读，每个文件问自己：

1. **这是核心还是边缘？**（看它在 import graph 的位置）
2. **如果这个文件不存在，主线能不能跑？**（能 = 边缘；不能 = 核心）
3. **它解决的是真实问题还是想象问题？**（grep 看哪些地方用、看 git log 看为啥加）

## 项目目录里的物理分层

```
nanobot/
├── agent/runner.py         ← 核心：不能动
├── agent/loop.py           ← 核心：不能动
├── agent/tools/base.py     ← 核心：抽象
├── agent/tools/*.py        ← 边缘：可自由增删
├── agent/hook.py           ← 核心：扩展点
├── channels/base.py        ← 核心：抽象
├── channels/{slack,...}.py ← 边缘：可自由增删
├── providers/base.py       ← 核心：抽象
└── providers/{anthropic,...}.py ← 边缘：可自由增删
```

**`base.py` = 核心，其他 = 边缘。**

## mini-agent 反思

回头看 mini-agent，找出可能违反"核心精简"的地方：

- `runner.ts` 里的 `executeBatched` —— 是核心还是边缘？放对位置了吗？
- `cli.ts` 里关于流式状态的 `streamingToolCallIds` —— 这块逻辑是不是不该污染 channel？

不需要现在改。**意识到比改了更重要**——下次设计新模块时会自动避开这些坑。
