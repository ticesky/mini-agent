# 模块 1 · 消息流转骨架

nanobot 里有**两个嵌套循环**：

- **外层 = AgentLoop 的 turn 状态机**（1 条消息 → 1 次 turn）
- **内层 = AgentRunner 的 tool-call 迭代**（1 次 turn 内 → N 次 LLM 调用）

两者只通过 `AgentRunSpec` / `AgentRunResult` / 共享的 `pending_queue` 通信。

## 一、四个核心数据结构

| 类型 | 位置 | 是什么 |
|---|---|---|
| `InboundMessage` | [bus/events.py:22](../nanobot/bus/events.py#L22) | channel 塞进 bus 的原始消息；`session_key` 默认拼成 `f"{channel}:{chat_id}"` |
| `OutboundMessage` | [bus/events.py:41](../nanobot/bus/events.py#L41) | agent 回给 channel 的最终消息 |
| `LLMResponse` | [providers/base.py:150](../nanobot/providers/base.py#L150) | provider 返回统一响应：`content + tool_calls + finish_reason + usage + 错误元数据` |
| `ToolCallRequest` | [providers/base.py:48](../nanobot/providers/base.py#L48) | LLM 想调工具的意图：`id + name + arguments`。`to_openai_tool_call()` 把它序列化回 message history |

关键判据：`LLMResponse.should_execute_tools = has_tool_calls AND finish_reason in ("tool_calls","function_call","stop")`。

## 二、外层：AgentLoop.run 的分诊台

`AgentLoop.run` 从 bus 拉出消息后，经过 5 道岔口才决定是否开新 turn：

```
consume_inbound(msg)
        │
① 运行时控制信令 (MCP reload)          → 已在 handler 内处理 → continue
② 优先级命令 (/stop /cancel)           → inline dispatch 绕开队列 → continue
③ cron/trigger 自动 turn 且 session 忙 → 存到 coordinator 延后队列 → continue
④ session 忙 (key in _pending_queues)：
     ④a 是可派发的普通命令              → inline dispatch → continue
     ④b 是普通消息                      → 塞 pending_queue 做 mid-turn 注入 → continue
     ④b 队列满                          → 降级排队起新 turn
⑤ 常规                                 → asyncio.create_task(_dispatch(msg))
```

**同一 session 内串行、跨 session 并行** — 靠 `_session_locks[key]` 保证。

## 三、外层：Turn 状态机（7 态）

### 3.1 转换表（[loop.py:227](../nanobot/agent/loop.py#L227)）

```
RESTORE ─ok─▶ COMPACT ─ok─▶ COMMAND ─dispatch─▶ BUILD ─ok─▶ RUN ─ok─▶ SAVE ─ok─▶ RESPOND ─ok─▶ DONE
                              │
                              └─shortcut─────────────────────────────────────────────────────▶ DONE
```

驱动引擎：`_process_message` [loop.py:1305](../nanobot/agent/loop.py#L1305) 一个 `while state != DONE` 循环，每轮反射调 `_state_<name>` 拿 event，查 `_TRANSITIONS` 决定下一态。**查不到直接抛 `RuntimeError`（契约保护）**。每个 state 耗时写入 `ctx.trace: list[StateTraceEntry]` 供事后复盘。

### 3.2 每个状态的单一职责

| 状态 | 职责 | 出口 event |
|---|---|---|
| **RESTORE** [:1454](../nanobot/agent/loop.py#L1454) | 拉 session、抽附件文档、恢复上次崩溃的 runtime checkpoint 与 pending_user_turn | ok |
| **COMPACT** [:1490](../nanobot/agent/loop.py#L1490) | 若到期/超阈值触发一次 auto_compact，把 `pending_summary` 挂到 ctx | ok |
| **COMMAND** [:1495](../nanobot/agent/loop.py#L1495) | 判断是否是 slash 命令：能当场答完 → `shortcut`；否则 `dispatch` | shortcut / dispatch |
| **BUILD** [:1525](../nanobot/agent/loop.py#L1525) | consolidator 巩固记忆 → get_history → 拼 `initial_messages` → 早持久化 user 消息 | ok |
| **RUN** [:1568](../nanobot/agent/loop.py#L1568) | 调 `AgentRunner._run_core` 跑内层 tool-call 循环，拿到五元组结果 | ok |
| **SAVE** [:1607](../nanobot/agent/loop.py#L1607) | 原子写新增消息到 history.jsonl、记 latency、清 checkpoint、异步安排下次 consolidate | ok |
| **RESPOND** [:1649](../nanobot/agent/loop.py#L1649) | 组装 `OutboundMessage`（可被 ephemeral / MessageTool 抑制） | ok |

**SAVE 和 RESPOND 拆开**：一个负责持久化，一个负责回执，副作用/异常语义/可测试性都不同。

### 3.3 外层熔断

- **状态转换未定义** → `RuntimeError`（防止 event 被误加）。
- **handler 抛异常** → try/except 记 trace `error="exception"` 后 raise，`_dispatch` 的 finally 清理 pending_queue。

## 四、内层：AgentRunner tool-call 循环

### 4.1 每轮迭代的决策表（[runner.py:355-654](../nanobot/agent/runner.py#L355)）

```
for iteration in range(spec.max_iterations):
    M' = context_governor.prepare_for_model(messages)   # 治理后的临时视图,不影响持久化
    resp = await _request_model(spec, M', hook)         # 带超时/重试/malformed 修复

    if resp.should_execute_tools:
        追加 assistant(tool_calls) → _execute_tools → 追加 tool_result
        → _try_drain_injections → continue

    if resp.finish_reason == "error":
        drain 到 → continue;  否则 break (stop_reason="error")

    if content 空 且未过重试上限:  continue
    if content 空 且已达重试上限:  _request_finalization_retry (去工具再问一次)

    if finish_reason == "length" 且未过 recovery 上限:
        追加 "请继续" 消息 → continue

    # 正常 final
    _try_drain_injections(allow_goal_continue=True)
        drain 到 → continue;  否则追加 assistant → break

else:  # for-else, 达到 max_iterations
    最后一次 drain → _try_finalize_after_max_iterations → _max_iterations_fallback
    stop_reason = "max_iterations"
```

### 4.2 五种 stop_reason（覆盖全部退出路径）

| stop_reason | 触发 | 用户可见 |
|---|---|---|
| `completed` | LLM 给出非空 final 且无 tool_call | 真答案 |
| `max_iterations` | 迭代上限用尽 | finalize 兜底 or 硬编码模板 |
| `error` | LLM `finish_reason="error"` 且 drain 未救活 | 错误文本（欠费有专用文案） |
| `empty_final_response` | 反复吐空、finalization retry 也空 | `EMPTY_FINAL_RESPONSE_MESSAGE` |
| `tool_error` | tool 抛 fatal 异常 | 错误文本 |

### 4.3 六道熔断闸

| 闸 | 阈值 | 触发 | 应对 |
|---|---|---|---|
| ① max_iterations | `spec.max_iterations` | LLM 一直调工具不收敛 | 强退 + 无工具 finalize + 硬编码兜底 |
| ② empty_content_retries | `_MAX_EMPTY_RETRIES` | 反复吐空 | 达上限走 `_request_finalization_retry`（去工具强答） |
| ③ length_recovery_count | `_MAX_LENGTH_RECOVERIES` | `finish_reason="length"` 被截断 | 追加"请继续"消息续写 |
| ④ injection_cycles | `_MAX_INJECTION_CYCLES` | mid-turn 注入死循环 | drain 返 False，新注入不再吸收 |
| ⑤ external_lookup / workspace_violation | per-target 计数 | 对同一 URL / workspace-outside 路径反复试 | 拒绝执行、错误塞回带 hint |
| ⑥ malformed_tool_calls | 一次自动重试 | tool_call.name 为空/非字符串 | 重试失败 → 降级 `_request_no_tools` |

**共同哲学**：不炸整个 turn，尽量让 LLM 自纠或用户看到 graceful degradation。

### 4.4 关键辅助函数

| 函数 | 作用 |
|---|---|
| `_request_model` [runner.py:711](../nanobot/agent/runner.py#L711) | 单次 provider 调用：超时/流式分叉/malformed 重试/降级 no-tools |
| `_execute_tools` [runner.py:1083](../nanobot/agent/runner.py#L1083) | 按批分组、可并发 `asyncio.gather`；单 tool 出错不炸整批 |
| `_try_drain_injections` [runner.py:149](../nanobot/agent/runner.py#L149) | 从 pending_queue 吸收新消息，追加进 messages，受 injection_cycles 熔断 |
| `_append_injected_messages` [runner.py:126](../nanobot/agent/runner.py#L126) | 合并相邻同 role user 消息，保护 role alternation |
| `_drop_malformed_tool_calls` [runner.py:867](../nanobot/agent/runner.py#L867) | 剔除 `name` 缺失/非字符串的 tool_call |
| `_try_finalize_after_max_iterations` [runner.py:935](../nanobot/agent/runner.py#L935) | max_iter 兜底：去掉工具再调一次强制模型答话 |
| `context_governor.prepare_for_model` | 给模型一份治理后的 messages 视图（裁剪/占位符修复/tool_result 补齐），不修改持久化那份 |

## 五、Mid-turn 注入

**核心机制**：pending_queue 不是"下一个 turn 的入口"，而是"追加到当前 turn"的通道。

- 岔口 ④b 塞入 → `_try_drain_injections` 消费。
- 只在**"assistant + 所有 tool_result 都已追加"** 的合法时刻 drain，避免破坏 role alternation。
- 第 2 条消息被 drain 后作为 user message 追加进当前 messages，**LLM 下一轮完全可以继续调工具处理它**——所以第 2 条需不需要工具都不影响机制。
- Subagent 完成结果也走同一队列（`sender_id="subagent"` + `injected_event="subagent_result"` 标记）。
- 队列容量 20，`QueueFull` 时降级为排新 turn。

## 六、两个循环的耦合面

```
外层 _state_run ─── AgentRunSpec ───▶ 内层 _run_core
                                          │
外层 _state_save/respond ◀─ AgentRunResult ┘
     (final_content, messages, tools_used, stop_reason, had_injections)

外层 岔口 ④b put ─┐
                  ├──▶ pending_queue（共享）
内层 drain 消费 ──┘
```

- 外层**不感知**：内层跑了几轮、调了什么工具、有没有 malformed retry。
- 内层**不感知**：session 是谁、消息从哪来、要发给什么 channel。

## 七、一句话总结

> **外层是 "1 消息 → 1 状态机 → 1 outbound" 的确定性 7 态流水线；内层是 "1 turn → N 轮 LLM/工具你来我往，靠 6 道熔断闸兜底、靠 5 种 stop_reason 收敛" 的自适应循环。两者只经由 AgentRunSpec / AgentRunResult / 共享 pending_queue 三件套通信。**
