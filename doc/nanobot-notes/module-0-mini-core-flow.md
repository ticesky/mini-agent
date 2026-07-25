# Nanobot 最小核心流程学习大纲

这份文档用于学习 nanobot 的最小核心流程。这里暂时不考虑 channels、WebUI、gateway、Telegram、Slack 等外部接入层，只看最容易跑通、也最适合学习源码的一条路径：

```bash
nanobot agent -m "北京明天天气怎么样" --logs
```

这条命令会启动一次 CLI 直连对话，跑完一轮 Agent 后退出。

## 0. 先建立整体心智模型

最小核心流程：

```text
CLI 输入
  -> 加载配置 config
  -> 创建 AgentLoop
  -> 调用 AgentLoop.process_direct()
  -> 构造 InboundMessage
  -> 恢复 session / 历史消息
  -> 构建上下文 context
  -> 调用 AgentRunner.run()
  -> 通过 Provider 请求模型
  -> 模型可能返回工具调用
  -> ToolRegistry 执行工具
  -> 把工具结果追加回 messages
  -> 再次请求模型
  -> 得到最终 assistant 回复
  -> 保存 session
  -> CLI 打印输出
```

去掉 channels 后，最小可学习核心是：

```text
AgentLoop + AgentRunner + Provider + ToolRegistry + Session
```

channels 不是这条路径的必要部分。channels 主要解决两个问题：消息从哪里来，回复发到哪里去。

## 1. CLI 入口：`nanobot agent -m ...`

主要文件：

- `nanobot/cli/commands.py`

关键源码位置：

- `nanobot/cli/commands.py:1899` - `@app.command()`，声明 `agent` 命令
- `nanobot/cli/commands.py:1900` - `def agent(...)`
- `nanobot/cli/commands.py:1901` - `--message` / `-m` 参数
- `nanobot/cli/commands.py:1906` - `--logs` 参数
- `nanobot/cli/commands.py:1913` - 加载 runtime config
- `nanobot/cli/commands.py:1916` - 创建 `MessageBus`
- `nanobot/cli/commands.py:1926` - 打开运行时日志
- `nanobot/cli/commands.py:1929` - 创建 `AgentLoop`
- `nanobot/cli/commands.py:1976` - 进入单次消息模式
- `nanobot/cli/commands.py:1984` - 调用 `agent_loop.process_direct(...)`

这一段要学什么：

- Typer 会把 `nanobot agent` 映射到 Python 函数 `agent()`。
- `-m` 表示这是一次性直连模式。
- `--logs` 会打开 nanobot 的内部运行日志。
- CLI 只是入口层，不负责真正的 Agent 推理。

你可以把这条命令：

```bash
nanobot agent -m "北京明天天气怎么样" --logs
```

粗略理解成调用了：

```python
agent(
    message="北京明天天气怎么样",
    session_id="cli:direct",
    logs=True,
)
```

## 2. 直连处理：`AgentLoop.process_direct()`

主要文件：

- `nanobot/agent/loop.py`

关键源码位置：

- `nanobot/agent/loop.py:1902` - `async def process_direct(...)`
- `nanobot/agent/loop.py:1922` - 连接已配置的 MCP server
- `nanobot/agent/loop.py:1926` - 创建 `InboundMessage`
- `nanobot/agent/loop.py:1931` - 获取 session lock
- `nanobot/agent/loop.py:1951` - 调用 `_process_message(...)`

这一段要学什么：

- CLI direct 模式仍然会把用户输入包装成 `InboundMessage`。
- 它不主要依赖 `MessageBus.inbound`，但后面会复用同一套 `_process_message` 内部流程。
- session lock 用来保证同一个 session 不会同时跑两轮对话。

可以先记住这一句：

```python
return await self._process_message(msg, **kwargs)
```

`process_direct()` 自己不是完整 Agent，只是把 CLI 输入变成标准消息，然后交给 `_process_message()`。

## 3. 消息形状：`InboundMessage` / `OutboundMessage`

主要文件：

- `nanobot/bus/events.py`
- `nanobot/bus/queue.py`

关键源码位置：

- `nanobot/bus/events.py:22` - `InboundMessage`
- `nanobot/bus/events.py:35` - 默认 `session_key`
- `nanobot/bus/events.py:40` - `OutboundMessage`
- `nanobot/bus/queue.py:8` - `MessageBus`

这一段要学什么：

- `InboundMessage` 是系统内部统一的输入消息格式。
- `OutboundMessage` 是系统内部统一的输出消息格式。
- `MessageBus` 对 channels 很重要，但 CLI `-m` 模式基本绕过 inbound queue。

最重要的理解是：无论消息来自 CLI、WebUI、Telegram 还是 API，进入 Agent 内核前都会被整理成类似 `InboundMessage` 的标准结构。

## 4. AgentLoop：一轮对话的外层编排器

