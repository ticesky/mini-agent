# 模块 3 · 记忆系统

模块 2 的 `Session.messages` 是"turn 级"的：装不下就丢。用户偏好、稳定事实、agent 自身的人格设定这些**跨 session 应该活着**。模块 3 就是这层"活得比 session 长"的存储。

## 一、三级存储 · 单向下沉

```
                Consolidator (LLM 摘要)          Dream subagent (LLM 编辑)
sessions/{key}.jsonl ─────────────▶ memory/history.jsonl ─────────────▶ SOUL.md / USER.md / MEMORY.md
   (turn 级)                           (事件断片)                          (长期身份/事实)
```

| 层 | 文件 | 生命周期 | 谁写 | 谁读 |
|---|---|---|---|---|
| 一级：session | `sessions/{key}.jsonl` | 每 session 一份，AutoCompact/Consolidator 会砍 | AgentRunner 追加 | `Session.get_history` |
| 二级:事件断片 | `memory/history.jsonl` | append-only，超 `max_history_entries(=1000)` 才砍旧 | `Consolidator.archive` / `MessageTool` | `build_system_prompt` 的 recent_history 段 + Dream |
| 三级:长期身份 | `SOUL.md` / `USER.md` / `memory/MEMORY.md` | 永久，git 版本管理 | **只有 Dream agent 能编辑** | `build_system_prompt` 的 identity / bootstrap / memory 段 |

**级联规则**：数据只**单向下沉**，从不回写。session 老消息 → Consolidator 摘要成一条断片写进 history.jsonl → Dream 定期消化 history.jsonl → 编辑 SOUL/USER/MEMORY。

**关键澄清**：`Session.get_history` 读的是**一级** session 消息切片，从头到尾**不看 `memory/history.jsonl`**。两个"history"同名不同物。

## 二、`MemoryStore`：纯文件 I/O 层

### 2.1 文件布局

```
workspace/
├── SOUL.md              # agent 自我认知（Dream 可编辑）
├── USER.md              # 用户稳定事实（Dream 可编辑）
└── memory/
    ├── MEMORY.md        # 长期记忆索引（Dream 可编辑）
    ├── history.jsonl    # 事件断片流（append-only）
    ├── .cursor          # append cursor 自增计数器
    ├── .dream_cursor    # Dream 已消化到哪个 cursor
    └── HISTORY.md       # 旧格式，_maybe_migrate_legacy_history 迁移
```

**全局共享**：`memory/history.jsonl` 是**每 workspace 一份**、跨所有 session 的单一文件；每条记录用 `session_key` 字段做逻辑分区。真正的隔离边界是 workspace 目录本身。

### 2.2 `append_history` 的三条保证（[memory.py:247](../nanobot/agent/memory.py#L247)）

1. **原子游标+写入**：`threading.Lock` 保护 `_next_cursor()` + 文件 append 的组合——并发写入不会产生重复 cursor；
2. **strip_think 前置**：写入前剥掉 `<think>` / `<channel|>` 模板泄露，防止 replay 时污染上下文；
3. **硬顶截断**：`_HISTORY_ENTRY_HARD_CAP` 兜底防止 caller 忘记自己的 cap。

每条记录 shape：`{cursor, timestamp, content, session_key?}`。

### 2.3 落盘策略

| 文件 | 策略 | 原因 |
|---|---|---|
| `history.jsonl` append | `open("a")` + `_append_lock` | 高频、小步、并发；靠内存锁序列化 |
| `history.jsonl` 覆盖写（`compact_history`） | `.tmp` + `fsync(fd)` + `os.replace` + `fsync(dir)` | 低频、整体重写；要原子替换 |
| `.cursor` / `.dream_cursor` | `write_text`（简单覆盖） | 是**缓存**不是唯一真相，崩溃可从 jsonl 恢复 |
| SOUL/USER/MEMORY | `write_text` | Dream 是**单例串行**运行，无并发 |

## 三、两个游标：`cursor` 与 `dream_cursor`

