# 04 — `agent/autocompact.py`：多 session 闲置归档

> 全文 96 行，最短的核心模块之一。
>
> **核心警告：跟 mini-agent 的 `compact.ts` 解决的不是同一个问题！**

## 两种"压缩"，搞混了一切都讲不清

```
mini-agent.compact          —— 单 session 压缩：context 太长 → 摘要早期消息
nanobot.autocompact         —— 多 session 调度：闲置太久 → 整个 session 摘要归档
```

| 维度 | mini-agent compact | nanobot autocompact |
|---|---|---|
| 触发 | token 数超阈值 | session 太久没人聊 |
| 范围 | 一个 session 内的部分消息 | 一整个 session |
| 时机 | 一轮对话结束时立刻判断 | 后台定时扫描 |
| 输出 | 替换中间消息成摘要 | 摘要存元数据 + 释放内存 |
| 多 session 感知 | 没有，只有一个 session | 核心需求 |

→ mini-agent 解决的是 **"单 session 太长"**，nanobot autocompact 解决的是 **"很多 session，闲的归档"**。

它对应的"单 session 太长"在 nanobot 里是别的文件（应该在 `runner.py` 的压缩分支或 `agent/memory.py` 的 `Consolidator` 里）。**注意分清。**

## 这个文件的真实任务：闲置 session 归档

想象 nanobot 在跑一个 Slack 机器人，500 个用户每人一个 session：

- 用户 A 5 分钟前还在聊
- 用户 B 6 小时前的对话还在内存里
- 用户 C 3 天前的对话还在内存里

500 个 session 全留内存：
- 每个几万 token 的历史 = 内存爆
- 下次 user A 来对话时 prompt cache 命中 0%（系统消息加了一堆别人的历史背景）

**autocompact 干的事**：

1. 后台定时扫描所有 session
2. 找出闲了超过 TTL 的（默认 0 = 关闭，可配置 60 分钟之类）
3. 调一次 LLM 把那个 session 整体摘要成一段话
4. 把摘要存 session.metadata，把消息清掉
5. 等用户 C 3 天后回来时，把摘要塞回 system prompt，继续聊

→ 这是**资源管理**，不是 context 长度管理。

## 代码导读

### 数据结构

```python
self._archiving: set[str] = set()
self._summaries: dict[str, tuple[str, datetime]] = {}
```

- `_archiving`：**正在归档中的 session key 集合**——防止重复归档（异步操作要时间）
- `_summaries`：**最近一次归档结果的内存缓存**——key→(摘要文本, 最后活跃时间)

### `check_expired` —— 调度入口

```python
def check_expired(self, schedule_background, active_session_keys=()):
    now = datetime.now()
    for info in self.sessions.list_sessions():
        key = info.get("key", "")
        if not key or self._is_internal_session(key) or key in self._archiving:
            continue
        if key in active_session_keys:                  # ← 关键
            continue
        if self._is_expired(info.get("updated_at"), now):
            self._archiving.add(key)
            schedule_background(self._archive(key))
```

被外部定时器周期调用（比如每 60 秒）。**三层过滤**：

1. **internal session 跳过**：`dream:` 开头的内部 session 是 nanobot 自己工具用的，不归档
2. **正在归档的跳过**：异步任务还没完，别开第二个
3. **正在跑的跳过**：`active_session_keys` 是当前**有 turn 在执行**的 session

> 第 3 条是经典 race condition 防御。如果 user A 刚发了一条消息、agent 正在跑 turn，这时候 autocompact 把 A 的 session 归档了，turn 跑完想 push 结果时找不到 session，崩了。

### `_archive` —— 真正干活

```python
async def _archive(self, key: str) -> None:
    if self._is_internal_session(key):
        self._archiving.discard(key)
        return
    try:
        summary = await self.consolidator.compact_idle_session(
            key, self._RECENT_SUFFIX_MESSAGES,
        )
        if summary and summary != "(nothing)":
            session = self.sessions.get_or_create(key)
            meta = session.metadata.get("_last_summary")
            if isinstance(meta, dict):
                self._summaries[key] = (
                    meta["text"],
                    datetime.fromisoformat(meta["last_active"]),
                )
    except Exception:
        logger.exception("Auto-compact: failed for {}", key)
    finally:
        self._archiving.discard(key)        # ← finally 保证一定释放
```