主要文件：

- `nanobot/agent/loop.py`

关键源码位置：

- `nanobot/agent/loop.py:183` - turn 状态流转表
- `nanobot/agent/loop.py:502` - `Runtime model switched ...` 日志
- `nanobot/agent/loop.py:548` - `Registered ... tools` 日志
- `nanobot/agent/loop.py:1464` - `Processing message from ...` 日志

一轮 turn 的状态：

```text
RESTORE
  -> COMPACT
  -> COMMAND
  -> BUILD
  -> RUN
  -> SAVE
  -> RESPOND
  -> DONE
```

这一段要学什么：

- `AgentLoop` 是外层协调器。
- 它负责恢复 session、压缩历史、处理命令、构建上下文、调用 runner、保存结果、返回回复。
- 它不直接实现“模型请求 - 工具执行 - 再请求模型”的循环，那是 `AgentRunner` 的职责。

你日志里的这几行都属于 AgentLoop 准备阶段：

```text
Runtime model switched for next turn: Claude Sonnet 4.6 -> Claude Sonnet 4.6
Registered 19 tools: [...]
Processing message from cli:user: 北京明天天气怎么样
```

## 5. 上下文构建：模型真正看到了什么

主要相关区域：

- `nanobot/agent/loop.py`
- `nanobot/agent/context.py`
- `nanobot/agent/tools/registry.py`

调用模型前，系统会组装这些内容：

- system prompt
- runtime metadata
- 用户当前消息
- session 历史消息
- memory / context 文件
- 可用工具的 schema
- 当前 provider / model / temperature / max tokens 等运行参数

这一段要学什么：

- 模型不是天然知道有哪些工具。
- nanobot 会把工具定义作为 schema 传给模型。
- 模型是否调用工具、调用哪个工具，是模型根据上下文和工具说明自己决定的。

所以问天气时，它可以选择：

- 调 `web_search`
- 调 `web_fetch`
- 调 `exec` 跑 `curl`
- 或者不调工具直接回答

你的日志里它选择了 `exec`。

## 6. AgentRunner：模型和工具的循环

主要文件：

- `nanobot/agent/runner.py`

关键源码位置：

- `nanobot/agent/runner.py:296` - `AgentRunner.run(...)`
- `nanobot/agent/runner.py:393` - 请求模型
- `nanobot/agent/runner.py:411` - 判断模型是否要求执行工具
- `nanobot/agent/runner.py:435` - 工具执行前的 hook
- `nanobot/agent/runner.py:437` - 执行工具
- `nanobot/agent/runner.py:454` - 追加工具结果消息
- `nanobot/agent/runner.py:711` - `_request_model(...)`
- `nanobot/agent/runner.py:1083` - `_execute_tools(...)`

核心循环可以理解成：

```text
把 messages 发给模型
  -> 如果模型返回最终文本：结束
  -> 如果模型返回 tool calls：执行工具
  -> 把工具结果追加到 messages
  -> 再把新的 messages 发给模型
```

这一段要学什么：

- 一次用户输入不一定只调一次模型。
- 只要模型继续要求调用工具，runner 就会继续循环。
- 循环结束条件是：模型返回最终回答，不再返回 tool call。

你的天气例子里，大致发生了三次模型交互：

```text
第 1 次请求模型：模型决定调用 exec 查天气
第 1 次执行工具：curl wttr.in/Beijing...
第 2 次请求模型：模型觉得信息还不够，再调用 exec 查详细预报
第 2 次执行工具：curl wttr.in/Beijing?T&2 | head -50
第 3 次请求模型：模型生成最终中文回答
```

## 7. 工具调用日志从哪里来

主要文件：

- `nanobot/agent/progress_hook.py`

关键源码位置：

- `nanobot/agent/progress_hook.py:100` - `before_execute_tools(...)`
- `nanobot/agent/progress_hook.py:114` - 遍历 tool calls
- `nanobot/agent/progress_hook.py:116` - 打印 `Tool call: ...` 日志

源码片段：

```python
for tc in context.tool_calls:
    args_str = json.dumps(tc.arguments, ensure_ascii=False)
    logger.info("Tool call: {}({})", tc.name, args_str[:200])
```

这一段要学什么：

- `Tool call: exec(...)` 这行日志是在工具真正执行前打印的。
- 它表示模型请求了工具调用，runner 即将执行。
- 不是 CLI 自己决定要调工具，也不是 nanobot 针对天气写死了调用 `exec`。

## 8. ToolRegistry：工具如何被找到和执行

主要文件：

- `nanobot/agent/tools/registry.py`

关键源码位置：

- `nanobot/agent/tools/registry.py:13` - `ToolRegistry`
- `nanobot/agent/tools/registry.py:18` - `register(...)`
- `nanobot/agent/tools/registry.py:71` - 输出工具定义
- `nanobot/agent/tools/registry.py:165` - `execute(...)`

