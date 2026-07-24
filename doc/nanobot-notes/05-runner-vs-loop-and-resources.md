# 05 — `runner.py` vs `loop.py`：职责切分 + 资源归属

> nanobot 把 mini-agent 的 `runner` + `loop` 切法**完全打散重组**了。
> 这一篇把"为什么这么切"、"记忆压缩到底在哪"、"subagent 怎么织进来"、"MCP 启动为什么在 loop.py" 一并讲清。

## 一张总图：mini-agent vs nanobot 的同构关系

```
mini-agent:                              nanobot:
┌────────────────────────┐               ┌────────────────────────────────┐
│   AgentLoop.run        │               │   AgentLoop.run                │
│  ┌──────────────────┐  │               │  ┌──────────────────────────┐  │
│  │  handleTurn      │  │               │  │  _dispatch / TurnContext │  │
│  │  ┌────────────┐  │  │               │  │   _state_restore         │  │
│  │  │ runTurn    │  │  │               │  │   _state_compact         │  │
│  │  │ for step:  │  │  │               │  │   _state_command         │  │
│  │  │   chat()   │  │  │               │  │   _state_build           │  │
│  │  │   exec()   │  │  │               │  │   ┌──────────────────┐   │  │
│  │  └────────────┘  │  │               │  │   │ _state_run       │   │  │
│  └──────────────────┘  │               │  │   │ AgentRunner.run  │   │  │
└────────────────────────┘               │  │   │ for iter:        │   │  │
                                         │  │   │   _request_model │   │  │
                                         │  │   │   _execute_tools │   │  │
                                         │  │   └──────────────────┘   │  │
                                         │  │   _state_save            │  │
                                         │  │   _state_respond         │  │
                                         │  └──────────────────────────┘  │
                                         └────────────────────────────────┘
```

→ 同构关系：
- mini-agent `loop.ts.runAgentLoop` ≈ nanobot `loop.py.run`（最外层循环）
- mini-agent `index.ts.handleTurn` ≈ nanobot `loop.py._dispatch + 7 个 _state_*`（单消息处理）
- mini-agent `runner.ts.runTurn` ≈ nanobot `runner.py._run_core`（LLM 多轮对话）

**mini-agent 的 runner 在 nanobot 里被切成了 loop._dispatch + runner._run_core 两半。**

## 切分依据对比

| 项目 | 切分线 |
|---|---|
| mini-agent | **消息驱动（loop） vs 业务流程（runner）** |
| nanobot | **turn 生命周期（loop） vs LLM 多轮对话状态机（runner）** |

nanobot 的 loop.py 干了 mini-agent loop.ts + handleTurn + 部分 runner 的活。

## 7 状态机详解

| 状态 | 干什么 | mini-agent 在哪做 |
|---|---|---|
| `_state_restore` | 加载 session、跑 autocompact.prepare_session | `index.ts.SessionStore.load` |
| `_state_compact` | 从归档恢复时把摘要塞回 system | （没有，mini-agent 不做归档） |
| `_state_command` | slash 命令路由（/clear /exit ...） | `cli.ts` 内联 if |
| `_state_build` | 构造系统提示、tool schema、injection、**主动压缩 token** | runner 内部偷偷做 |
| `_state_run` | **真正调 LLM + 工具循环**（调用 AgentRunner） | `runner.runTurn()` 全部 |
| `_state_save` | 持久化对话历史 | `scheduleSave` |
| `_state_respond` | 把回复发到 channel | `bus.outbound.push` |

把这 7 步抽成显式状态机的好处：

1. 每个状态可以单独写、单独测、单独 hook
2. 调度器（loop）能精确知道现在卡在哪
3. 中断和恢复有明确边界
4. 出 bug 时日志能告诉你"卡在 _state_compact"

代价：**6 倍代码量**。这是 nanobot 走"生产级"必须付出的，mini-agent 完全不需要。

