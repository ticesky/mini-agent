# nanobot 源码学习计划

> 你已经写完 mini-agent，对 agent 框架的核心结构有完整心智模型了。
> 现在读 nanobot 是**用脚手架照镜子**：每读一段都能问自己"我们当时为什么这么做？为什么 nanobot 这么做？谁更对？"
>
> nanobot 源码 ≈ **65,000 行** Python，全部读完不现实也没必要。
> 这份计划把核心代码拆成 **5 个主题、约 13,000 行**，按**学习收益最大化**排序。

## 学习方法（先确立，比读什么更重要）

### 1. 永远带着 mini-agent 对照读

mini-agent 是你的"基准答案"。读 nanobot 时随时翻回 mini-agent 对应文件：

```
mini-agent/src/agent/runner.ts    ↔   nanobot/agent/runner.py
mini-agent/src/tools/registry.ts  ↔   nanobot/agent/tools/registry.py
mini-agent/src/providers/...      ↔   nanobot/providers/...
```

每段差异问三个问题：
1. **多了什么字段/参数/分支？**
2. **为什么多？是被生产 bug 喂出来的，还是设计需要？**
3. **如果 mini-agent 也加上，需要改哪些文件？**

### 2. 用 grep 而不是逐行读

13000 行也太多。**grep + 跳读** 比顺读高效 10 倍：

```bash
# 找一个概念的所有定义/使用
grep -rn "autocompact" nanobot/

# 看一个函数被哪些地方调用
grep -rn "execute_tools" nanobot/

# 找类的继承关系
grep -rn "class.*Tool):" nanobot/agent/tools/
```

### 3. 读到困惑就跑断点

```bash
cd ~/caozhong/source-code/nanobot
pip install -e .
nanobot chat       # 真跑起来
```

加个 `breakpoint()` 到关心的函数里，看实际数据流。

### 4. 不读什么

| 跳过的目录 | 原因 |
|---|---|
| `channels/{telegram,slack,discord,...}` | 各家 SDK 适配，模式重复，看一个就够 |
| `providers/{bedrock,azure,copilot,codex}` | 同上，各家 API 适配 |
| `webui/` | 前端代码，跟 agent 核心无关 |
| `apps/` `audio/` | 周边功能 |
| `pairing/` `security/` | 工程性子系统，不影响 agent 理解 |
| `web/` | 抓网页/搜索的工具实现，模式重复 |

---

## 阶段 1：从已知到陌生 —— 把 mini-agent 的 6 个文件对照读完（4-6 小时）

> 你已经懂这 6 个文件，nanobot 对应文件就是"长大版的它们"。先看到"成熟项目长什么样"，再展开未知领域。

### 对照清单

| 你已写的 | nanobot 文件 | 行数 | 重点关注 |
|---|---|---|---|
| `src/tools/base.ts` | `agent/tools/base.py` | 296 | `_cast_value`：看 LLM 多会瞎传参 |
| `src/tools/registry.ts` | `agent/tools/registry.py` | 182 | `_suggest_name` / `_unwrap_arguments_payload` 这些"被坑出来"的细节 |
| `src/agent/runner.ts` | `agent/runner.py` | **1570** | 跳读：先看类定义和 `run_turn` 主循环（约前 500 行） |
| `src/providers/base.ts` | `providers/base.py` | 964 | `_is_transient_response` 错误分类、`chat_with_retry` 重试 |
| `src/providers/anthropic.ts` | `providers/anthropic_provider.py` | 713 | `_build_kwargs`、cache_control、prefill |
| `src/agent/loop.ts` | `agent/loop.py` | **1845** | hook 系统、session_key 路由、cron 集成；先看类骨架 |

### 阶段 1 输出（自检）

读完后能自己回答：
- nanobot 的 `LLMResponse` 比我们多了哪 5 个字段？为什么需要？
- 一个 ToolCall 从 Anthropic SDK 出来到 runner.execute_tools 之间经过了多少层翻译？
- nanobot 的工具批次切分跟 mini-agent 的 `executeBatched` 算法一样吗？哪里不同？

### 时间预算
**4-6 小时**。重点在 `runner.py`（1570 行）和 `loop.py`（1845 行），这两个文件吃掉一半时间。

---

## 阶段 2：未涉足的核心子系统（6-8 小时）

> 阶段 1 是"复习+扩展"。阶段 2 开始进入 mini-agent 没碰过的硬骨头。

### 主题 A：Hook 系统（≈ 1 小时）

**`agent/hook.py`** (187 行) + **`agent/progress_hook.py`**

这是 nanobot **整个框架的扩展点**。每个 turn 前后、每个工具前后、每段流式输出，都能注册回调拦截。