**它们不是行号，是永不复用的自增 ID**。物理上是 `memory/.cursor` 和 `memory/.dream_cursor` 两个单数字文件。

| 游标 | 语义 | 谁自增 |
|---|---|---|
| `cursor` | 下一条 append 用的 ID；单调递增水位 | `MemoryStore.append_history`（每写一条 +1） |
| `dream_cursor` | Dream 已消化到哪 | Dream 跑完且**过门槛**后手动 `set_last_dream_cursor` |

**两者差集 = 待消化队列**：`read_unprocessed_history(dream_cursor)` 返回 `cursor > dream_cursor` 的所有记录。

### 3.1 `append_history` 的三步原子性

```python
with self._append_lock:
    cursor = self._next_cursor()                # ① 读 .cursor 并 +1
    file.write(json.dumps(record) + "\n")       # ② 写 history.jsonl
    self._cursor_file.write_text(str(cursor))   # ③ 更新 .cursor
```

**崩溃恢复**：`.cursor` 是缓存，jsonl 里的 cursor 字段才是真相。`_next_cursor` 在 `.cursor` 缺失/损坏时会走 `_read_last_entry` 扫 jsonl 最后一条推算。

### 3.2 Dream 推进 cursor 的两道门槛

Dream 跑完**不是无条件推进 dream_cursor**：

```python
# 门槛 A：turn 是否正常完成
if not MemoryStore.dream_run_completed(resp):
    return   # stop_reason != "completed" → 不推进

# 门槛 B：磁盘 diff 是否非空
diff = store.dream_content_diff()   # 检查 SOUL/USER/MEMORY 的工作树 diff
if not diff.strip():
    return   # LLM 声称"我更新了"但实际没写 → 不推进

# 两道都过才推进
store.set_last_dream_cursor(new_cursor)
```

### 3.3 为什么 `_DREAM_CONTENT_PATHS` 故意不含 `.dream_cursor`

```python
_DREAM_CONTENT_PATHS = ("SOUL.md", "USER.md", "memory/MEMORY.md")
# 故意不包括 memory/.dream_cursor
```

反证：若包括了 `.dream_cursor`，则**推进 cursor 本身就是一次 diff**——`dream_content_diff()` 永远非空，"空跑也被记账"。下轮就永远不会重试这批未消化的事件了，事件将被永久丢弃。

排除后：cursor 的推进**只反映"SOUL/USER/MEMORY 里真的写了东西"**，跟 cursor 自身的写入完全解耦。

### 3.4 `compact_history` 与 cursor 的关系

`compact_history` 超过 `max_history_entries=1000` 会砍最旧记录——**但 cursor 不重编号**。`.cursor` 仍然是最大的那个，dream_cursor 语义永远稳定。

代价：若 Dream 落后到 cursor=100 而砍了 100~499，这批**永久丢失**。实际部署要把 `max_history_entries` 设得远大于 Dream 消化频率。

## 四、`Consolidator`：token 预算触发的摘要

session 太长了怎么办的**主动路径**（被动路径是 ContextGovernor 就地摘 tool_result）。

### 4.1 两个入口 · 共享一把锁