## TurnContext：把局部变量提升为对象

```python
class TurnContext:
    msg: InboundMessage
    session: Session
    messages: list[dict]
    pending_summary: str | None        # _state_compact 写 → _state_build 读
    history: list[dict]                 # _state_build 写
    initial_messages: list[dict]        # _state_build 写 → _state_run 读
    state_trace: list[StateTraceEntry]  # 状态执行历史
    error: Exception | None
    final_text: str | None
    ...
```

7 个 `_state_*` 函数共享一个 ctx，**避免长参数列表**。
`state_trace` 自动记录历经的状态，**调试时能看到完整路径**。

→ 经典模式：当多个函数协作处理同一份数据时，把"局部变量"提升为"对象字段"。

## "记忆压缩"到底在哪：三层结构

读笔记 04 之前以为 `autocompact.py` 就是"context 压缩"——错了。
**nanobot 记忆系统有三层**：

```
1. SessionStore (session/manager.py)
   ↓ 每个 session 的对话历史持久化（mini-agent 也有）

2. Consolidator (agent/memory.py, 1049 行) ← "context 压缩"在这里
   ↓ 双阶段：
     - maybe_consolidate_by_tokens   ← 主动压缩（context 太长）
     - compact_idle_session            ← 闲置归档（autocompact 调用）

3. AutoCompact (agent/autocompact.py, 96 行) ← "多 session 调度"
   ↓ 调度 Consolidator 干活，决定"哪些 session 该归档"
```

### 笔记 04 讲的 `_state_compact` 只是"读归档摘要"

```python
async def _state_compact(self, ctx: TurnContext) -> str:
    ctx.session, pending = self.auto_compact.prepare_session(ctx.session, ctx.session_key)
    ctx.pending_summary = pending
    return "ok"
```

只做"如果这个 session 之前被 autocompact 归档过，把摘要拿出来塞回 system prompt"。
跟 mini-agent 的 `compact.ts` **不是同一个事**。

### 真正的 "context 太长主动压缩" 在 `_state_build`

```python
async def _state_build(self, ctx: TurnContext) -> str:
    if not ctx.ephemeral:
        await self.consolidator.maybe_consolidate_by_tokens(
            ctx.session,
            replay_max_messages=self._max_messages,
        )
    ...
```

**每次构造请求前，都问一遍："我现在 token 是不是超阈值了？是的话压一下"**。

这才是对应 mini-agent `compact.ts` 的功能。

### 时机对比：turn 前 vs turn 后

| 时机 | mini-agent | nanobot |
|---|---|---|
| 触发位置 | `handleTurn` 末尾（一轮**结束后**） | `_state_build`（一轮**开始前**） |
| 优点 | 用户已经看到回答，压缩延迟不影响用户 | 这一轮就能省 token |
| 缺点 | 当前轮**已发送的请求**没省钱 | 用户输入到出第一个字之间多一段延迟 |

→ nanobot 选"开始前"是因为：**生产场景下省钱比延迟更重要**。
→ mini-agent 选"结束后"也合理：CLI 用户更敏感首字延迟。

**没有谁对谁错——选择反映场景。**

## Subagent：让 LLM 在工具里再起一个 LLM

### 一句话理解

> **subagent = "递归调用自己 + 上下文隔离"**。

最常见的场景：
- 主 agent 在做"读 30 个文件总结"任务
- 30 个文件每个都要读 → 全塞进主 context 直接爆 token
- 解决：起 30 个 subagent，每个只看一个文件、给一个总结，主 agent 只看 30 个总结

### nanobot 的实现位置

SubagentManager 挂在 AgentLoop 上：

```python
# loop.py
from nanobot.agent.subagent import SubagentManager

class AgentLoop:
    def __init__(self, ...):
        self.subagents = SubagentManager(
            bus=self.bus,
            max_concurrent_subagents=...,
        )
```