读完应该能回答：
- nanobot 的 hook 跟我们 mini-agent 的 `ProgressEvent` 是同一回事吗？
- 如果让 mini-agent 也加 hook 系统，最少要改哪几个文件？
- LLM 调用前 hook 里能不能修改 messages？

### 主题 B：Session 管理 + 历史压缩（≈ 2 小时）

**`agent/autocompact.py`** (96 行) ← 先看这个
**`agent/memory.py`** (1049 行)
**`session/manager.py`** (875 行)

mini-agent 的 `compact.ts` 130 行 vs nanobot 的同主题 ≈ 2000 行。多在哪？
- **多 session 路由**：channel + user → sessionId 的规则
- **TTL 自动清理**：长期未活跃的 session 删掉
- **Dream 两阶段记忆**：短期 working memory + 长期巩固
- **turn continuation**：长 turn 中断后接着跑
- **goal state**：跨 turn 的"持续目标"跟踪

### 主题 C：Tool 高阶能力（≈ 2 小时）

**`agent/tools/apply_patch.py`** (296 行) — Claude Code 风格 diff 编辑
**`agent/tools/shell.py`** (687 行) + `exec_session.py` — 持久 shell session、PTY、后台任务
**`agent/tools/filesystem.py`** (1089 行) — file_state 跟踪、stale 检测、行号、增量 edit
**`agent/tools/spawn.py`** (96 行) — subagent

这是 **mini-agent 砍得最狠** 的部分。重点看：
- `apply_patch.py` 里的 diff 解析：怎么从 LLM 给的 patch 文本恢复出 `(file, old_chunk, new_chunk)`
- `shell.py` 的 sandbox 集成：macOS sandbox-exec / Linux bwrap 包装
- `filesystem.py` 的 `file_state.py`：为什么"读过才能写"是关键安全策略

### 主题 D：MCP 完整实现（≈ 1.5 小时）

**`agent/tools/mcp.py`** (1122 行) ← 你已熟悉 mini-agent 130 行的版本

10 倍代码量主要花在：
- 多种 transport（stdio + SSE + HTTP）
- session 失效检测 + 自动重连
- transient 错误重试 + 退避
- resources / prompts 的注册（不只 tools）
- 启动时跑通的健康检查

**`agent/tools/mcp.py:272-336` 的 `MCPToolWrapper.execute`** 单独读完——60 多行的错误处理就是一部"MCP 生产事故史"。

### 主题 E：Provider 各家适配（≈ 1.5 小时）

**`providers/openai_compat_provider.py`** (1616 行) ← 重点

为什么这一个文件比 anthropic 大那么多？因为它要兼容**很多家用 OpenAI 协议但行为不一致**的厂商：DeepSeek / Qwen / Zhipu / Kimi / vLLM / Ollama ……

读它学到的不是 OpenAI 协议，而是**怎么写一个抗变形的适配层**。重点看：
- 各种 `_should_fallback_*` 分支
- chat.completions 和 responses 两套 API 怎么共存
- prompt cache（cache_control）怎么传

### 时间预算
**6-8 小时**。这一阶段产出最多——你会看到很多 mini-agent "应该有但还没有"的功能。

---

## 阶段 3：消息流与对外接口（3-4 小时）

> 把视角拉远，看 nanobot 怎么处理"很多 channel + 很多用户 + 很多 session"的真实场景。

### 主题 F：MessageBus + Channel 抽象（≈ 1.5 小时）

**`bus/queue.py`** (44 行) — 极小，用 asyncio.Queue
**`channels/base.py`** (256 行) — InboundMessage / OutboundMessage
**`channels/manager.py`** (489 行) — channel 自动发现、生命周期、entry-point 插件
**`channels/websocket.py`** — 看一个**完整的 channel 实现**就够了

mini-agent 的 bus + channel 是"概念可用版"。nanobot 的版本面对真实场景：
- 一个进程同时跑 5 个 channel
- 同一个用户从多个 channel 进来时怎么 dedupe
- channel 启动失败怎么不影响其他

### 主题 G：API server + 命令路由（≈ 1.5 小时）

**`api/server.py`** — OpenAI 兼容 API 服务器
**`command/`** — slash 命令路由

`/clear` `/exit` 这种命令在 nanobot 里是怎么实现的？怎么扩展？这是**给 agent 加"控制层"**的标准模式。

### 主题 H：CLI 入口的真实形态（≈ 1 小时）

**`cli/commands.py`** + **`__main__.py`**