这一段要学什么：

- 工具按名字注册，比如 `exec`、`read_file`、`web_search`。
- 模型返回的 tool call 里也有工具名和参数。
- `ToolRegistry.execute(name, params)` 会根据名字找到对应工具对象，然后调用它的 `execute(...)` 方法。

简化理解：

```text
模型说：我要调用 exec，参数是 {"command": "curl ..."}
ToolRegistry 找到名叫 exec 的工具
exec 工具执行 shell 命令
执行结果返回给 AgentRunner
AgentRunner 把结果塞回 messages
```

## 9. Provider 层：真正请求模型 API

主要目录：

- `nanobot/providers/`

你当前配置是：

```text
provider: anthropic
model: Claude Sonnet 4.6
apiBase: https://oneapi-comate.baidu-int.com
```

这一段要学什么：

- `AgentRunner` 不直接关心每家模型 API 的 HTTP 细节。
- 它调用 provider 抽象。
- provider 负责把 nanobot 内部标准消息转换成具体模型服务要求的格式。

比如你现在用 Claude Sonnet 4.6，实际走的是 Anthropic Messages API 风格。之前如果把它配成 OpenAI 兼容 `/chat/completions`，就会出现 404。

## 10. Session 保存和最终输出

主要相关区域：

- `nanobot/agent/loop.py`
- `nanobot/session/manager.py`
- `nanobot/cli/commands.py`

结束时发生的事：

- `AgentRunner` 返回最终 assistant 内容。
- `AgentLoop` 把本轮消息保存到 session。
- 系统创建 `OutboundMessage`。
- CLI renderer 把最终文本打印到终端。
- `nanobot agent -m ...` 进程退出。

这一段要学什么：

- 最终回答不是 runner 直接打印的。
- runner 只负责生成结果。
- 结果会回到 `AgentLoop`，再由 CLI 或 channel 输出。
- 这样同一套 Agent 内核就能同时服务 CLI、WebUI、API 和各种聊天平台。

## 11. 天气案例完整回放

命令：

```bash
nanobot agent -m "北京明天天气怎么样" --logs
```

你观察到的日志：

```text
Registered 19 tools
Processing message from cli:user
Tool call: exec(curl wttr.in/Beijing...)
Tool call: exec(curl wttr.in/Beijing?T&2 | head -50)
Response to cli:user: 北京明天...
```

解释：

1. CLI 创建一次直连 turn。
2. AgentLoop 加载配置、模型、session、工具注册表。
3. AgentRunner 把上下文和工具定义发给 Claude。
4. Claude 选择 `exec` 工具，通过 `curl wttr.in` 查天气。
5. 工具输出作为 tool result 被追加回 messages。
6. Claude 又请求第二次 `exec`，查更详细的两日预报。
7. 收到第二次工具结果后，Claude 生成最终中文回答。
8. AgentLoop 保存 session 并返回 response。
9. CLI 打印最终回答。

## 12. 建议阅读顺序

建议按这个顺序读：

1. `nanobot/cli/commands.py:1899` - 理解 CLI 命令入口。
2. `nanobot/agent/loop.py:1902` - 理解 direct 模式如何进入 AgentLoop。
3. `nanobot/bus/events.py:22` - 理解标准消息结构。
4. `nanobot/agent/loop.py:183` - 理解一轮 turn 的状态。
5. `nanobot/agent/runner.py:296` - 理解模型/工具循环。
6. `nanobot/agent/progress_hook.py:100` - 理解工具日志。
7. `nanobot/agent/tools/registry.py:13` - 理解工具注册与执行。
8. `nanobot/providers/` - 理解模型 provider 适配。
9. `nanobot/session/manager.py` - 理解 session 持久化。

## 13. 小实验

实验 1：观察工具日志

```bash
nanobot agent -m "北京明天天气怎么样" --logs
```

实验 2：尝试引导模型使用搜索工具

```bash
nanobot agent -m "请用 web_search 查询北京明天天气，然后回答" --logs
```

实验 3：观察不需要工具的普通回答

```bash
nanobot agent -m "用一句话解释 Python 的 list 是什么" --logs
```

实验 4：临时加 debug 日志

在 `nanobot/agent/progress_hook.py:116` 附近加一行日志，打印 `context.iteration`，然后重新运行天气命令。你应该能看到每次工具调用发生在哪一轮 runner iteration。

## 14. 核心结论

- CLI direct 模式是学习核心流程的最佳入口。
- `AgentLoop` 负责一轮对话的外层编排。
- `AgentRunner` 负责模型和工具的循环。
- `Provider` 负责适配具体模型 API。
- `ToolRegistry` 负责把模型请求的工具名映射到真实 Python 工具实现。
- channels 很重要，但理解核心 Agent 流程时可以先放到后面。