**关键设计**：
1. **SubagentManager 挂在 AgentLoop 上** —— 因为它要复用 bus、provider、tools
2. **ToolContext 持有 subagent_manager 引用** —— `spawn_tool` 在 execute 时能拿到它去起新 agent
3. **subagent 跟主 agent 共享 bus** —— subagent 完成后通过 bus 把结果发回，主 agent 等待

### 完整生命周期

```
主 agent turn 进行中
  └─ 主 agent 调 spawn 工具
       └─ SubagentManager.spawn(...)
            ├─ 创建一个新的 InboundMessage（标记 sender_id="subagent"）
            ├─ 推到 bus.inbound
            └─ 立即返回 task_id（不等结果）
  └─ spawn 工具返回 "已启动 subagent xxx，结果稍后到"
  └─ 主 agent 继续

  ↓ 同时：
  loop._dispatch 又被新消息唤醒
    └─ 进入新 turn
        └─ 新 turn 跑 LLM、用工具、生成结果
        └─ 通过 bus 把结果推回主 session

  ↓ 主 agent 这边：
  loop._process_system_message 收到 subagent 的结果
    └─ _persist_subagent_followup(session, msg)
        └─ 把 subagent 的结果作为 assistant 消息塞进主 session 历史
    └─ 重新唤醒主 agent，让它"看到 subagent 干完了"
```

### 同一个 AgentLoop 既跑主 agent 又跑 subagent

```python
# loop.py:_dispatch
is_subagent = msg.sender_id == "subagent"
...
current_role = "assistant" if is_subagent else "user"
```

同一个 dispatch 循环根据 `sender_id` 区分这次是"用户来的消息"还是"subagent 来的回报"。

**好处**：
- subagent 自动复用主 agent 的所有工具、provider、压缩逻辑
- subagent 的结果用同一套消息格式
- 主 / sub 关系是隐式的（通过 task_id metadata），不需要特殊代码路径

**坏处**：
- 复杂度高
- 调试难（某条消息是用户来的还是 subagent 来的，要看 metadata）

### 在 mini-agent 里加 subagent 的草图

最小实现思路（不用照搬 nanobot 的复杂度）：

```ts
// src/tools/spawn.ts
export const spawnTool = defineTool({
  name: "spawn",
  description: "起一个子 agent 完成某个独立任务",
  schema: z.object({
    task: z.string().describe("子任务描述"),
    files: z.array(z.string()).optional().describe("子 agent 应当只看这些文件"),
  }),
  readOnly: false,
  execute: async ({ task }, ctx) => {
    const subMessages: Message[] = [
      { role: "system", content: "你是子 agent。只完成给定任务，简洁返回结果。" },
      { role: "user", content: task },
    ];
    // 同步等待子 agent 跑完（不像 nanobot 那样异步）
    const result = await runTurn({
      provider: ctx.provider,         // 复用主 agent 的 provider
      registry: ctx.registry,          // 复用工具
      messages: subMessages,
      ctx: { workspace: ctx.workspace },
      model: ctx.model,
      maxSteps: 5,                     // 子 agent 限制更紧
    });
    return result.final.content;
  },
});
```

简化版的关键决策：
- **同步等**而不是异步推 bus（mini-agent 没有 reentrant dispatch）
- **复用主 agent 的 registry / provider**（通过 ctx 传）
- **新建 messages 数组**（上下文隔离的核心）

→ 阶段 5 推荐改造项之一，约半天工作量。
**做完才会真懂为什么 nanobot 把 subagent 做得那么复杂**——异步 + 共享 bus 是 nanobot 不能简化的产物，因为它要支持长任务。

## "为什么 MCP 启动在 loop.py 不在入口"

### 两个项目的层次对比

