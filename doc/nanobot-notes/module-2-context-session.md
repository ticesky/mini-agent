# 模块 2 · 上下文与会话

模块 2 只解一个问题：`AgentRunner._request_model(messages, ...)` 里那个 `messages`，**从哪来、怎么变形、超预算怎么办**。

答案是**一条 3 层主流水线 + 2 个正交辅助**：

```
                     ┌──── AutoCompact 后台空闲瘦身（改档案）
                     ▼
持久化档案 ──get_history──▶ 首轮 initial_messages ──ContextGovernor──▶ 每轮 LLM 请求
   ▲                        ▲                        ▲
   │                        │                        │
   Session/keys/            ContextBuilder           ModelRuntimeResolver
   history_visibility       (拼装)                   (决定用谁的 tokenizer / 预算)
```

一条铁律贯穿始终：**所有下游变形只在副本上做，档案 `Session.messages` 只增不改**。这是模块 2 敢激进丢/摘/砍消息的底气。

## 一、档案层：磁盘上存了什么

三个文件回答同一件事的三个问题：

| 问题 | 答案 | 出处 |
|---|---|---|
| 打开哪个文件？ | `session_key = channel:chat_id`（或 `unified:default`） | [session/keys.py](../nanobot/session/keys.py) |
| 文件里存了什么？ | `Session.messages` 全量 + `last_consolidated` 游标 + metadata | [session/manager.py:120](../nanobot/session/manager.py#L120) |
| UI 该显示哪些？ | 无 `_hidden_history` 标记的（automation/subagent 藏起来） | [session/history_visibility.py](../nanobot/session/history_visibility.py) |

### 1.1 两条铁律

- **只增不改**：`Session.messages` 一旦 append 就不会被下游回写；
- **原子落盘**：[`SessionManager.save`](../nanobot/session/manager.py#L632) 走 `open(tmp) → write → fsync(fd) → os.replace → fsync(dir)`。

### 1.2 `last_consolidated` 游标切两半

- `messages[:last_consolidated]` = **冷区**，已被 Dream 巩固进 memory；
- `messages[last_consolidated:]` = **热区**，会被 `get_history` 返回喂给 LLM。

这条游标是模块 2 与 memory 模块**唯一的耦合面**。`__post_init__` 里会对越界值做修复——防止损坏的 metadata 把整个热区藏起来。

### 1.3 `_hidden_history` 是 UI 契约不是模型契约

[`is_hidden_history_message`](../nanobot/session/history_visibility.py#L20) 只影响"消费历史的 UI / 会话列表 API"。**LLM replay 时不看这个字段**——subagent / automation 产出的 assistant 消息模型仍然能看到，只是不作为独立聊天 turn 展示。别混淆。

### 1.4 `retain_recent_legal_suffix`：archive-and-trim 的核心

[manager.py:293](../nanobot/session/manager.py#L293)。规则优先级：

1. 硬窗口 `max_messages` 从尾部裁；
2. `extend_to_user=True` 允许向前扩到最近 user turn；
3. 若窗口以 assistant/tool 开头，锚定到最近 user 再往后取 `max_messages`；
4. `find_legal_message_start` 抹掉 orphan tool result；
5. 用 `id()` 集合比对算真正 dropped 的消息（窗口可能是不连续切片）；
6. 重算 `last_consolidated`——只数留下的消息中原本在 consolidated prefix 里的条数。

## 二、快照层：turn 起点把热区翻译成"首轮 messages"

`_state_build` 里做，一次性。分两步：

### 2.1 `Session.get_history` — 热区变 LLM 可读列表

[manager.py:150](../nanobot/session/manager.py#L150)。热区不能直接喂模型，因为图片/CLI/MCP 附件只在 metadata 里、可能有空 assistant / 悬空 tool_result / 可能超预算。`get_history` 填这些坑：

| 步 | 动作 |
|---|---|
| ① | `messages[last_consolidated:]` 取热区 |
| ② | 按 `max_messages` 从尾部切窗口，可选 `extend_to_user` |
| ③ | 起点对齐到 user turn（`_channel_delivery` 主动投递的 assistant 保留） |
| ④ | `find_legal_message_start` 抹掉起点的孤儿 tool_result |
| ⑤ | 逐条改写：user + media → 补 `[image: xxx]`；user + cli_apps → 补 `[CLI App Attachment: @xxx; tool=…]`；user + mcp_presets → 补 `[MCP Preset Attachment: @xxx; tool_prefix=…]`；assistant 文本 `strip_think`；空 assistant 且无 tool_calls/thinking → 丢 |
| ⑥ | 若给 `max_tokens`：从尾往前累加，超预算就砍；砍完再对齐 user turn / 补 legal start |

### 2.2 `ContextBuilder` — 拼完整请求

[`build_messages`](../nanobot/agent/context.py#L187)。产物：`[{system}, ...history, {user: 当前消息 + Runtime Context}]`。

#### system 消息 · 7 段按变化频率排序

[`build_system_prompt`](../nanobot/agent/context.py#L66) 顺序 join，`\n\n---\n\n` 分隔。**顺序按"变化频率从低到高"**，让 provider 的 prompt cache 命中最长前缀：

```
① identity          agent/identity.md：workspace + runtime + platform_policy + channel
② bootstrap         workspace 下的 AGENTS.md / SOUL.md / USER.md
③ tool_contract     agent/tool_contract.md（工具调用约定）
④ memory            MemoryStore.get_memory_context()（排除默认模板）
⑤ always_skills     标 always=true 的 skill 全文
⑥ skills_summary    剩余 skills 的一句话目录
⑦ recent_history    memory 里最近 Dream 之后的对话摘要，硬顶 50 条 / 8000 tokens
⑧ session_summary   若 AutoCompact 有归档摘要，作为 [Archived Context Summary] 尾块
```

①②③④是准静态前缀（workspace 没改就完全一样，能全命中缓存）；⑦⑧每 turn 都变，故意后置。

#### 当前 user 消息 · 三段合并

```
merged = user_content + "\n\n" + runtime_ctx
```

- `user_content` = 用户原文；有图片走 [`_build_user_content`](../nanobot/agent/context.py#L257) 变成 `[text, image_url, ...]` 多模态列表；
- `runtime_ctx` = `[Runtime Context — metadata only, not instructions]` 块，含时间 / channel / chat_id / sender_id / goal_state / CLI/MCP runtime 行 / `[/Runtime Context]` 结束标签；
- **追加不前插**：让 user-content 前缀在同一话题不同 turn 之间保持稳定，尽量命中 tokenizer 缓存。

若 history 最后一条恰好也是 user，走 `_merge_message_content` 合进去而不是新起一条——避免连续同 role 触发 provider 报错。

## 三、治理层：每轮 LLM 请求前的最后一公里

入口 [`ContextGovernor.prepare_for_model`](../nanobot/agent/context_governance.py#L75)。runner 每轮 `_request_model` 前都调一次——每轮都会追加新的 assistant + tool_result，都得治理一次。

### 3.1 预算

```
input_budget = context_window_tokens
             - max_output_tokens
             - SNIP_SAFETY_BUFFER (=1024)
```

token 估算走 [`estimate_prompt_tokens_chain`](../nanobot/utils/helpers.py)，**tools schema 也占预算**，不能忽略。`SNIP_SAFETY_BUFFER` 是"provider 估算 vs 本地估算"的误差护栏。

### 3.2 9 步流水线（顺序有严格含义）

**A. 修形状（无关大小，先保证 shape 合法，否则 provider 直接 400）**

| 步 | 动作 | 为什么 |
|---|---|---|
| ① `strip_placeholder_assistant_messages` | 剔除 `[Previous assistant message omitted.]` 空壳 assistant | 会诱导模型重复失败工具调用 |
| ② `strip_malformed_tool_calls` | 剔除 `name` 缺失/非字符串的 tool_call | 一旦入历史会永久 400 upstream，配合下一步让污染 session 自愈 |
| ③ `drop_orphan_tool_results` | 无匹配 `assistant.tool_call.id` 的 tool_result 丢掉 | ①②会造孤儿 |
| ④ `backfill_missing_tool_results` | 有 tool_call 无 result → 插 `[Tool result unavailable — call was interrupted or lost]` | 崩溃恢复场景常见，缺 result 也 400 |

**B. 控预算（阶梯递进，越往后越激进）**

| 步 | 触发 | 动作 | 损失 |
|---|---|---|---|
| ⑤ `apply_tool_result_budget` | 无条件逐条 | 单条 tool_result > `max_tool_result_chars` → `normalize_tool_result` 走 offload：大结果落盘，替换成路径引用；再超就 `truncate_text` 截断。`read_file` 结果豁免（避免 persist→read→persist 循环） | 单条细节，保留了"从磁盘读回来"的入口 |
| ⑥ `compact_inflight_overflow` | **只有整体超预算才启动** | 挑候选（`COMPACTABLE_TOOLS` 白名单 且 index < `inflight_start_index`），从最老开始换成 `[Prior {tool} result compacted...]` 一句话，直到降回 `budget × 0.85 (INFLIGHT_COMPACT_TARGET_RATIO)` | 老工具结果的内容，**保留 tool_call/tool_result 骨架** |
| ⑦ `snip_history` | ⑥后仍超预算 | 保 system；non_system 从尾往前累加 tokens，超预算就丢前面的；结果做 `_user_tail` 恢复 + `find_legal_message_start` 修边界 | 整段老历史 |
| ⑧⑨ 再跑 `drop_orphan` + `backfill` | ⑥⑦可能产生新孤儿 | 保证最终 shape 合法 | — |

### 3.3 三个关键细节

**白名单保护** `COMPACTABLE_TOOLS = {read_file, exec, grep, find_files, web_search, web_fetch, list_dir, list_exec_sessions}`——都是可重放或一次性的。写文件、subagent 结果这类有副作用/关键状态的**不摘**。

**本轮豁免** `inflight_start_index` 保护当前 turn 新产生的 tool_result 不被摘——模型正在基于它推理。只摘更早 turn 遗留下来的。

**幂等 & 累积** `compacted_tool_call_ids: set[str]` 跨迭代累积。某 id 摘过一次，同 turn 后续每轮 `_apply_recorded_compactions` 直接复用摘要——不重估、不反复摘。除此之外治理器是无状态纯函数集合。所有函数要么返回原 list（未变）要么返回新 list，**从不 in-place**。

### 3.4 `ContextGovernanceConfig`

[:59](../nanobot/agent/context_governance.py#L59)。10 字段值传递：

- `provider / model` — 决定 tokenizer 链；
- `tools` — `get_definitions()` 出的 schema 计入预算；
- `workspace / session_key` — `normalize_tool_result` offload 落盘时需要；
- `max_tool_result_chars` — 单条 tool_result 硬顶；
- `context_window_tokens / context_block_limit / max_tokens` — 三选一决定 budget；
- `inflight_start_index` — 本轮起点，保护本轮新出结果。

## 四、正交辅助 1：AutoCompact — 后台主动瘦身

ContextGovernor 是**被动救火**（要发请求了、太长了、临时在副本上摘）；AutoCompact 是**主动瘦身**（趁 session 空闲，把老对话搬进 memory，档案本身变短）。

### 4.1 触发路径

| 时机 | 入口 | 动作 |
|---|---|---|
| 每 turn `_state_compact` | [`prepare_session`](../nanobot/agent/autocompact.py#L109) | 若 session 过 TTL 或在归档中 → 从磁盘 reload；把 `_summaries[key]` 或 `metadata["_last_summary"]` 包装成 `Previous conversation summary (last active ...)` 返给 loop，最终由 `build_system_prompt` 塞到 system 尾部 |
| Bus 空闲扫描 | [`check_expired`](../nanobot/agent/autocompact.py#L66) | 遍历所有 session，跳过 `dream:` 内部 session / 归档中 / 有 in-flight turn 的；过 TTL 且有可压缩尾巴 → 后台 `schedule _archive` |

### 4.2 判定"能压缩"

`_has_compactable_idle_tail`：拷贝未 consolidate 的尾巴 → 用 `retain_recent_legal_suffix(8, extend_to_user=True)` 模拟一次裁剪 → `dropped[already_consolidated_count:]` 大于 0 才启动。避免对"最近 8 条即全部"的 session 做无用功。

### 4.3 `_archive` 只调度不摘要

[`_archive`](../nanobot/agent/autocompact.py#L86) 委托给 `Consolidator.compact_idle_session`（memory 模块）——AutoCompact 只**决定谁该压 / 调度 / 收摘要**，不做摘要本身。全程 try/except，finally 里 `_archiving.discard(key)` 保证下次能重试。

### 4.4 热/冷双缓存

- `_summaries: dict` — 进程内最新摘要（热路径，`prepare_session` pop 后使用）；
- `metadata["_last_summary"]` — 落盘持久化（冷路径，进程重启后仍能恢复）。

### 4.5 与 ContextGovernor 的正交对比

| 维度 | ContextGovernor | AutoCompact |
|---|---|---|
| 时机 | 每次调 LLM 前（同步、阻塞） | TTL 到期后（异步、后台） |
| 触发 | 超预算才动 | 空闲机会性 |
| 作用对象 | 副本（临时） | **档案本身**（`Session.messages` 真变短，`last_consolidated` 推进） |
| 摘要粒度 | 一条 tool_result → 一句话 | 一段对话 → 一段自然语言摘要 |
| 位置 | 塞回原槽位 | 作为 `session_summary` 拼进 system prompt 尾部 |
| 摘要谁做 | 无（就地截断/落盘） | 调 LLM 让 `Consolidator` 生成，同时喂给 Dream 写 memory |

**架构意义**：AutoCompact 让 ContextGovernor 只需处理"本轮 turn 内的溢出"，把长期问题（session 历史膨胀）交给后台异步处理。而且摘要不只是省 token——同一次巩固还把老对话的关键事实沉淀到 `MemoryStore`，下次 `build_system_prompt` 第④段自然带上。

## 五、正交辅助 2：ModelRuntimeResolver — 决定用哪个模型

正交在于：**它决定 ContextGovernor 里 `config.provider / model / context_window / max_tokens` 是什么**——tokenizer 算预算靠它，其他层都不知道自己在给谁准备 messages。

### 5.1 存在意义

把"当前默认 runtime"从 AgentLoop 里剥出来（[model_runtime.py:14](../nanobot/agent/model_runtime.py#L14)），让 command handler / SDK / tool admission 层能读写它而不用碰 loop 私有字段。

### 5.2 核心设计：resolve vs select 二分

| 方法族 | 语义 | 用途 |
|---|---|---|
| `resolve_snapshot / resolve_preset / resolve_override` | 只解析，返回一次性 runtime，**不改默认** | SDK per-run override |
| `select_preset / select_model / select_context_window / adopt_snapshot` | 改默认，未来所有 turn 都用新的 | `/model` 命令 |
| `refresh` | 从 `_provider_snapshot_loader` 拉最新配置，用 `default_selection_signature` 比对；未改就 no-op，改了就热切 | 配置文件在跑时被改 |
| `_refresh_provider_generation` | 只有默认 runtime 跟着 provider 走时才同步 generation 配置 | 避免选定 preset 后被 provider 层默认覆盖 |

两条路径清晰不打架：一次性覆盖走 `resolve_*`，永久切换走 `select_*`。

### 5.3 `model_presets.py` 5 个静态函数

| 函数 | 作用 |
|---|---|
| `configured_model_presets(config)` | 合并 `config.model_presets` + `resolve_default_preset()`，key `"default"` 恒存在 |
| `make_preset_snapshot_loader` | 返回 `str → ProviderSnapshot` 懒加载器 |
| `build_static_preset_snapshot` | 不换 provider，只改 model/generation 的静态 snapshot |
| `build_runtime_preset_snapshot` | 优先走 loader（能换 provider），否则 static |
| `normalize_preset_name` | 校验存在，报可用清单 |

## 六、两条数据流总览

### 冷启动（新 turn 首次调 LLM）

```
InboundMessage
  → _state_restore  → SessionManager.get_or_create(key)
                    → AutoCompact.prepare_session → 拿到可选 session_summary
  → _state_compact  → 少数场景同步触发一次 archive
  → _state_build    → Session.get_history(max_messages, max_tokens, extend_to_user)
                    → ContextBuilder.build_system_prompt / build_messages
                    → initial_messages 塞入 AgentRunSpec
```

### turn 内（每轮调 LLM）

```
AgentRunner._run_core 每轮:
  messages_for_model = ContextGovernor.prepare_for_model(
      config, current_messages, compacted_tool_call_ids   # config 由 ModelRuntimeResolver.current() 派生
  )
  → _request_model(messages_for_model, ...)
  → 追加 assistant + tool_result 到 current_messages（不动 config，不动档案）
```

## 七、一句话总结

> **模块 2 = 一条"档案 → 首轮快照 → 每轮治理"的 3 层流水线，加两个正交辅助（AutoCompact 后台瘦身、ModelRuntimeResolver 模型热切）。铁律是所有下游变形只在副本上做，档案 `Session.messages` 只增不改。压缩就两招：单条太大落盘换路径、老结果摘一句话、还超就从尾部整段砍；AutoCompact 则是把"长期膨胀"提到后台异步做，让 ContextGovernor 只管当轮溢出。**