注意三个细节：

1. `consolidator.compact_idle_session()` 是真做摘要的地方——这个文件**只调度**，不实现摘要逻辑（在 `agent/memory.py`）。**职责单一**。
2. `_RECENT_SUFFIX_MESSAGES = 8`：保留最近 8 条不摘要——跟 mini-agent 的 `keepRecent` 同一个思路
3. `try/finally` 中 `_archiving.discard(key)`：**无论成败必须释放锁**，否则这个 key 再也归档不了

### `prepare_session` —— 用户回来时把摘要塞回去

```python
def prepare_session(self, session: Session, key: str) -> tuple[Session, str | None]:
    if self._is_internal_session(key):
        self._archiving.discard(key)
        self._summaries.pop(key, None)
        return session, None
    if key in self._archiving or self._is_expired(session.updated_at):
        # 进程没重启，但本地 session 已被归档过 → 重新加载
        session = self.sessions.get_or_create(key)
    # 热路径：summary 还在内存里
    entry = self._summaries.pop(key, None)
    if entry:
        return session, self._format_summary(entry[0], entry[1])
    # 冷路径：进程重启了，summary 在元数据里
    meta = session.metadata.get("_last_summary")
    if isinstance(meta, dict):
        return session, self._format_summary(meta["text"], datetime.fromisoformat(meta["last_active"]))
    return session, None
```

**热路径 vs 冷路径** 是设计精华：

```
热路径（进程没重启）：
  3 天前 autocompact 归档时，summary 同时存内存 + 元数据
  3 天后用户回来 → 直接从内存 dict 取 → 0 IO

冷路径（进程重启过）：
  内存 dict 是空的
  fallback 到从 session.metadata 读 → 1 次 disk IO
```

→ 高频路径优化的标准模式：**写两遍（内存 + 持久化），读优先内存**。

返回值是 `(session, summary | None)`：
- session：归档过的 session（消息已被清掉，但元数据保留）
- summary：用来拼到 system prompt 里的字符串，提醒 LLM "之前聊过这些"

caller（runner 或 loop）拿到这两个东西后，**把 summary 塞进 messages 头部继续对话**。

## `internal_session` 是什么

```python
_INTERNAL_SESSION_PREFIXES = ("dream:",)
```

`dream:` 是 nanobot 内部用的特殊 session（参考 nanobot Dream 两阶段记忆机制）。
比如 agent 自己跑后台任务、自己跟自己对话做记忆巩固时用的 session，**它不归档自己**——会自己引用自己导致死循环。

→ 边缘代码：**为了让"核心机制不出 bug"加的护栏**。判断"哪个 session 不该被自动管理"。

## 一句话总结

> **autocompact 是"多 session 资源管理"，不是"上下文压缩"。**
>
> 关键设计：
>   - **后台调度** + **三层过滤**（internal / archiving / active）防 race
>   - **热/冷双路径** 减少 IO
>   - **finally 必释放锁** 防泄漏
>   - **职责单一**：只调度，摘要逻辑外包给 Consolidator

## 它的存在意味着什么

> **nanobot 是真的生产级**，要面对"500 个 Slack 用户长期挂着"的场景。
> mini-agent CLI 永远只有 1 个 session，**这一层根本不需要**。

**不需要不是缺点。** 这正好印证 "核心精简，边缘扩展"——
nanobot 把 autocompact 做成可选模块（`session_ttl_minutes=0` 直接禁用），不强加给所有 caller。

## 拓展阅读

回去看一眼 `nanobot/agent/runner.py`，搜一下 `prepare_session`，看它在哪里被调：

```bash
grep -n "prepare_session\|autocompact\|AutoCompact" nanobot/agent/*.py
```

**理解一个模块，看它"上下游"比看它内部更重要。**
