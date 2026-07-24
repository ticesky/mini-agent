# 07 — `agent/memory.py`：MemoryStore + Consolidator 完整解读

> nanobot 记忆系统比 mini-agent **复杂了一个量级**。这一篇把整个 `memory.py`（1049 行）讲完：
> 上半部 MemoryStore（文件 I/O 层）+ 下半部 Consolidator（压缩调度层）。

## 全文结构

```python
# memory.py 的两个类：
class MemoryStore:    # 行 41-622 ─── 纯文件 I/O 层
class Consolidator:   # 行 624-1048 ── 压缩 + 归档调度层
```

两层职责切得很干净：
- **MemoryStore** = "数据持久化"——读写 SOUL/USER/MEMORY/history
- **Consolidator** = "数据生命周期"——决定何时用 LLM 压缩、压缩多少

<!-- chunk-marker -->

## 上半部：MemoryStore

### 五个文件 / 两个游标的全景

```
workspace/
├── SOUL.md                ← Agent 自己写给自己的"灵魂档案"：长期价值观/风格
├── USER.md                ← Agent 对 user 的画像：用户是谁、偏好什么
└── memory/
    ├── MEMORY.md          ← 长期事实库：用户记住的具体事实/约定
    ├── history.jsonl      ← 完整对话流水（append-only，每条一行 JSON）
    ├── .cursor            ← 流水自增 ID（每 append 一条 ++）
    └── .dream_cursor      ← Dream 任务"上次处理到第几条"的水位线
```

### 三个 markdown 文件的语义分层

这三个文件 Agent 自己都能读写（通过工具）。**语义分层才是精华**：

| 文件 | 写入者 | 读取者 | 内容性质 | 例子 |
|---|---|---|---|---|
| `MEMORY.md` | Dream 任务 | LLM 每次请求 | **客观事实** | "用户的项目叫 mini-agent" |
| `USER.md` | Dream 任务 | LLM 每次请求 | **用户画像** | "用户是前端开发，懂 Node" |
| `SOUL.md` | Dream 任务 | LLM 每次请求 | **Agent 性格** | "我倾向于先给具体例子再讲原理" |

→ **三层正交**：
- 同一份事实可以服务任何用户（MEMORY）
- 同一个用户对不同事实有不同偏好（USER）
- 同一个 agent 对所有用户都有自己的风格（SOUL）

这种切分方式不是凭空想的——是从"Anthropic 的 Constitutional AI"和"Character.AI 角色 prompt"演化来的工程实践。

### 为什么不合并成一个 PROMPT.md

合并的话有两个问题：

1. **粒度无法独立修改**：用户换了，USER.md 应该重写，但 SOUL 不变；事实变了，MEMORY 应该改但 USER 不变
2. **prompt cache 会全失效**：三个文件分开拼，改了一个不影响另外两个的 cache 命中

→ 又是"分层缓存"思路：**变化频率不同的内容物理分开**。

### 双游标设计：生产者/消费者位移分离

```python
self._cursor_file = self.memory_dir / ".cursor"              # 生产者位移
self._dream_cursor_file = self.memory_dir / ".dream_cursor"  # 消费者位移
```

**`.cursor` —— 自增 ID 分配器**：

```python
def _next_cursor(self) -> int:
    # 读 .cursor 当前值 → +1 → 写回 → 返回新值
    # 用 _append_lock 保证并发 append 时不重复
```

每 append 一条新 history 就 `+1`，确保每条记录有唯一编号。

**`.dream_cursor` —— Dream 的水位线**：

```python
last_cursor = self.get_last_dream_cursor()           # 比如 87
entries = self.read_unprocessed_history(since_cursor=last_cursor)
# 拿到 88, 89, ..., 当前最新条
# 处理完后 set_last_dream_cursor(最后一条的 cursor)
```

→ 经典的"消费者位移"设计，跟 Kafka consumer offset 一个道理。

#### 为什么需要两个 cursor

物理隔离两个游标：
- 生产者写 `.cursor`（高频）
- 消费者写 `.dream_cursor`（低频，每次 Dream 跑完才更新）
- **完全不竞争**

→ 分布式队列里的标配设计。

### Dream —— 真正的"睡眠巩固"

```python
@staticmethod
def dream_session_key() -> str:
    """Return a unique session key for a Dream run, e.g. ``dream:20260528-100000``."""
    return f"dream:{datetime.now():%Y%m%d-%H%M%S}"
```

