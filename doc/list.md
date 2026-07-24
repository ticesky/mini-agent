# nanobot 完整功能模块清单

> 完整盘点 [nanobot](../nanobot) 的所有功能模块，标注每个模块的**学习价值**和**MVP 取舍**。
>
> 学习价值评分：★★★★★ 必看 / ★★★★ 强烈建议 / ★★★ 推荐 / ★★ 选看 / ★ 跳过
>
> MVP 取舍：✅ 做 / ⚪ 强烈建议做 / 🔶 stretch / ❌ 不做

## 1. 核心 Agent 引擎

| 模块 | nanobot 文件 | 做什么 | 学习 | MVP |
|---|---|---|---|---|
| Agent runner（多轮对话状态机） | `agent/runner.py` | 发消息→收 tool_call→执行→塞回，循环直到 LLM 给最终答案 | ★★★★★ | ✅ |
| Agent loop（消息调度） | `agent/loop.py` | 从 bus 取入站消息，调度 runner，发出站消息 | ★★★★ | ⚪ |
| Context 构建 | `agent/context.py` | 拼 system prompt + history + skills + 工具列表 | ★★★ | ✅(简化) |
| Hook 系统 | `agent/hook.py`, `progress_hook.py` | 工具执行前后、turn 前后的回调（埋点/日志/观察） | ★★ | 🔶 |
| Subagent | `agent/subagent.py` | 在工具里再起一个 agent（递归任务分解） | ★★★ | 🔶 |
| Skills 注入 | `agent/skills.py`, `skills/` | 把"长 system prompt 片段"按需加载进上下文 | ★★ | ❌ |
| Cron turns | `agent/cron_turns.py` | 定时主动给 agent 发消息（"自走 agent"） | ★★ | ❌ |
| Auto compact | `agent/autocompact.py` | token 超阈值触发摘要 | ★★★★★ | ⚪ |
| Memory 持久化 | `agent/memory.py` | atomic write + fsync，Dream 两阶段巩固 | ★★★★ | ⚪(简化) |

## 2. LLM Provider 层

| 模块 | nanobot 文件 | 做什么 | 学习 | MVP |
|---|---|---|---|---|
| Provider 抽象 | `providers/base.py` | 定义 `chat` / `chat_stream` 接口、错误分类、重试 | ★★★★★ | ✅ |
| Anthropic | `providers/anthropic_provider.py` | 包 `anthropic` SDK | ★★★★ | ✅ |
| OpenAI 兼容 | `providers/openai_compat_provider.py` | 包 `openai` SDK，兼容 GPT/DeepSeek/Qwen 等 | ★★★ | 🔶 |
| OpenAI Responses API | `providers/openai_responses/` | 新版 Responses API（流式 reasoning + 工具） | ★★ | ❌ |
| Bedrock | `providers/bedrock_provider.py` | AWS Bedrock | ★ | ❌ |
| Azure OpenAI | `providers/azure_openai_provider.py` | Azure 适配 | ★ | ❌ |
| GitHub Copilot | `providers/github_copilot_provider.py` | Copilot API | ★ | ❌ |
| OpenAI Codex | `providers/openai_codex_provider.py` | Codex 适配 | ★ | ❌ |
| Fallback provider | `providers/fallback_provider.py` | 主 provider 挂了切备用 | ★★ | ❌ |
| Image generation | `providers/image_generation.py` | 文生图 API 调用 | ★ | ❌ |
| Transcription | `providers/transcription.py` | 语音转文字 | ★ | ❌ |
| Factory / Registry | `providers/factory.py`, `registry.py` | 按配置实例化 provider，列模型 | ★★ | ❌ |

## 3. 工具系统

