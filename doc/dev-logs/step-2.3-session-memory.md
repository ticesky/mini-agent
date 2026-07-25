# 步骤 2.3 — 会话历史持久化

> 对应 plan.md 的 Day 2 第 3 步。让 agent 能"记住"上一次的对话。

## 目标

退出 mini-agent 再启动，能继续上次的对话上下文。新增 `--session <id>` 选项，每个 session 一个 JSON 文件落盘。

## 交付清单

```
src/session/memory.ts    ≈ 130 行 — SessionStore 类
src/index.ts             接线：SessionStore.load + scheduleSave + saveNow
sessions/                运行时生成（已 gitignore）
```

## 关键设计

### 1. 一个 sessionId 一个 JSON 文件

```
sessions/
├── default.json
├── coding.json
└── support-1234.json
```

文件结构：

```json
{
  "version": 1,
  "sessionId": "default",
  "updatedAt": "2026-06-19T01:23:45.678Z",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "...", "toolCalls": [...]},
    {"role": "tool", "content": "...", "toolCallId": "...", "name": "..."}
  ]
}
```

`version: 1` 字段是预留的——格式变了就改成 2，loader 里加分支处理迁移。MVP 永远用 1。

### 2. 原子写：tmp + fdatasync + rename

```ts
async saveNow() {
  const tmp = `${this.file}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(json, "utf8");
    await fh.datasync();        // ← 关键：强制把 page cache 刷到磁盘
  } finally {
    await fh.close();
  }
  await rename(tmp, this.file);  // ← 关键：rename 是原子的
}
```

为什么需要这套？两个失败场景：
- **进程崩溃**：直接 `writeFile` 时进程被杀，文件可能只写一半。下次启动 `JSON.parse` 报错，丢失整个会话。
- **断电**：`writeFile` 返回 ≠ 数据真的在磁盘上，可能只在 OS 的 page cache。断电后文件回到旧状态或半截状态。

正确的写法（也是 nanobot `agent/memory.py` 用的）：
1. 写到 `*.tmp` 临时文件
2. `fdatasync()` 强制刷盘（仅刷数据，比 `fsync` 快，对我们的 JSON 已经够）
3. `rename` 原子地把 tmp 替换原文件——POSIX 保证 rename 要么成功要么失败，没有"半截状态"

崩溃后无非两种结果：
- 旧文件还在（还没 rename）→ 下次启动从旧文件加载，丢最近这一次写的内容
- 新文件就位（已 rename）→ 完整数据

**永远不会出现半截 JSON 解析失败的情况。**

### 3. 节流写入（debounce）

```ts
scheduleSave() {
  if (this.flushTimer) clearTimeout(this.flushTimer);
  this.flushTimer = setTimeout(() => {
    this.flushTimer = null;
    this.saveNow().catch(...);
  }, this.debounceMs);
}
```

原因：用户连续输入时，每个 turn 都立即落盘的话，硬盘会被频繁写。改成 200ms 内的写入合并：

```
user 输入 → handleTurn → scheduleSave (start timer 200ms)
user 又输入 → handleTurn → scheduleSave (cancel + restart timer)
... (200ms 内 5 个 turn 共享 1 次写盘)
timer 触发 → saveNow
```

退出前必须 `await store.saveNow()` 一次，确保 timer 还没触发的最新状态也落盘。

### 4. 损坏文件容错

```ts
try {
  const raw = await readFile(file, "utf8");
  const data = JSON.parse(raw) as PersistedSession;
  if (data.version === 1 && Array.isArray(data.messages)) {
    messages = data.messages;
  }
} catch (e) {
  if (err.code !== "ENOENT") {
    console.warn(`[session] 文件解析失败，已忽略`);
  }
}
```

文件坏了不抛异常、不阻塞启动。仅打印警告。下次正常 turn 后会被覆盖。
对照 nanobot：`agent/memory.py` 的 `_safe_load` 是同样思路。

### 5. 接到 index.ts 的接线

```ts
// 加载或新建
const store = await SessionStore.load({
  dir: opts.sessionDir,
  sessionId: opts.session,
  initialMessages: [{ role: "system", content: SYSTEM_PROMPT }],
});
const messages = store.messages;   // 直接用它内部的数组

// 每轮结束节流保存
runAgentLoop({
  handleTurn: async (msg) => {
    messages.push({ role: "user", content: msg.text });
    const result = await runTurn({ ... });
    store.scheduleSave();             // ← 这里
    return { text: result.final.content, result };
  },
});

// 退出前 flush
await store.saveNow();
```

注意 `store.messages` 跟 runner 看到的是**同一个数组引用**——runner push 进去的消息直接写到 store 的内部数组。没有"同步内存→store"的额外步骤。

## 验证

实测跨进程会话保留：

**第一次跑**：
```
$ pnpm dev chat
session: default (sessions/default.json, 0 条历史)
> 我叫张三，请记住。
好的，已记住，你叫**张三**。
```

**退出再启动**：
```
$ pnpm dev chat
session: default (sessions/default.json, 2 条历史)
> 我叫什么？
你叫**张三**。
```

落盘文件：
```
$ ls sessions/
default.json
```

不同 session 之间互不影响：
```
pnpm dev chat --session work       # → sessions/work.json
pnpm dev chat --session personal   # → sessions/personal.json
```

`/clear` 命令会清空历史并立即落盘（保留 system prompt）。

## 跟 nanobot 的差异

| 议题 | nanobot 做法 | mini-agent 做法 |
|---|---|---|
| 文件布局 | 每 session 一个 JSON | 一致 |
| 原子写 | tmp + fsync + rename | 一致（用 fdatasync，更快一点） |
| Dream 两阶段 | 短期 working memory + 长期巩固 | 砍掉 |
| TTL 自动清理 | 有 | 砍掉 |
| 并发锁 | filelock | 砍掉（MVP 不允许同 session 多进程） |
| sessionId 规则 | channel + user + ... 拼接 | 直接 CLI 写死 "default" |