Dream 是 nanobot 内部的一个特殊 agent 任务，**模拟人睡觉时大脑整理记忆的过程**：

```
Dream 任务流程：
1. 读 history.jsonl 里 .dream_cursor 之后的新条目
2. 让 LLM 看这些新对话
3. LLM 决定：
   - 哪些是"事实"，写进 MEMORY.md
   - 哪些反映了"用户特征"，更新 USER.md
   - 哪些反映了"我（agent）的行为偏好"，更新 SOUL.md
4. 把 .dream_cursor 推到最新位置
5. 落盘
```

#### Dream 用受限工具集（沙箱 by capability）

```python
def build_dream_tools(self):
    tools = ToolRegistry()
    tools.register(ReadFileTool(...))
    tools.register(EditFileTool(
        workspace=workspace,
        allowed_dir=skills_dir,
        extra_write_allowed_files=[
            self.memory_file,  # MEMORY.md
            self.soul_file,    # SOUL.md
            self.user_file,    # USER.md
        ],
        ...
    ))
```

Dream **只能读 workspace + builtin skills，只能写 SOUL/USER/MEMORY/skills/**。
不能调 bash、不能 fetch web、不能 spawn 主 agent 才能调的危险工具。

→ **沙箱 by capability**：通过工具集限制权限，比 OS 级沙箱轻量得多。

#### Dream session 是 internal

回笔记 04，记得 `_INTERNAL_SESSION_PREFIXES = ("dream:",)` 吗？
**Dream 自己跑的对话不会被 autocompact 回头归档**——避免"Dream 整理记忆这件事本身又被当成新记忆整理"的死循环。

### GitStore：把 Git 当数据库用

```python
self._git = GitStore(workspace, tracked_files=[
    "SOUL.md", "USER.md", "memory/MEMORY.md", "memory/.dream_cursor",
])
```

**MemoryStore 自己跑了一个 git 仓库**，每次写 SOUL/USER/MEMORY 自动 commit。

为什么？给 agent **"撤销"和"审计"能力**：
- 用户发现"昨天的回答怎么这么奇怪" → `git log` 回查 SOUL/USER 那两天的变化
- agent 写错了 MEMORY → `git revert`

→ "边缘扩展用最小改动解决真实问题"的范例：**git 已经存在，把它当数据库用**。
不用造一个 versioned KV 存储，直接 commit 就行。

### append_history 的工程细节

```python
def append_history(self, entry, *, max_chars=None, session_key=None):
    raw = entry.rstrip()
    if len(raw) > limit:
        raw = truncate_text(raw, limit)         # 1. 防 LLM 复读输入
    content = strip_think(raw)                   # 2. 去 <think> 污染
    with self._append_lock:                      # 3. 加锁分配 cursor
        cursor = self._next_cursor()
        ...
```

| 细节 | 解决什么 |
|---|---|
| `truncate_text` | 防 LLM 复读输入，单条记录可能膨胀到几 MB |
| `strip_think` | DeepSeek-R1 / o1 等 reasoning 模型会泄露 `<think>` tag，要清理 |
| `_append_lock` | 多线程时 cursor 分配不能竞争 |

每一条都是**生产 bug 喂出来的**。

### fsync 的"目录同步"细节

```python
# fsync the directory so the rename is durable.
with suppress(PermissionError):
    fd = os.open(str(self.history_file.parent), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
```

文件 fsync 之后，**还要 fsync 父目录**——否则 rename 可能不持久。
mini-agent 的原子写没做这一步。在 ext4 / xfs 上有边界 case。

→ 这种细节属于"99% 场景不重要，1% 场景死人"的代码。

### MemoryStore 跟 mini-agent SessionStore 的对比

| 功能 | mini-agent | nanobot MemoryStore |
|---|---|---|
| 对话历史 JSON 落盘 | ✅ `sessions/<id>.json` 整体 | ✅ `history.jsonl` append-only |
| 原子写（tmp + rename） | ✅ | ✅ |
| 自增游标 / 水位线 | ❌ | ✅ `.cursor` + `.dream_cursor` |
| MEMORY.md 长期事实 | ❌ | ✅ |
| SOUL.md / USER.md 分层 | ❌ | ✅ |
| Git 自动 commit | ❌ | ✅ `GitStore` |
| 旧格式自动迁移 | ❌ | ✅ `_maybe_migrate_legacy_history` |
| 并发安全 | ❌ | ✅ `threading.Lock` + 目录 fsync |

mini-agent 的 SessionStore 130 行 ≈ nanobot MemoryStore 620 行的**很小一部分**——只覆盖 history 持久化。

---

## 下半部：Consolidator（终于讲到压缩了）

### Consolidator 的三个核心方法

```python
class Consolidator:
    async def maybe_consolidate_by_tokens(...)   # 主动压缩（mini-agent compact 对应）
    async def compact_idle_session(...)            # 闲置归档（autocompact 调它）
    async def archive(...)                         # 真正调 LLM 摘要的底层
```

三种触发场景：

```
maybe_consolidate_by_tokens → 主动压缩（每 turn 前在 _state_build 调）
compact_idle_session         → 闲置归档（autocompact 后台调）
archive                       → 上面两个共用的底层："把一段消息 → LLM → 摘要"
```

### archive：真正调 LLM 的底层

```python
async def archive(self, messages, *, session_key=None, summary_messages=None):
    if not messages:
        return None
    messages_to_summarize = summary_messages if summary_messages is not None else messages
    try:
        formatted = MemoryStore._format_messages(messages_to_summarize)
        formatted = self._truncate_to_token_budget(formatted)
        response = await self.provider.chat_with_retry(
            model=self.model,
            messages=[
                {"role": "system", "content": render_template("agent/consolidator_archive.md", ...)},
                {"role": "user", "content": formatted},
            ],
            tools=None,           # ← 摘要任务不给工具
            tool_choice=None,
        )
        ...
        summary = response.content or "[no summary]"
        self.store.append_history(
            summary, max_chars=_ARCHIVE_SUMMARY_MAX_CHARS, session_key=session_key,
        )
        return summary
    except Exception:
        logger.warning("Consolidation LLM call failed, raw-dumping to history")
        self.store.raw_archive(messages, session_key=session_key)
        return None
```

跟 mini-agent `compact.ts` 的 `summarize()` 几乎一样，但多了几个生产细节：

| 细节 | 干什么 |
|---|---|
| `tools=None` | 摘要任务**不给工具**，避免模型分心调工具 |
| `_truncate_to_token_budget` | 输入超过 LLM 自己的 context window 也得先截断 |
| `chat_with_retry` | 临时错误自动重试 |
| `raw_archive` fallback | LLM 失败也得把消息存起来 |

最后一条特别重要：**LLM 不可靠时，原始数据不能丢**。
`raw_archive` 把无法摘要的 chunk 直接 append 到 history.jsonl 当 `[RAW]` 条目，下次 archive 跑的时候可以重试摘要。**永远比"丢了"强。**

### maybe_consolidate_by_tokens：主动压缩的多轮循环

这是真正对应 mini-agent `compact.ts` 的方法。**核心算法**：

```python
async def maybe_consolidate_by_tokens(self, session, replay_max_messages=None):
    if self.context_window_tokens <= 0:
        return

    lock = self.get_lock(session.key)
    async with lock:
        # 0. 先做 replay window 边界检查（独立逻辑，下面讲）
        last_summary = await self._consolidate_replay_overflow(
            session, replay_max_messages,
        )

        # 1. 估算当前 token
        estimated, source = self.estimate_session_prompt_tokens(session)
        if estimated < budget:
            return  # 没超阈值，结束

        # 2. 多轮压缩，最多 5 轮
        for round_num in range(self._MAX_CONSOLIDATION_ROUNDS):
            if estimated <= target:
                break

            # 3. 找一个安全的"切分边界"
            boundary = self.pick_consolidation_boundary(session, max(1, estimated - target))
            if boundary is None:
                break  # 没有合适的边界，放弃

            chunk = session.messages[session.last_consolidated:boundary[0]]
            summary = await self.archive(chunk, session_key=session.key)
            session.last_consolidated = boundary[0]
            self.sessions.save(session)
            if not summary:
                break  # LLM 挂了，停手别 hammer

            # 4. 重新估算，看是不是还要压
            estimated, source = self.estimate_session_prompt_tokens(session)
```

跟 mini-agent 比，多了**5 个关键设计**：

#### 1. `last_consolidated` 游标

```python
session.last_consolidated  # int: 已经压缩过的消息数
```

session 内部有个游标，标记"前 N 条已经被压缩过了"。压缩只动 `[last_consolidated:]` 之后的消息。
mini-agent 每次都从 `messages[1]` 开始切，**重复压**会浪费 LLM 调用。

#### 2. `pick_consolidation_boundary`：在 user 消息处切

```python
def pick_consolidation_boundary(self, session, tokens_to_remove):
    """Pick a user-turn boundary that removes enough old prompt tokens."""
    for idx in range(start, len(session.messages)):
        message = session.messages[idx]
        if idx > start and message.get("role") == "user":
            last_boundary = (idx, removed_tokens)
            if removed_tokens >= tokens_to_remove:
                return last_boundary
        removed_tokens += estimate_message_tokens(message)
    return last_boundary
```

**只在 user 消息处切分**——不能在 `assistant + tool_calls + tool_results` 中间切，否则会留下"orphan tool result"，LLM 看到后会爆。

mini-agent 的 `keepRecent: 6` 是按消息数硬切，没考虑这个。**实际上你已经间接靠"Anthropic 拒绝错误结构"避开了这个 bug**——但要是消息正好切在中间会失败。

#### 3. 多轮循环 `_MAX_CONSOLIDATION_ROUNDS = 5`

```python
for round_num in range(self._MAX_CONSOLIDATION_ROUNDS):
    if estimated <= target:
        break
    ...
```

一轮压缩可能不够（极端情况下 history 太长，单次压缩还是超阈值）。多轮压直到 `estimated <= target` 或 5 轮上限。
mini-agent 是单次压完不再判断——**够用，但极端场景会失败**。

#### 4. `consolidation_ratio = 0.5`

```python
target = int(budget * self.consolidation_ratio)
```

**压一次压到 budget 的 50%**，留 50% 给后续对话。
不直接压到 budget 边缘，否则下一轮还得立刻再压，**抖动严重**。

#### 5. `asyncio.Lock` per session

```python
self._locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()

def get_lock(self, session_key: str) -> asyncio.Lock:
    return self._locks.setdefault(session_key, asyncio.Lock())
```

每个 session 一把锁，防止两个 turn 并发触发压缩 → 重复消耗 LLM。
**`weakref` 让没用的 session 自动释放锁**，不泄漏内存。

mini-agent CLI 串行处理，不需要这个。**多 session 场景必备**。

### Replay window：另一种边界

```python
@staticmethod
def _replay_overflow_boundary(session, replay_max_messages):
    """如果 history 比 replay_max_messages 长，从超出的位置归档。"""
    ...
```

**两种触发归档的边界，nanobot 同时使用**：

| 触发 | 用什么判断 |
|---|---|
| Token 超阈值 | `estimate_session_prompt_tokens` |
| 消息数超 `replay_max_messages` | `_replay_overflow_boundary` |

为什么需要消息数边界？某些 LLM provider 对**单次请求消息数**有上限（不是 token 数）。这种情况下即使 token 没超，消息也要压。

→ **同一个目标（让 prompt 装下）有多个边界条件，分开判断。**
mini-agent 只有 token 一个判断，**遇到 OpenAI 默认 100 条消息上限会爆**。

### compact_idle_session：闲置归档的实现

```python
async def compact_idle_session(self, session_key, max_suffix=8):
    lock = self.get_lock(session_key)
    async with lock:
        self.sessions.invalidate(session_key)
        session = self.sessions.get_or_create(session_key)

        messages_to_summarize = list(session.messages[session.last_consolidated:])
        if not messages_to_summarize:
            return ""

        # 用 retain_recent_legal_suffix 算"应该保留最近的多少条"
        probe = Session(...)
        dropped, already_consolidated = probe.retain_recent_legal_suffix(
            max_suffix, extend_to_user=True,
        )
        messages_to_keep = probe.messages
        messages_to_remove = dropped[already_consolidated:]

        ...
        summary = await self.archive(
            messages_to_remove,
            session_key=session_key,
            summary_messages=messages_to_summarize,  # ← 用全部消息生成 summary，但只删要删的
        )
        ...
        session.metadata["_last_summary"] = {
            "text": summary,
            "last_active": last_active.isoformat(),
        }
        session.messages = messages_to_keep
```

跟 `maybe_consolidate_by_tokens` 比，**关键差异**：

1. **保留固定数量**：保留最近 `max_suffix=8` 条消息（不像 token 触发的版本动态决定）
2. **summary_messages 参数**：让 LLM 看**全部**消息生成摘要，但**只删除**要删除的那些。这样保留的最近 8 条也能在摘要里被引用——给 LLM 提供更连贯的上下文
3. **保存到 session.metadata**：跟 autocompact 配合（笔记 04），让用户回来时能拿到摘要

### `_persist_last_summary`：跟 autocompact 的接口

```python
def _persist_last_summary(self, session, summary):
    if summary and summary != "(nothing)":
        session.metadata["_last_summary"] = {
            "text": summary,
            "last_active": session.updated_at.isoformat(),
        }
        self.sessions.save(session)
```

**Consolidator 跟 AutoCompact 的对接点就这一个 metadata 字段**：

```
Consolidator (maybe_consolidate_by_tokens / compact_idle_session)
  ↓ 写
session.metadata["_last_summary"]
  ↑ 读
AutoCompact.prepare_session
  ↑ 读
loop.py._state_compact
```

→ "上下游通过共享数据结构耦合，不直接调用对方"。这是**整洁分层架构**的范例。

## Consolidator vs mini-agent compact 完整对比

| 设计 | mini-agent | nanobot |
|---|---|---|
| 触发时机 | turn 后 | turn 前（`_state_build`） |
| 触发判断 | token 超阈值 | token 超阈值 + 消息数超 replay_max_messages |
| 压缩游标 | 没有，每次从头切 | `session.last_consolidated` 标记 |
| 切分边界 | 按消息数硬切（`keepRecent`） | 在 user 消息处切（避免 orphan tool_result） |
| 多轮压缩 | 单次 | 最多 5 轮直到 ≤ 50% budget |
| LLM 失败处理 | 抛异常 | `raw_archive` 兜底 + 重试 |
| 并发保护 | 无 | per-session `asyncio.Lock` |
| 接口契合上下游 | 无（独立模块） | metadata `_last_summary` 跟 autocompact 对接 |

每个差异都对应一个**真实生产场景**：
- token 准但有 provider 消息数限制 → 需要双触发
- 多 turn 重复压 → 需要 last_consolidated 游标
- 切到 tool_use 中间 → 需要 user 边界
- 单次压不够 → 需要多轮 + 5 上限
- LLM 挂了 → 需要 raw_archive
- 多 session 并发 → 需要锁
- 跟 autocompact 配合 → 需要 metadata 接口

## 全文一句话总结

> **mini-agent 的 SessionStore + compact = "对话录音机 + 简单摘要器"**。
> **nanobot 的 MemoryStore + Consolidator = "录音机 + 笔记本（SOUL/USER/MEMORY）+ 整理员（Dream）+ 时光机（Git）+ 多策略压缩器"**。
>
> 关键设计：
> - 文件分层（SOUL/USER/MEMORY）= 让 prompt 能按变化频率分别 cache
> - 双 cursor（.cursor / .dream_cursor）= 生产者消费者位移分离，避免锁竞争
> - Dream 受限工具集 = 沙箱 by capability
> - GitStore = 用 git 当版本数据库
> - `last_consolidated` 游标 = 增量压缩，避免重复消耗 LLM
> - `pick_consolidation_boundary` 在 user 处切 = 避免 orphan tool_result
> - 多轮压缩 + 50% target = 防抖动
> - `raw_archive` fallback = LLM 不可靠也不丢数据
> - `_locks` per session = 多 session 并发保护
> - `_last_summary` metadata = 跟 autocompact 通过共享数据结构耦合

## 给读 nanobot 的检查清单

读到任何一个"记忆相关"的代码，问自己：

1. **它读/写哪个文件？** → 决定它属于哪个语义层（事实 / 用户 / 性格）
2. **它在主进程还是 Dream 进程？** → Dream 任务受限工具集
3. **它依赖哪个 cursor？** → 生产者用 `.cursor`，消费者用 `.dream_cursor`
4. **它在 MemoryStore 还是 Consolidator？** → 文件 I/O 还是 LLM 调度
5. **它压缩的游标怎么管？** → `session.last_consolidated`
6. **它怎么决定切在哪？** → `pick_consolidation_boundary` + replay overflow

## 可以抄回 mini-agent 的 4 个改造

按学习收益排序：

| 改造 | 工作量 | 价值 |
|---|---|---|
| 加 `last_consolidated` 游标 | 30 分钟 | 增量压缩，避免每次从头压 |
| 加 user 消息边界切分 | 30 分钟 | 避免极端场景下 tool_result orphan |
| 加 `raw_archive` fallback | 1 小时 | LLM 失败时不丢历史 |
| 加 SOUL/USER/MEMORY 三层 | 半天 | 自我学习能力的基础 |

前三个都是 "minimal effort big return"。第四个是大改造，但做完你就拥有了"会自我改进的 agent"——值得。