| 模块 | nanobot 文件 | 做什么 | 学习 | MVP |
|---|---|---|---|---|
| Tool 抽象 | `tools/base.py` | Tool 接口、JSON Schema 校验、参数 cast | ★★★★★ | ✅ |
| Tool registry | `tools/registry.py` | 注册、查找、prepare_call、并发执行入口 | ★★★★★ | ✅ |
| Tool loader | `tools/loader.py` | pkgutil 自动发现 + entry-point 插件 | ★★★ | ❌(写死 import) |
| 文件读写 | `tools/filesystem.py` | read / write / list / edit | ★★★ | ✅ |
| Patch 应用 | `tools/apply_patch.py` | 按 diff 改文件（Claude Code 风格） | ★★★★ | 🔶 |
| Shell 执行 | `tools/shell.py`, `exec_session.py` | bash 命令、持久 session、stdout 截断 | ★★★ | ✅(简化) |
| Sandbox | `tools/sandbox.py` | macOS sandbox-exec / Linux bwrap 沙箱 | ★★ | ❌ |
| Web search/fetch | `tools/web.py`, `tools/search.py` | 搜索、fetch、正文提取 | ★★★ | 🔶 |
| **MCP** | `tools/mcp.py` | 连 MCP server，把远程 tool 包成本地 Tool | ★★★★★ | ⚪ |
| Spawn / subagent | `tools/spawn.py` | LLM 主动起子 agent | ★★★ | 🔶 |
| Long task | `tools/long_task.py` | 后台长任务、状态查询 | ★★ | ❌ |
| Cron 工具 | `tools/cron.py` | LLM 自己设定时任务 | ★★ | ❌ |
| Self / 自我修改 | `tools/self.py` | agent 修改自己的 prompt/skills | ★★ | ❌ |
| CLI apps | `tools/cli_apps.py` | 调 git/gh 等命令包装 | ★★ | ❌ |
| Image gen tool | `tools/image_generation.py` | 让 agent 调文生图 | ★ | ❌ |
| Message tool | `tools/message.py` | agent 主动发消息到 channel | ★★ | ❌ |
| Notebook 编辑 | (notebook 相关) | Jupyter cell 编辑 | ★ | ❌ |
| File state 跟踪 | `tools/file_state.py` | 跟踪文件被读/写状态、防 stale edit | ★★★ | ❌ |
| Path utils | `tools/path_utils.py` | 路径安全校验、workspace 约束 | ★★ | ❌ |
| Tool context | `tools/context.py` | 工具运行时拿到的 ctx（workspace/spec/etc） | ★★ | 🔶(简化) |

## 4. 会话与历史

| 模块 | nanobot 文件 | 做什么 | 学习 | MVP |
|---|---|---|---|---|
| Session manager | `session/manager.py` | 按 session key 存历史，TTL 自动压缩 | ★★★★ | ⚪(简化) |
| Goal state | `session/goal_state.py` | 持续目标的状态跟踪 | ★★ | ❌ |
| Turn continuation | `session/turn_continuation.py` | 中断后继续 turn | ★★ | ❌ |
| Session keys | `session/keys.py` | 多 channel 多用户的 session key 规则 | ★★ | ❌ |
| WebUI turns | `session/webui_turns.py` | WebUI 特殊 turn 管理 | ★ | ❌ |

## 5. 消息总线 / Channel

| 模块 | nanobot 文件 | 做什么 | 学习 | MVP |
|---|---|---|---|---|
| MessageBus | `bus/queue.py` | 异步队列，channel ↔ agent 解耦 | ★★★★ | ⚪ |
| Channel 抽象 | `channels/base.py` | InboundMessage / OutboundMessage | ★★★ | ✅ |
| Channel manager | `channels/manager.py` | 自动发现、生命周期管理 | ★★ | ❌ |
| Channel registry | `channels/registry.py` | 插件注册 | ★★ | ❌ |
| WebSocket channel | `channels/websocket.py` | WebUI 用的内置 channel | ★★★ | ❌ |
| Telegram | `channels/telegram.py` | Telegram bot | ★ | ❌ |
| Slack | `channels/slack.py` | Slack bot | ★ | ❌ |
| Discord | `channels/discord.py` | Discord bot | ★ | ❌ |
| Feishu / 飞书 | `channels/feishu.py` | 飞书机器人 | ★ | ❌ |
| 钉钉 | `channels/dingtalk.py` | DingTalk bot | ★ | ❌ |
| Matrix | `channels/matrix.py` | Matrix bot | ★ | ❌ |
| WhatsApp | `channels/whatsapp.py` | WhatsApp bridge | ★ | ❌ |
| QQ | `channels/qq.py`, `napcat.py` | QQ bot | ★ | ❌ |
| WeChat / WeCom | `channels/weixin.py`, `wecom.py` | 微信/企微 | ★ | ❌ |
| MS Teams | `channels/msteams.py` | Teams bot | ★ | ❌ |
| MoChat | `channels/mochat.py` | MoChat 客户端 | ★ | ❌ |
| Email | `channels/email.py` | 邮件 channel | ★ | ❌ |
| Signal | `channels/signal.py` | Signal bot | ★ | ❌ |
| **CLI（自实现）** | — | stdin/stdout 交互 | ★★★ | ✅ |

## 6. 配置与扩展

