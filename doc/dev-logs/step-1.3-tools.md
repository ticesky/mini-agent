# 步骤 1.3 — 三个工具：read_file / write_file / bash

> 对应 plan.md 的 Day 1 第 3 步。第一次写"真正的工具"，验证步骤 1.2 的抽象到底是否够用。

## 目标

实现三个最常用的工具，让 agent 在 Day 1 结束时能"读项目里的文件、改文件、跑 shell 命令"。

## 交付清单

```
src/tools/
├── readFile.ts    ≈ 50 行 — 读文本文件，限制在 workspace 内
├── writeFile.ts   ≈ 40 行 — 覆盖写文件，自动建父目录
└── bash.ts        ≈ 65 行 — 执行 shell 命令，超时 60s
```

## 三个工具的设计共性

### 1. workspace 边界

read / write 都在执行前做了一个安全检查：

```ts
const abs = isAbsolute(path) ? resolve(path) : resolve(ctx.workspace, path);
const rel = relative(ctx.workspace, abs);
if (rel.startsWith("..") || isAbsolute(rel)) {
  return `Error: path '${path}' is outside the workspace ...`;
}
```

这是**最低限度的越界保护** —— 防止 LLM 一时上头去读 `~/.ssh/id_rsa` 或写到 `/etc`。
对应 nanobot 的 `agent/tools/path_utils.py`，但它做了更多（符号链接展开、case-insensitive 平台处理等），我们这版够用。

> bash 工具刻意**不**做路径限制 —— 因为 shell 命令本身可以做任何事。
> 这意味着：**给 LLM 开 bash 等于把整个用户权限交出去**。
> MVP 没有沙箱，**只能在你信任的本地机器跑**。生产环境必须补 sandbox（macOS sandbox-exec / Linux bwrap / Docker / Firecracker），nanobot 的 `tools/sandbox.py` 是参考。

### 2. 错误一律字符串返回

注意三个工具的所有失败路径都不抛异常，全部 `return "Error: ..."`。
配合步骤 1.2 registry 里 `if (out.startsWith("Error"))` 的判断，会自动追加`[请分析上面的错误并尝试不同的方法。]` 提示语。

这是上一步设计的"错误回填"机制第一次真正生效。

### 3. 输出大小有上限

| 工具 | 上限 | 超出处理 |
|---|---|---|
| read_file | 200 KB | 截断 + 提示原始大小 |
| bash | 100 KB | 截断 + 提示原始大小 |

防止 LLM 误读一个 GB 级 log 文件把上下文撑爆。
对应 nanobot 也做了类似截断（`shell.py` / `filesystem.py`），但加了更精细的"按行截断 + 保留尾部"逻辑。

### 4. readOnly 标志怎么用

```ts
readFileTool:  readOnly: true     // 可与其他只读工具并发
writeFileTool: readOnly: false    // 写工具串行执行
bashTool:      readOnly: false    // 命令可能有副作用，串行
```

这个字段下一步在 runner.ts 里会真正生效：read-only 的 tool_call 会被 `Promise.all` 并发，写工具串行。
对应 nanobot 的 `Tool.read_only` / `concurrency_safe`（base.py:154-167）。

## 单工具差异点

### read_file 的简化

nanobot 的 `ReadFileTool` 还做了：
- offset/limit 切片（让 LLM 读大文件的一部分）
- file_state 跟踪（"读过哪些文件"作为后续 edit 的前置条件）
- 二进制识别 + base64
- 行号前缀

我们都没做。MVP 第一版让 LLM 用 `bash head/tail` 替代切片，其他暂时不需要。

### write_file 的简化

nanobot 的 `WriteFileTool` 要求：
- 写之前必须先 `read_file` 过（防止覆盖未读过的内容）
- atomic write（写到 temp + rename + fsync）

我们当前都没做。**atomic write** 这一招会在步骤 2.3（session 持久化）里用到 —— 那里更需要它。
"必须先 read 过"这条是 Claude Code / Cursor 风格的安全策略，MVP 暂不抄。

### bash 的简化

```ts
const result = await execa("bash", ["-c", command], {
  timeout: DEFAULT_TIMEOUT_MS,
  reject: false,    // 非 0 退出码不抛异常
  all: true,        // 合并 stdout + stderr
});
```

`reject: false` + `all: true` 是 execa 的两个甜蜜点：
- 非 0 退出不抛异常 → 我们自己拼 `[exit=N]` 给 LLM 看
- 合并输出 → 不用分别处理 stdout/stderr 两个流

nanobot 的 `tools/shell.py` 多做了：
- 持久 shell session（`exec_session.py`）—— 多次调用之间 cwd / env 保留
- PTY 模式（运行交互式程序如 `python` REPL）
- 后台任务 + 状态查询
- 沙箱集成

这些都是真在生产用 agent 跑命令时被坑出来的需求，MVP 都不做。

## 跟 nanobot 的差异表

| 工具 | nanobot 文件 | 我们砍掉的功能 |
|---|---|---|
| read_file | `tools/filesystem.py` | offset/limit、file_state 跟踪、二进制识别、行号前缀 |
| write_file | `tools/filesystem.py` | 必须先 read 过、atomic write、edit/diff 模式 |
| bash | `tools/shell.py` + `exec_session.py` | 沙箱、持久 session、PTY、后台任务 |

## 验证

跑了一组手工 smoke test（已删除测试文件），结果：

```
=== read existing file ===
hello world

=== read missing file ===
Error reading 'nope.txt': ENOENT: no such file or directory, open '...'
[请分析上面的错误并尝试不同的方法。]

=== read outside workspace ===
Error: path '../../../etc/hosts' is outside the workspace '/tmp/...'.
[请分析上面的错误并尝试不同的方法。]

=== write a new file ===
Wrote 10 characters to out/note.md.

=== verify write via read ===
from agent

=== bash echo ===
hi from mini-agent-smoke-pUj7TS
[exit=0]

=== bash failing command ===
ls: /no/such/path: No such file or directory
[exit=1]
```

注意：bash 失败的命令 stderr 不以 "Error" 开头，所以**不会触发**registry 的提示语 —— 这是对的。
LLM 应该自己看 `[exit=1]` 判断成功失败，而不是把所有 stderr 都当 agent 错误。

## 下一步

**步骤 1.4 — Provider 抽象 + Anthropic 实现（非流式）**（≈ 200 行）：
- `src/providers/base.ts` —— `BaseProvider` 抽象、`chat()` 接口、错误归一
- `src/providers/anthropic.ts` —— 用 `@anthropic-ai/sdk` 实现 `chat()`，把 messages/tools 翻译成 Anthropic 格式

第一次跑通"我们的类型 ↔ Anthropic API"的双向翻译。