mini-agent 的 CLI 90 行，nanobot 的 CLI 涉及配置加载、profile 切换、模型选择 UI、首次运行向导……值得看一下完整 CLI 怎么组织。

---

## 阶段 4：架构文档（必读，1 小时）

`.agent/` 目录下三份文档是 nanobot 维护者写给 AI agent（也包括人类）的**项目宪法**：

```
nanobot/.agent/
├── design.md       架构约束：为什么这么分层
├── security.md     安全边界：什么能做、什么不能做
└── gotchas.md      踩过的坑：避免重复犯
```

**强烈建议放在阶段 1 之前先读一遍**，作为前置阅读。读完阶段 2/3 再回来读一遍，会有完全不同的理解。

---

## 阶段 5（可选）：写读书笔记 / 改造 mini-agent（4-? 小时）

> 这一步是把"看懂"变成"真懂"的关键。

### 选项 A：写读书笔记

把 nanobot 的核心代码写成你自己的 `doc/nanobot-notes/` 文档：

```
doc/nanobot-notes/
├── runner-comparison.md       runner.py 比 runner.ts 多了什么
├── autocompact-strategies.md  压缩策略对比
├── mcp-production-bugs.md     从 MCP 错误处理看生产事故
└── ...
```

写笔记的好处：被迫思考"这段代码到底在解决什么问题"，比只读高效。

### 选项 B：把某个功能从 nanobot 抄到 mini-agent

按"学习收益 × 工作量"排序，推荐顺序：

| 改造项 | 工作量 | 学到什么 |
|---|---|---|
| 加 `apply_patch` 工具 | 半天 | LLM 安全 edit、diff 解析 |
| 加 `chat_with_retry` 重试 | 2 小时 | 可重试错误分类、指数退避 |
| 加 hook 系统 | 半天 | 框架扩展点设计 |
| 加 OpenAI provider | 1 天 | 验证 provider 抽象的合理性 |
| 加 subagent 工具 | 1 天 | 递归调度、上下文隔离 |
| 加 file_state 跟踪 | 1 天 | "读过才能写"安全模型 |
| 加 sandbox（仅 macOS） | 1 天 | sandbox-exec 包装 |

挑一个就够。**做一个真正的改造，比读 10 个相关文件学到的多。**

---

## 总时间预算

| 阶段 | 内容 | 时间 |
|---|---|---|
| 0 | `.agent/` 三份文档 | 1 小时 |
| 1 | 已知文件对照读 | 4-6 小时 |
| 2 | 未涉足核心子系统 | 6-8 小时 |
| 3 | 消息流与对外接口 | 3-4 小时 |
| 4 | 重读架构文档 | 0.5 小时 |
| **核心总计** | | **15-20 小时** |
| 5（可选） | 笔记 / 改造 | 4-? 小时 |

按每天 2-3 小时算，**1-2 周** 能完整过一遍。

## 优先级 Top 10（如果只能读 10 个文件）

按学习收益排序：

1. **`.agent/design.md`** — 项目宪法
2. **`agent/runner.py:400-700`** — 主循环（先跳过 hook / cancel 那一堆）
3. **`agent/tools/registry.py`** — 几乎和我们一样，能看出我们简化掉了什么
4. **`providers/base.py:359-500`** + 错误分类那一段
5. **`agent/tools/mcp.py:246-340`** — MCPToolWrapper 实现
6. **`agent/autocompact.py`** — 96 行，全读
7. **`agent/tools/apply_patch.py`** — 296 行，整篇精彩
8. **`providers/anthropic_provider.py:580-650`** — `_build_kwargs` + `_parse_response`
9. **`agent/hook.py`** — 187 行，扩展点设计
10. **`agent/tools/shell.py:200-400`** — sandbox 包装核心

读完这 10 段（不到 4000 行），nanobot 的核心你就掌握了 80%。

---

## 几个具体建议

1. **不要从 `__init__.py` / `cli/commands.py` 入手** —— 那是装配代码，看不出核心逻辑
2. **先读 `.py` 文件顶部 docstring** —— nanobot 的文档质量很高，docstring 经常解释"为什么"
3. **遇到 import 不清的，先 grep `class XXX` 找定义** —— Python 隐式 import 多
4. **Anthropic SDK / OpenAI SDK 的源码也值得跳进去看** —— provider 翻译层很多技巧来自 SDK 自己的处理
5. **每读完一个主题，回 mini-agent 看一眼对应文件** —— 强化"差异感知"

## 起步建议

**今天就做**：读 `.agent/design.md`（半小时）。读完你会对整个项目结构有完全不同的理解，后面阶段会快很多。

读完跟我说，我们一起聊聊那份文档里哪些设计你认可、哪些你想改。