```
nanobot:
nanobot/__main__.py / cli/commands.py
  ├─ 解析配置
  ├─ 实例化 AgentLoop
  └─ 调 loop.run()
        │
        └─ AgentLoop.__init__:    (init 时立即做)
            ├─ 实例化 SubagentManager
            ├─ 加载 default tools
            └─ 注册各种内部状态

        loop.run() 启动时:        (run 入口处做)
            ├─ _connect_mcp()                   ← MCP 连接
            ├─ _register_default_tools()        ← 内置工具注册
            ├─ 启动 cron service
            ├─ 启动 dream consolidator
            └─ while True: dispatch...

mini-agent:
index.ts:
  ├─ 加载 .env
  ├─ 实例化 ToolRegistry
  ├─ registry.register(...)    ← 工具注册
  ├─ if mcpConfig:
  │     connectMcpServer()     ← MCP 连接
  ├─ new AnthropicProvider
  ├─ new MessageBus
  ├─ new CliChannel
  ├─ runAgentLoop({ handleTurn })   ← 启动 loop
  └─ channel.start()
```

### 差异本质：**谁拥有这些资源的生命周期**

| 资源 | mini-agent 谁拥有 | nanobot 谁拥有 |
|---|---|---|
| ToolRegistry | `index.ts` 局部变量 | `AgentLoop.tools` 字段 |
| MCP 连接 | `index.ts` 局部变量 | `AgentLoop.mcp` 字段 |
| Provider | `index.ts` 局部变量 | `AgentLoop.provider` 字段 |
| Subagent 管理 | (没有) | `AgentLoop.subagents` 字段 |
| Cron 调度 | (没有) | `AgentLoop.cron_service` 字段 |

→ **mini-agent 的 index.ts 同时扮演"装配工"和"生命周期管理者"**——简单场景下没问题。
→ **nanobot 把所有"长生命周期资源"塞进 AgentLoop 实例**——`__main__.py` 只是个薄壳。

### 这个差异为什么必然存在

nanobot 必须支持的场景：

- **运行时切换模型**：`/model claude-haiku-4-5` 这种 slash 命令要能改 provider，但不能重启进程
- **运行时禁用工具**：`/disable web_search` 要能动态 unregister
- **subagent 借用主 loop 的 provider**：subagent 不应该自己再连一遍 MCP

如果 MCP 在 `__main__.py` 局部变量里，slash 命令根本碰不到它。
**资源必须挂在某个长生命周期对象上才能被运行时控制。**

mini-agent 不需要这些场景，所以 index.ts 直接持有就行。

→ **这是"核心精简"的另一面**：当某些东西 mini-agent 不需要，不要为了"长得像 nanobot"提前抽象。

## runner.py 内部职责导览

runner.py（1570 行）只对应 mini-agent 的 `runTurn` 那一个函数，但展开成了大约 30 个方法。

### 主入口：`run` → `_run_core`

```
run(spec)                    ← 入口，做注入消息（goal continuation 之类）的预处理
  └─ _try_drain_injections   ← cron / 定时任务在 turn 开始时插入消息
  └─ _run_core               ← 真正的 LLM 循环
      ├─ _build_request_kwargs    ← 拼请求参数（cache_control / system / ...）
      ├─ _request_model           ← 调 provider.chat / chat_stream
      ├─ _execute_tools           ← ↓
      │   └─ _run_tool            ← 单个工具执行 + violation 分类
      └─ _request_finalization_retry  ← 达到 max_iterations 时让 LLM 强制收尾
```

### "补丁式"方法（生产 bug 喂出来的）

```python
_drop_orphan_tool_results        # tool_call 没了但 tool_result 还在 → 清理
_backfill_missing_tool_results   # tool_call 有但 tool_result 缺 → 补占位
_microcompact                    # 工具结果太大就地缩水
_apply_tool_result_budget        # 工具结果总 token 超预算就截断
_snip_history                    # 老消息过多则砍掉中间
_classify_violation              # workspace / SSRF 违规分类
_is_ssrf_violation               # 检测 LLM 试图访问内网
```