| 入口 | 触发者 | 场景 |
|---|---|---|
| [`maybe_consolidate_by_tokens`](../nanobot/agent/memory.py#L971) | AgentLoop `_state_save` 后 | 当前 session prompt 估算超预算 → 循环摘要老消息直到降回 `budget × consolidation_ratio(=0.5)` |
| [`compact_idle_session`](../nanobot/agent/memory.py#L1114) | AutoCompact | TTL 过期空闲 session → 硬截尾，只保 8 条尾巴 |

两条路径共用 `get_lock(session_key)` 拿到的 `asyncio.Lock`——保证同一 session 状态永远只有一个 mutator。

### 4.2 主路径循环（`maybe_consolidate_by_tokens`）

```
estimate_session_prompt_tokens(session, runtime)      # 用 _build_messages 拼探针 prompt 估
  │
  ├─ estimated < budget → done
  │
  └─ estimated > budget → 循环最多 _MAX_CONSOLIDATION_ROUNDS(=5) 轮：
       ① pick_consolidation_boundary(session, tokens_to_remove)
             扫消息累加 tokens，找到 user turn 边界使累加 >= tokens_to_remove
       ② archive(chunk, runtime)
             → 调 LLM 摘要 → append_history(session_key=…)
             → LLM 挂了走 raw_archive 兜底（[RAW] 明文 dump）
       ③ session.last_consolidated = end_idx；sessions.save(session)
       ④ 重估 tokens，仍超预算再来一轮
```

**三个关键细节**：

- **必须在 user turn 边界切**：不能把 assistant+tool_result 序列砍成两半，否则剩下的会变成孤儿被 ContextGovernor 再清一遍；
- **失败也推进 cursor**：`archive` 走 raw_archive 兜底后 `last_consolidated` 仍前进——避免下轮又把同一批 raw dump 产生重复 `[RAW]`；
- **`_persist_last_summary`**：最后一次成功的 summary 落到 `session.metadata["_last_summary"]`——下 turn AutoCompact.prepare_session 会读它拼进 system prompt 的 `session_summary` 段。

### 4.3 空闲路径（`compact_idle_session`）

```
1. sessions.invalidate(session_key)   # 强制从磁盘重读
2. probe.retain_recent_legal_suffix(8, extend_to_user=True)  # 模拟切一刀
3. messages_to_remove = 要丢的老消息
   messages_to_summarize = 老消息 + 保留的尾巴（一起给 LLM 看，让摘要有连贯性）
4. archive(messages_to_remove, summary_messages=messages_to_summarize)
5. metadata["_last_summary"] = summary
   session.messages = 保留的尾巴; last_consolidated = 0
```

`summary_messages` 参数的用意：**摘要时看更多上下文，但只归档要丢的**——避免摘要断章取义。

### 4.4 `archive()` 的 LLM 调用（[memory.py:916](../nanobot/agent/memory.py#L916)）

- system prompt = `agent/consolidator_archive.md` 模板；
- 消息展开成 `[timestamp] ROLE [tools: ...]: content` 单行格式；
- `_truncate_to_token_budget` 卡预算避免摘要本身超 context window；
- **不给工具**（`tools=None`）——纯文本进纯文本出；
- 结果 append 到 `history.jsonl` 时 `_ARCHIVE_SUMMARY_MAX_CHARS=8000` 硬顶。

## 五、Dream：把 history.jsonl 消化进长期文件

Dream 不在 `memory.py` 里被完整实现——它是 **agent 自己作为 subagent 跑一轮 turn**。`memory.py` 只提供**能力面**。

### 5.1 MemoryStore 暴露的 5 个能力

| 能力 | 实现 | 用途 |
|---|---|---|
| Dream prompt 构造 | [`build_dream_prompt`](../nanobot/agent/memory.py#L531) | 拼 dream 模板 + SOUL/USER/MEMORY 当前完整内容 + 未处理 history 条目（最多 20 条） |
| 受限工具集 | [`build_dream_tools`](../nanobot/agent/memory.py#L592) | 只 register Read/Edit/ApplyPatch/Write；写权限只对 SOUL/USER/MEMORY 三个具名文件开放；Write 的 allowed_dir 是 `skills/` |
| 专用 session key | [`dream_session_key`](../nanobot/agent/memory.py#L678) | 返回 `dream:20260528-100000`；`_INTERNAL_HISTORY_SESSION_PREFIXES` 会跳过它，避免 Dream 的 history 反哺自己 |
| diff-grounded commit | [`build_dream_commit_message`](../nanobot/agent/memory.py#L683) + [`dream_content_diff`](../nanobot/agent/memory.py#L581) | commit body 是**工作树真实 diff**（`GitStore.summarize_working_tree`），不是 LLM 自述 |
| 完成度判定 | [`dream_run_completed`](../nanobot/agent/memory.py#L635) | 只有 `metadata["_stop_reason"] == "completed"` 才算成功 |

### 5.2 Dream prompt 结构

```
<dream 模板>

## Current Memory Files
### SOUL.md
<当前完整内容 (顶 _DREAM_FILE_EMBED_CAP=8000 字)>

### USER.md
<当前完整内容>

### memory/MEMORY.md
<当前完整内容>

## Conversation History
[10:00] 用户询问北京天气
[10:05] 用户订了 7 月 20 日去上海的机票
...(顶 20 条)
```

**为什么必须嵌入当前文件内容**：让模型对**真实文件**做编辑，而非脑补一个 stale 版本再 patch。没这段模型会 hallucinate 出根本不存在的行然后 patch 失败。

### 5.3 冲突调和只在 Dream 一处发生

- **Consolidator** 写的是"事件流"：时间戳锚定，同一事实的多次描述都留着，不做冲突调和；
- **Dream** 是**唯一的冲突仲裁者**：同时看到"当前信念"（三个文件）和"新事件"（history 条目），由 LLM 决定：
  - 用最新事件覆盖旧信念（"用户 T=1 说住北京，T=2 说搬上海了" → 改成上海）；
  - 保留双方并注明时间（模棱两可时）；
  - 判定新事件不值得写，什么都不改（→ diff 空 → cursor 不推进 → 下轮再来）。

**没有源码规则强制某种冲突策略**——完全靠 LLM 判断力，靠 diff-gate 兜底。

### 5.4 只信 diff 不信自述

两个关键决策都**只看磁盘 diff**：

1. **cursor 推进门槛**：`dream_content_diff()` 非空才推进——LLM 声称"我更新了"但实际没写文件？不推进；
2. **commit message body**：直接用 `summarize_working_tree` 输出，不是 LLM narrative——审计（`/dream-log`）永远反映文件系统真相。

**规则**：LLM 说的不算，文件改了没才算。

## 六、`memory/history.jsonl` 的读取消费者

物理一份文件，但读取时各有过滤规则：

| 消费者 | 是否跨 session | 过滤规则 |
|---|---|---|
| `read_recent_history_for_prompt`（拼 system prompt 的 recent_history 段） | 默认**不**跨 | `entry.session_key == 当前 session_key`；`unified_session=True` 时跨 session 但跳过 `cron:` / `dream:` / `heartbeat` 内部 session |
| Dream（`build_dream_prompt`） | **跨** | 不过滤——长期文件本就全局共享 |
| Consolidator（写入方） | — | 写入时**必带 `session_key`** |

## 七、模块 3 的耦合面

```
                       写入 history.jsonl                 编辑 SOUL/USER/MEMORY
Consolidator ────────────────────────────▶ MemoryStore ◀──────────────────── Dream subagent turn
     ▲                                          │
     │                                          │ get_memory_context / read_recent_history_for_prompt
   session.last_consolidated 前移                ▼
     ▲                                     ContextBuilder ──▶ build_system_prompt 的 memory / recent_history 段
     │
     ├── AgentLoop._state_save 后触发（token 预算路径）
     └── AutoCompact.check_expired 后触发（空闲路径）
```

**唯一耦合点三个**：
1. `session.last_consolidated` 游标 —— 与模块 2 共享；
2. `build_system_prompt` 读 `MemoryStore` —— 与模块 2 ContextBuilder；
3. `session.metadata["_last_summary"]` —— 与 AutoCompact 共享。

## 八、一句话总结

> **模块 3 是一条从 session → history 断片 → 长期文件的单向下沉级联。Consolidator 负责"session 太长把老消息摘成断片"，Dream 作为定期 subagent 消化断片编辑长期文件。核心设计三条：单向下沉不回写、只信文件 diff 不信 LLM 自述、cursor 与 dream_cursor 双游标分离让"空跑不算数"。冲突调和只在 Dream 一处发生，靠 LLM 语义判断 + git diff-gate 兜底。**
