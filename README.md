# mini-agent 🤖

A minimal AI agent framework for learning, inspired by [nanobot](../nanobot).

**Goal**: implement the core mechanisms of an agent framework (agent loop, tool system, MCP, session memory, context compaction) in ~1500 lines of TypeScript, with each module mappable back to its nanobot counterpart.

文档全部在 [`doc/`](./doc) 目录下：
- [`doc/plan.md`](./doc/plan.md) — 两天实施计划
- [`doc/list.md`](./doc/list.md) — nanobot 完整模块清单 + MVP 取舍
- [`doc/dev-logs/step-*.md`](./doc/dev-logs) — 每个步骤完成后的回顾笔记

## Quick start

```bash
pnpm install
cp .env.example .env
# 在 .env 里填上：
#   ANTHROPIC_API_KEY=...
#   ANTHROPIC_BASE_URL=...     # 可选，自定义网关
#   ANTHROPIC_MODEL=...        # 可选，覆盖默认模型
pnpm dev chat
```

启动后输入 `/exit` 退出，`/clear` 清空历史。

### 常用选项

```bash
# 流式输出（默认）vs 非流式
pnpm dev chat
pnpm dev chat --no-stream

# 指定会话（每个 session 一个 JSON 落盘到 sessions/）
pnpm dev chat --session work
pnpm dev chat --session personal

# 不持久化（一次性）
pnpm dev chat --no-persist

# 指定工作目录
pnpm dev chat --workspace /tmp/some-project

# 接 MCP servers
pnpm dev chat --mcp-config ./mcp.example.json

# 调上下文压缩阈值
pnpm dev chat --compact-threshold 16000
```

## Status

✅ **Day 1 + Day 2 完成**：

```
> 请读 package.json，告诉我项目名
  ⚙ read_file({"path": "package.json"})
项目名是 mini-agent。
[steps=2 in=5791 out=17]
```

完整功能：流式输出、工具调用（read_file / write_file / bash）、并发批次、消息总线解耦、会话持久化、MCP 客户端、自动上下文压缩。

按步骤的实施记录见 `doc/step-*.md`。
