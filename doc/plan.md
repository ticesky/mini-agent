# mini-agent 实施计划

> 用 Node.js + TypeScript 实现一个最小但完整的 AI agent 框架，对照 [nanobot]() 学习 agent 工程的核心机制。

## 学习目标

- Agent loop 的本质（事件循环 vs agent 循环）
- LLM provider 抽象与 SDK 包装
- Tool 系统：定义、注册、参数校验、并发执行、错误回填
- MCP 协议接入
- 会话记忆与历史压缩
- channel ↔ agent 解耦的消息总线

## 工作模式

- **节奏**：两天完成 MVP（A 档 + B 档）
- **协作**：主要由 AI（Ducc）写代码，用户 review 并学习
- **粒度**：每完成一个模块停下来 review，AI 同时给出对照 nanobot 的学习要点
- **风格**：模块小而完整，宁可少不可多。第一版不抄 nanobot 的边缘 case，专注主干

## 技术栈

| 用途 | 选择 | 备注 |
|---|---|---|
| 语言 | TypeScript (strict) | |
| 包管理 | pnpm | |
| Node | 用户当前版本 | ≥ 20 |
| Schema/校验 | zod + zod-to-json-schema | 替代 pydantic |
| Anthropic SDK | `@anthropic-ai/sdk` | 官方 |
| MCP SDK | `@modelcontextprotocol/sdk` | 官方 |
| 进程执行 | `execa` | 比原生 child_process 友好 |
| Token 计数 | `gpt-tokenizer` | 纯 JS，无需编译 |
| 日志 | console（MVP）/ pino（升级） | |
| CLI | commander + readline | commander 管子命令、readline 管交互输入 |

## 范围（确认版）

### A 档 — 必做（MVP 核心）

1. Tool 抽象 + ToolRegistry
2. Provider 抽象 + Anthropic 实现
3. Agent runner（多轮对话 + tool 执行状态机）
4. CLI channel + 入口
5. 三个工具：`read_file` / `write_file` / `bash`

### B 档 — 强烈建议做

6. MessageBus + AsyncQueue
7. 流式响应（Anthropic streaming + tool_call 增量）
8. Session 持久化（原子写 JSON）
9. MCP 客户端
10. 上下文压缩（token 超阈值摘要早期消息）

### C 档 — Stretch（有富余时间才做）

- webFetch 工具
- apply_patch 工具
- OpenAI provider（验证抽象）
- Subagent / Hook（简单版）

### D 档 — 不做

- Sandbox / 多 channel / WebUI / API server
- Cron / Long task / Image / Transcription
- 复杂的 file state 跟踪、goal state、turn continuation
- 插件自动发现

## 目录结构

```
mini-agent/
├── package.json
├── tsconfig.json
├── plan.md
├── README.md
├── .env.example
├── .gitignore
├── src/
│   ├── index.ts                 # CLI 入口
│   ├── types.ts                 # 共享类型
│   │
│   ├── tools/
│   │   ├── base.ts              # Tool 接口 + zod helper
│   │   ├── registry.ts          # ToolRegistry
│   │   ├── readFile.ts
│   │   ├── writeFile.ts
│   │   └── bash.ts
│   │
│   ├── providers/
│   │   ├── base.ts              # BaseProvider 抽象
│   │   └── anthropic.ts         # Anthropic 实现（含流式）
│   │
│   ├── agent/
│   │   ├── runner.ts            # ★ 核心：agent loop 状态机
│   │   └── loop.ts              # bus 消息 → runner 调度
│   │
│   ├── bus/
│   │   └── queue.ts             # AsyncQueue
│   │
│   ├── session/
│   │   ├── memory.ts            # 会话历史持久化
│   │   └── compact.ts           # 上下文压缩
│   │
│   ├── channels/
│   │   ├── base.ts              # Channel 接口
│   │   └── cli.ts               # stdin/stdout
│   │
│   └── mcp/
│       └── client.ts            # MCP 接入
└── sessions/                    # 运行时生成的会话文件（gitignore）
```

## Day 1 — 跑通最小闭环

> 目标：能在终端跟 Claude 对话，Claude 能调 `read_file` / `write_file` / `bash` 三个工具。