| 模块 | nanobot 文件 | 做什么 | 学习 | MVP |
|---|---|---|---|---|
| Config schema | `config/schema.py` | pydantic 配置定义 | ★★★ | ✅(.env + zod) |
| Config loader | `config/loader.py` | 加载 `~/.nanobot/config.json` | ★★ | ❌ |
| Command router | `command/` | slash 命令路由 | ★★ | 🔶 |
| Skills | `skills/` | 内置 skill 定义（github、image-gen 等） | ★★ | ❌ |
| Pairing | `pairing/` | DM 发送方授权 | ★ | ❌ |
| Security | `security/` | PTH 防护（Python 特有，Node 不需要） | ★ | ❌ |
| Templates | `templates/` | 内置 prompt 模板 | ★★ | ✅(简版) |

## 7. 对外接口

| 模块 | nanobot 文件 | 做什么 | 学习 | MVP |
|---|---|---|---|---|
| CLI | `cli/commands.py` | `nanobot` 命令行入口 | ★★★ | ✅ |
| API server | `api/server.py` | OpenAI 兼容 HTTP API | ★★★ | ❌ |
| Python SDK | `nanobot.py` | 库形式调用 | ★★ | ❌ |
| WebUI | `webui/` | React SPA + WebSocket | ★★ | ❌ |
| Bridge | `bridge/` | TS 服务桥接（如 WhatsApp） | ★ | ❌ |

## 8. 辅助子系统

| 模块 | nanobot 文件 | 做什么 | 学习 | MVP |
|---|---|---|---|---|
| Cron 调度 | `cron/` | 定时任务调度（取代旧的 heartbeat 服务） | ★★ | ❌ |
| Apps | `apps/` | 内置应用（图片处理等） | ★ | ❌ |
| Audio | `audio/` | 音频处理 | ★ | ❌ |
| Web 工具集 | `web/` | 共享 user-agent、搜索 provider 等 | ★★ | ❌ |
| Utils | `utils/` | 通用工具函数 | ★ | ❌ |

---

## MVP 模块映射（mini-agent 视角）

下面这张表把 mini-agent 要写的每个文件**映射回 nanobot 的对应文件**，方便对照学习。

| mini-agent 文件 | 对应 nanobot 文件 | 做什么 |
|---|---|---|
| `src/types.ts` | `agent/runner.py` 顶部的 dataclass | Message / ToolCall / LLMResponse 类型 |
| `src/tools/base.ts` | `agent/tools/base.py` | Tool 接口、zod → JSON Schema |
| `src/tools/registry.ts` | `agent/tools/registry.py` | ToolRegistry |
| `src/tools/readFile.ts` | `agent/tools/filesystem.py`（部分） | read_file 工具 |
| `src/tools/writeFile.ts` | `agent/tools/filesystem.py`（部分） | write_file 工具 |
| `src/tools/bash.ts` | `agent/tools/shell.py`（简版） | bash 工具 |
| `src/providers/base.ts` | `providers/base.py` | Provider 抽象 |
| `src/providers/anthropic.ts` | `providers/anthropic_provider.py` | Anthropic 实现 |
| `src/agent/runner.ts` | `agent/runner.py` | ★ Agent loop 状态机 |
| `src/agent/loop.ts` | `agent/loop.py` | bus 消息调度 |
| `src/bus/queue.ts` | `bus/queue.py` | AsyncQueue |
| `src/session/memory.ts` | `agent/memory.py` + `session/manager.py` | 会话持久化 |
| `src/session/compact.ts` | `agent/autocompact.py` | 上下文压缩 |
| `src/channels/base.ts` | `channels/base.py` | Channel 接口 |
| `src/channels/cli.ts` | （nanobot 没有，相当于简化版 websocket channel） | CLI channel |
| `src/mcp/client.ts` | `agent/tools/mcp.py` | MCP 接入 |
| `src/index.ts` | `cli/commands.py` | CLI 入口 |

## 学习路径建议

按"对学习 agent 框架的核心价值"排序，**只读 7 个文件**就能搞懂 agent 框架的全部精髓：

1. `agent/tools/base.py` —— Tool 抽象（最基础）
2. `agent/tools/registry.py` —— 注册 + 参数处理 + 错误回填
3. **`agent/runner.py`** —— 多轮对话状态机（最核心，必读）
4. `providers/base.py` —— Provider 抽象层
5. `providers/anthropic_provider.py` —— SDK 包装的范例
6. `agent/tools/mcp.py` —— MCP 客户端 + Tool 包装
7. `agent/autocompact.py` —— 上下文压缩

读完这 7 个文件，比读完整个项目获益大得多。其他文件（多 channel、多 provider、各种边缘场景）属于"工程产出"，了解形状即可，不必抠细节。
