# 步骤 1.1 — 项目脚手架

> 对应 plan.md 的 Day 1 第 1 步。

## 目标

把空目录变成"装好依赖、`pnpm typecheck` 通过、能 `import` 类型"的可运行 TS 项目。

## 交付清单

```
mini-agent/
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example
├── README.md
├── doc/
│   ├── plan.md
│   ├── list.md
│   └── step-1.1-scaffold.md   ← 当前文档
└── src/
    └── types.ts
```

依赖（已 `pnpm install` 通过）：

| 包 | 用途 | 对应 nanobot |
|---|---|---|
| `@anthropic-ai/sdk` | Claude API | `anthropic` |
| `@modelcontextprotocol/sdk` | MCP 协议 | `mcp` |
| `commander` | CLI 子命令 | `typer` |
| `dotenv` | 加载 `.env` | `pydantic-settings` |
| `execa` | 友好的子进程执行 | `subprocess` |
| `gpt-tokenizer` | token 计数 | `tiktoken` |
| `zod` | schema 校验 | `pydantic` |
| `zod-to-json-schema` | zod → JSON Schema | pydantic 自带 |
| `tsx` | 直接跑 ts，无需 build | (Python 不需要) |

## 关键设计

### `src/types.ts` —— 共享类型

这里只定义 **5 个跨模块共享的类型**，刻意控制规模：

| mini-agent | nanobot | 取舍 |
|---|---|---|
| `Message` | `agent/runner.py` 里散落的 dict | 显式建模，TS 比 Python 好得多 |
| `ToolCall` | `ToolCallRequest` | arguments 提前 parse 成 object（nanobot 里它还可能是字符串） |
| `LLMResponse` | `providers/base.py` `LLMResponse` | 简化：砍掉 reasoning / provider_specific_fields 等 |
| `StreamEvent` | nanobot 用多个 callback (`on_content_delta` / `on_tool_call_delta` / ...) | **改用 discriminated union**：单 handler、类型安全 |
| `StreamHandler` | 同上 | 一个 handler 处理全部事件 |

> **mini-agent 第一处"比 nanobot 优雅"的地方** ——
> 不是因为 TS 强，是因为 nanobot 演化早期被回调签名锁死，后续只能继续叠 callback。
> 我们是新项目，从一开始就用 union type 就行。

### `tsconfig.json` 几个关键开关

- `strict: true` + `noUncheckedIndexedAccess: true`
  - 数组下标访问被标成 `T | undefined`，逼你写防御代码
  - 配合 zod 推断的类型用起来很自然
- `allowImportingTsExtensions: true`
  - 允许 `import './foo.ts'`，配合 tsx 直接跑
- `module: "ESNext"` + `moduleResolution: "bundler"` + `"type": "module"`
  - 全 ESM，符合现代 Node 习惯

### `package.json` 选型说明

- **`tsx` 而非 ts-node** —— 学习项目不需要 build 步骤，改完 ts 直接跑
- **`gpt-tokenizer` 而非 tiktoken** —— 纯 JS，不需要原生编译，装起来不会卡
- **`commander` 而非 yargs** —— API 更直观，nanobot 那边对应 `typer`

## 对照 nanobot 看什么

读这两段会很有收获：

1. **`nanobot/agent/runner.py` 顶部的 imports 和 dataclass 定义**（前 100 行）
   对照我们的 `types.ts`，看它的字段比我们多多少。多出来的字段几乎都是"线上 bug 喂出来的"，MVP 不需要，但要知道未来会长成那样。

2. **`nanobot/providers/base.py` 的 `LLMResponse` 类**（约第 141 行附近）
   特别看 `error_kind` / `error_status_code` / `error_should_retry` 这一组 —— 错误分类比想象中复杂。我们 MVP 用 `{ message, retryable }` 两字段先顶住，等真遇到再细分。

## 验证

```bash
cd ~/caozhong/source-code/mini-agent
pnpm install      # 已完成
pnpm typecheck    # 已通过
```

## 下一步

**步骤 1.2 — Tool 抽象 + ToolRegistry**（≈ 200 行）：
- `src/tools/base.ts` —— `Tool` 接口、zod → JSON Schema、参数 cast
- `src/tools/registry.ts` —— 注册、查找、`prepareCall`、错误回填