每个方法名都告诉你"它在解决什么具体问题"。
→ 验证之前讨论的："读 nanobot 看到陌生代码时，先想'这是为了不再被什么坑'。"

### `_run_core` 真正核心循环（去掉装饰）

```python
async def _run_core(self, ...):
    iteration = 0
    while iteration < spec.max_iterations:
        iteration += 1

        if iteration > 1:
            injected = await self._try_drain_injections(...)

        kwargs = self._build_request_kwargs(...)
        response = await self._request_model(kwargs)

        messages.append({
            "role": "assistant",
            "content": response.content,
            "tool_calls": [tc.to_openai() for tc in response.tool_calls],
        })

        if not response.has_tool_calls:
            break

        results = await self._execute_tools(spec, response.tool_calls, ...)
        for tc, result in zip(response.tool_calls, results):
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            })

    if iteration == spec.max_iterations:
        await self._try_finalize_after_max_iterations(...)
```

**这跟 mini-agent 的 `runTurn` 是同一个状态机**，30 行代码。
其余 1500 行就是补丁、跟踪、错误分类、流式增量、重试、injection、micro-compact 等"边缘"。

## 完整对照表

| 功能 | mini-agent 在哪 | nanobot 在哪 |
|---|---|---|
| 队列消费循环 | `agent/loop.ts.runAgentLoop` | `agent/loop.py.run` |
| 单消息处理 | `index.ts.handleTurn` | `agent/loop.py._dispatch` + 7 状态机 |
| Session 加载 | `index.ts.SessionStore.load` | `_state_restore` |
| 闲置归档摘要恢复 | (没有) | `_state_compact` (调 autocompact) |
| Slash 命令 | `cli.ts` 内联 if | `_state_command` (调 commands.dispatch) |
| **context 太长压缩** | `compact.ts.maybeCompact` (turn 后) | `_state_build` 里调 `consolidator.maybe_consolidate_by_tokens` (turn 前) |
| 拼系统消息 / tools | `runner.ts` 内联 | `_state_build._build_initial_messages` |
| LLM 多轮 + 工具循环 | `runner.ts.runTurn` | `_state_run` → `runner.py._run_core` |
| 持久化历史 | `SessionStore.scheduleSave` | `_state_save` |
| 推回 channel | `bus.outbound.push` | `_state_respond` |
| **MCP 启动** | **`index.ts` 内联** | **`AgentLoop._connect_mcp`** |
| **工具注册** | **`index.ts` 内联** | **`AgentLoop._register_default_tools`** |
| **Subagent** | **(没有)** | **`AgentLoop.subagents = SubagentManager`** |
| **Cron 任务** | **(没有)** | **`AgentLoop.cron_service`** |
| Tool result 大小预算 | (没有) | `runner.py._apply_tool_result_budget` |
| 历史 micro-compact | (没有) | `runner.py._microcompact` |
| Orphan tool result 清理 | (没有) | `runner.py._drop_orphan_tool_results` |
| Workspace / SSRF 违规分类 | (没有) | `runner.py._classify_violation` |

## 核心结论

> **mini-agent 是"装配工 = 入口"，所有资源都活在 `index.ts` 局部作用域。**
> **nanobot 是"装配工 = `__main__`，资源 = AgentLoop"，因为运行时要操控这些资源。**
>
> **这不是抽象品味问题，是生命周期问题。**

## 给读 nanobot 的检查清单

读到 nanobot 任何一段陌生代码时，问自己：

1. **这一段在 mini-agent 哪里？** → 没有，说明是 mini-agent 砍掉的边缘
2. **它要操控的资源是不是长生命周期？** → 是，说明必须挂在 AgentLoop / 类似容器上
3. **它解决的是哪个真实场景？** → 找到了 = 真需求；找不到 = 可能是过早抽象

→ 如果三个问题都给出明确答案，你就理解了那段代码。