| 步骤 | 模块 | 文件 | 行数估计 | 对照 nanobot | 学习重点 |
|---|---|---|---|---|---|
| 1.1 | 项目脚手架 | `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `src/types.ts` | ~120 | `pyproject.toml` | 依赖选型、TS 配置 |
| 1.2 | Tool 抽象 | `src/tools/base.ts`, `src/tools/registry.ts` | ~200 | `agent/tools/base.py`, `registry.py` | zod → JSON Schema、参数校验、registry 模式 |
| 1.3 | 三个工具 | `readFile.ts`, `writeFile.ts`, `bash.ts` | ~120 | `tools/filesystem.py`, `tools/shell.py` | Tool 实现模板 |
| 1.4 | Provider 抽象 + Anthropic（非流式） | `src/providers/base.ts`, `src/providers/anthropic.ts` | ~200 | `providers/base.py`, `providers/anthropic_provider.py` | SDK 调用、消息格式归一、错误分类 |
| 1.5 | **Agent runner** | `src/agent/runner.ts` | ~180 | **`agent/runner.py`** | **多轮对话状态机、tool_call 执行、错误回填** |
| 1.6 | CLI channel + 入口 | `src/channels/cli.ts`, `src/index.ts` | ~120 | `channels/base.py`, `cli/commands.py` | 把所有零件串起来 |

**Day 1 验收**：
```bash
pnpm dev
> 读一下 package.json 然后告诉我项目名
[Claude 调 read_file] → 项目名是 mini-agent
```

## Day 2 — 加深度

> 目标：流式 + MCP + 持久化 + 上下文压缩。

| 步骤 | 模块 | 文件 | 行数估计 | 对照 nanobot | 学习重点 |
|---|---|---|---|---|---|
| 2.1 | 流式响应 | 改 `providers/anthropic.ts` + `runner.ts` | ~150 | `chat_stream` 系列 | SSE 消费、tool_call 增量累积、回调链 |
| 2.2 | MessageBus | `src/bus/queue.ts`, `src/agent/loop.ts` | ~150 | `bus/queue.py`, `agent/loop.py` | AsyncQueue 实现、channel/runner 解耦 |
| 2.3 | Session 持久化 | `src/session/memory.ts` | ~150 | `agent/memory.py` | 原子写（temp + rename + fsync）、按 sessionId 分文件 |
| 2.4 | **MCP 接入** | `src/mcp/client.ts` + 改 `tools/registry.ts` | ~200 | **`agent/tools/mcp.py`** | **MCP SDK 用法、远程 tool 包装成本地 Tool** |
| 2.5 | 上下文压缩 | `src/session/compact.ts` | ~150 | `agent/autocompact.py` | token 估算、保留窗口 + 摘要早期消息 |
| 2.6 | 收尾 | README + 跑通验收 | — | — | — |

**Day 2 验收**：
- 流式输出可见（边生成边显示）
- 跑一个 MCP server（如官方 `filesystem` server），其 tools 能被 agent 调用
- 退出再启动，会话历史还在
- 长对话超过 token 阈值时自动压缩

## 验收标准

### 功能
- [ ] CLI 启动后可与 Claude 对话
- [ ] LLM 能调用 read_file / write_file / bash 工具
- [ ] 工具错误能反馈给 LLM 自我纠错
- [ ] 多个 read-only 工具能并发执行
- [ ] 流式输出可见
- [ ] MCP server 的工具被自动注册并可用
- [ ] 退出重启会话历史保留
- [ ] 超过 token 阈值时早期消息被自动压缩

### 代码质量
- [ ] TypeScript strict 模式下无错误
- [ ] 没有 `any` 滥用（zod 推断类型）
- [ ] 每个核心模块有 1-2 行注释说明对应 nanobot 的哪块
- [ ] README 写清楚怎么跑、各模块在哪

## 不做的事（防止范围蔓延）

- ❌ 不做 WebUI / HTTP API
- ❌ 不做多 channel（只有 CLI）
- ❌ 不做沙箱（bash 工具直接 execa，仅本地受信用）
- ❌ 不做插件自动发现（写死 import）
- ❌ 不做生产级错误处理（只覆盖主要路径）
- ❌ 不抄 nanobot 的边缘 case 兼容代码
- ❌ 不做单元测试（学习项目，手测优先）

## 开干顺序

1. 确认计划（当前）
2. 步骤 1.1 项目脚手架 → 用户 review
3. 步骤 1.2 Tool 抽象 → 用户 review
4. ...依次进行...
5. 每完成一档总结一次

每个步骤完成后，AI 提供：
- 改动的文件清单
- 对应 nanobot 文件的 1-2 个值得对照看的设计点
- 一两句"这块学到了什么"
