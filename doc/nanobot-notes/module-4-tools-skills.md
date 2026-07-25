# 模块 4 · 工具系统 + Skills

模块 4 只解一个问题：**LLM 想调工具时，agent 怎么把"工具"这个抽象具象成能跑的代码？**

答案是 **"schema-driven 自描述接口 + 三源装配 + Registry 单点入口"**。加一个正交辅助：Skills（只写 prompt，不写代码）。

```
                        ①声明             ②装配                    ③调用
[Tool ABC + Schema] ──▶ [Loader/MCP] ──▶ [ToolRegistry] ──▶ [runner._execute_tools]
   自描述接口             三个来源            单点入口                    │
                                                                       ▼
                                              cast_params + validate_params
                                                       │
                                                       ▼
                                              tool.execute(**params)

Skills（正交）：SkillsLoader 读 SKILL.md → 拼进 system prompt，不进工具通道
```

**一条铁律**：Tool 是"自描述黑盒"——schema 由 Tool 自己声明，Registry 只做索引和校验，Runner 只按接口调用。三者互不知细节，这是敢让 builtin/plugin/MCP 三种来源共走一条路的底气。

## 一、Tool 抽象层

### 1.1 `Tool` ABC 四必填 + 三可选（[base.py:146](../nanobot/agent/tools/base.py#L146)）

| 成员 | 类型 | 用途 |
|---|---|---|
| `name` | property | function-call 里的名字，须匹配 provider 命名规则 |
| `description` | property | 给 LLM 看的一句话说明 |
| `parameters` | property | JSON Schema，进 tools schema，也用来校验入参 |
| `execute(**kwargs)` | async method | 干活，返 `str` 或 `ToolResult` |
| `read_only` | bool | side-effect 免疫，可并发 |
| `concurrency_safe` | bool | `read_only and not exclusive`，能和别的 safe tool 一起跑 |
| `exclusive` | bool | 必须独占，即便开了并发 |

`concurrency_safe` 是 `read_only` 和 `exclusive` 的**派生量**，决定了 `runner._execute_tools` 敢不敢用 `asyncio.gather` 并发批处理。

### 1.2 类级"插件元数据"五件套

```python
config_key: str = ""              # ctx.config.<key> 里读自己的配置
_plugin_discoverable: bool = True # False 就跳过 pkgutil 扫描
_scopes: set[str] = {"core"}      # "core" / "subagent" 多阶段加载
config_cls() -> BaseModel | None  # pydantic 配置类型
enabled(ctx) -> bool              # 装配时决定"要不要 register"
create(ctx) -> Tool               # 工厂方法，注入 workspace/bus/config
```

**为什么是类方法**：Loader 需要在 `create(ctx)` 之前先决定该不该实例化——`enabled(ctx)` 让 tool 自己判断依赖是否满足（如没配 API key 就返 False）。

### 1.3 `tool_parameters` 装饰器（[base.py:299](../nanobot/agent/tools/base.py#L299)）

```python
@tool_parameters(tool_parameters_schema(
    command=StringSchema("The shell command to execute"),
    timeout=IntegerSchema(60, minimum=1, maximum=600),
))
class ExecTool(Tool): ...
```

三件事：`deepcopy` schema 冻在类上；注入 `parameters` property 每次返 fresh copy（防被改坏）；从 `__abstractmethods__` 删掉 `parameters`（子类不用再手写）。

### 1.4 `Schema` 与 `ToolResult`

- 具体 Schema 子类（StringSchema/IntegerSchema/ArraySchema/ObjectSchema）在 [schema.py](../nanobot/agent/tools/schema.py)，都实现 `to_json_schema()`；
- 校验入口 `Schema.validate_json_schema_value` 一个静态方法搞定递归校验：`nullable` / `enum` / `minimum` / `minLength` / `minItems` / `required` / `additionalProperties=False`；
- `ToolResult(str)` 子类化 `str`，字符串兼容，多带 `is_error` 字段。`ToolResult.error(msg)` 出来的 runner 会认成失败。

### 1.5 `cast_params`：schema-driven 类型救援（[base.py:233](../nanobot/agent/tools/base.py#L233)）

LLM 生成 tool_call 时经常把 int 输成 `"60"`、bool 输成 `"true"`。这一层按 schema 主动 cast：`"60"` → `60`；`"true"/"1"/"yes"` → `True`；其他 → `str(val)`；递归下钻 array/object。

**必须放在校验之前**：`validate_json_schema_value` 是严格的，不 cast 直接校验会 fail。

## 二、Registry：单点入口

`ToolRegistry`（[registry.py](../nanobot/agent/tools/registry.py)）四件事：

| 职责 | 方法 | 关键细节 |
|---|---|---|
| 注册/注销 | `register` / `unregister` | 改后立刻清 `_cached_definitions` |
| 拿定义给 LLM | `get_definitions()` | 稳定顺序：builtins 按名排序，MCP `mcp_` 前缀后排；结果缓存 |
| 派发前预处理 | `prepare_call(name, params)` | resolve → coerce → cast → validate 四步 |
| 执行 + 错包装 | `execute(name, params)` | 抓所有异常包成 `ToolResult.error`，附 `[Analyze the error above and try a different approach.]` |

### 2.1 稳定顺序的意义

Provider 端的 prompt cache 命中长前缀。builtins 顺序稳定 → tools schema 序列化后前缀稳定 → cache 长命中。MCP 后置是因为 MCP 服务器会热插拔，让它变化只影响后缀。与模块 2 `build_system_prompt` **7 段按变化频率排**是同一个哲学。

### 2.2 `prepare_call` 四步（[registry.py:97](../nanobot/agent/tools/registry.py#L97)）

```
① 名字查表 → 找不到走 _suggest_name（alnum-lowercase key 匹配）给 "Did you mean X?"
② set_context(ctx)  → 仅对 ContextAware 的 legacy plugin；built-in 直接读 ContextVar
③ _coerce_params    → 两个 tricks:
                     - 值是字符串且以 { 或 [ 开头 → json.loads 兜底
                     - 值是 {"arguments": "..."} 且 tool 没定义 arguments 参数 → unwrap
④ cast_params + validate_params
```

**③ 的两个 tricks 都是补 provider/LLM 的 hack**：有的 provider 把参数以 JSON 字符串返，有的把整个参数塞进 `{arguments: "..."}` 里。

**② 用 ContextVar 而不是塞字段**：built-in Tool 读 `current_request_context()` 拿 session_key/channel/message_id，同一 Tool 实例可以并发处理不同 session 的调用，不需要拷贝。

### 2.3 `_suggest_name` 只用于建议

```python
key = "".join(ch.lower() for ch in name if ch.isalnum())
# "Read_File" 和 "readfile" 都归一到 "readfile"
```

`# never for execution`。归一化 key 只用来在 tool 找不到时给 hint，绝不允许 LLM 用变体名字实际调工具。

## 三、Loader：三源装配

工具从三处来：

| 来源 | 发现方式 | 谁包 wrapper |
|---|---|---|
| 内置 | `pkgutil.iter_modules(nanobot.agent.tools)` 扫模块，抓 Tool 子类 | 无 |
| 外部 plugin | `entry_points(group="nanobot.tools")` | `_LegacyErrorPrefixTool` 把老式 `"Error: ..."` 转成 `ToolResult.error` |
| MCP server | `connect_mcp_servers` 遍历 config，建 session，list_tools 后包 `MCPToolWrapper` | `MCPToolWrapper` / `MCPResourceWrapper` / `MCPPromptWrapper` |

### 3.1 `discover` 四道过滤（[loader.py:30](../nanobot/agent/tools/loader.py#L30)）

```python
if module_name.startswith("_") or module_name in _SKIP_MODULES: continue  # ① 跳内部模块
issubclass(attr, Tool) and attr is not Tool                               # ② 是 Tool 子类且不是 Tool 本身
not attr_name.startswith("_")                                              # ③ 私有类跳过
not getattr(attr, "__abstractmethods__", None)                             # ④ 抽象类跳过
getattr(attr, "_plugin_discoverable", True)                                # ⑤ 显式关闭发现的跳过（wrapper 用）
```

`_SKIP_MODULES = {"base", "schema", "registry", "context", "loader", "config", "file_state", "sandbox", "mcp", "runtime_state"}`——这些是**基础设施**不是工具。

### 3.2 `load(ctx, registry, scope="core")` 四道装配闸

```python
if scope not in tool_cls._scopes: continue           # ① 阶段匹配
if not tool_cls.enabled(ctx):     continue           # ② 依赖检查
tool = tool_cls.create(ctx)                          # ③ 工厂化
if is_plugin_source: tool = _LegacyErrorPrefixTool(tool)  # ④ 外部 plugin 套 legacy wrapper
```

**名字冲突**：plugin 冲 builtin → 跳 plugin 保 builtin；plugin 冲 plugin / builtin 冲 builtin → 后者覆盖并 warn。

### 3.3 `_LegacyErrorPrefixTool` 存在意义

老 API 里 tool 用 `"Error: ..."` 字符串返错，新 API 用 `ToolResult.error(...)`。Wrapper 在 `execute` 结束后检查并转换。**向后兼容**：第三方 plugin 不用同步升级。builtin 已经全改。

## 四、一个具体 tool：`ExecTool`（[shell.py](../nanobot/agent/tools/shell.py)）

选 shell 是因为它把 tool 的**所有可选属性**全用上了。

```python
@tool_parameters(tool_parameters_schema(command=..., timeout=..., ...))
class ExecTool(Tool):
    _scopes = {"core", "subagent"}     # 主 agent 和 subagent 都能用
    config_key = "exec"                # ctx.config.exec 读配置
    @classmethod
    def enabled(cls, ctx): return ctx.config.exec.enable
    @classmethod
    def create(cls, ctx):
        cfg = ctx.config.exec
        return cls(working_dir=ctx.workspace, timeout=cfg.timeout, sandbox=cfg.sandbox, ...)
```

`exclusive = True`：shell 有 side-effect，不能和别的 tool 并发。

### 4.1 execute 六件事（[shell.py:287](../nanobot/agent/tools/shell.py#L287)）

```
① 别名兜底：command|cmd → command;  working_dir|workdir → working_dir
② _prepare_command:
   - current_tool_workspace 判定 access 域
   - restrict_to_workspace：判断 working_dir 是否在 workspace 内（防 LLM 传 /etc）
   - _guard_command:
       - allow_patterns 白名单先看
       - deny_patterns: rm -rf / mkfs / shutdown / fork bomb 直接拒
       - contains_internal_url（127.0.0.1、10./172./192. 内网）拒
       - path traversal（../）拒
       - _extract_absolute_paths 抓命令里所有绝对路径→逐一判是否在 workspace/media_dir 内
   - sandbox 包一层 bwrap
   - _build_env：最小环境（HOME/LANG/TERM），可选 allowed_env_keys
③ 分两条路径：
   - yield_time_ms 有值 → session manager 长任务
   - 否则 → asyncio.create_subprocess_exec + communicate(timeout=)
④ 结果解码 + STDERR 段拼接 + Exit code 尾附
⑤ 超 max_output_chars → 中间省略"...(N chars truncated)..."保头尾
⑥ 兜底 _reap_pid：手动 waitpid(WNOHANG) 防 zombie
```

**deny_patterns 里包含 `history.jsonl` / `.dream_cursor`**：跟模块 3 记忆系统绑定——直接 shell 改这两个文件会破坏 cursor 一致性，硬拒。

### 4.2 `current_tool_workspace` 和 ContextVar

Shell 不通过 ctx 参数拿 session_key，而是走 `current_request_session_key()` 读 ContextVar——`_execute_session`（长任务）需要把 `owner_session_key` 关联到 session_manager，用于 session 结束时清理孤儿后台进程。ContextVar 天然穿透 async 调用栈，不用改 tool 接口签名。

## 五、MCP：把远程服务器变成本地 tool

MCP（Model Context Protocol）= 把别人写的工具服务器（可能是任意语言、跑在别的进程/机器）伪装成 nanobot 本地 tool 的协议。

**Tool 抽象类的第三种实现** —— 它复杂不是因为设计特殊，是因为跨进程/跨网络。

### 5.1 MCP 规范 vs SDK

MCP 是**基于 JSON-RPC 2.0 的应用层协议**。规范定义线上格式，不定义任何语言的 API。

规范方法名与 SDK Python 方法的对应：

| SDK 方法 | 规范 JSON-RPC method |
|---|---|
| `session.initialize()` | `initialize` |
| `session.list_tools()` | `tools/list` |
| `session.call_tool(name, arguments)` | `tools/call` |
| `session.list_resources()` | `resources/list` |
| `session.read_resource(uri)` | `resources/read` |
| `session.list_prompts()` | `prompts/list` |
| `session.get_prompt(name, arguments)` | `prompts/get` |

`session.call_tool(...)` 内部：拼 JSON-RPC 帧 + 通过 stream 发送 + 等 id 对应的响应 + 反序列化成 `CallToolResult`。

### 5.2 一次调用的完整生命周期

**阶段 A：启动时 —— 建立连接、注册 tool**（[mcp.py:815](../nanobot/agent/tools/mcp.py#L815)）

```
1. 建 per-server AsyncExitStack（每个 server 独立）
2. 起 stdio_client / sse_client / streamable_http_client
   → 生出 (read, write) 双向 stream
3. read = _filter_malformed_mcp_progress_notifications(read, server_name)
4. session = ClientSession(read, write); await session.initialize()
5. tools = await session.list_tools()
6. 对每个 tool_def：
     wrapper = MCPToolWrapper(session, server_name, tool_def)
     wrapper._original_name = tool_def.name                   # 远程真名
     wrapper._name          = _sanitize_mcp_tool_name(f"mcp_{server}_{name}")
     wrapper._parameters    = _normalize_schema_for_openai(tool_def.inputSchema)
     registry.register(wrapper)
```

**阶段 B：LLM 调用**

```
LLM tool_call {name: "mcp_weather_forecast", arguments: {city: "BJ"}}
  → registry.execute → wrapper.execute(city="BJ")
  → await session.call_tool("forecast", arguments={"city": "BJ"})
  → 返回 CallToolResult(content=[TextContent("15°C 晴")])
  → 拼成字符串给 runner
```

**阶段 C：连接死了 —— 自动重连**

wrapper.execute 是个 while 循环，遇异常分三档：session terminated → 重连一次；transient → sleep 1s 重试一次；两次都不行 → 返 error。

### 5.3 三个 wrapper 类的分工（[mcp.py:425](../nanobot/agent/tools/mcp.py#L425)+）

| 类 | 包什么 | tool name |
|---|---|---|
| `MCPToolWrapper` | server 的 tools | `mcp_{server}_{tool}` |
| `MCPResourceWrapper` | server 的 resources（read_only=True） | `mcp_{server}_resource_{name}` |
| `MCPPromptWrapper` | server 的 prompts（read_only=True） | `mcp_{server}_prompt_{name}` |

三者继承 `_MCPWrapperBase`——共享连接管理：`_session`、`_server_name`、`_reconnect` handler、`_refresh_session_after_termination`。

### 5.4 tool name 双关键处理

```python
_sanitize_name(name)      # [^a-zA-Z0-9_-] → "_"，然后 _+ → 单一 _
_limit_tool_name(name)    # len > 64 → 前 55 字符 + sha1[:8]
```

**必须 sanitize**：Anthropic/OpenAI 对 tool name 有 `^[a-zA-Z0-9_-]{1,64}$` 约束。MCP server 可能自由命名（`weather.get_forecast`），直连注册会被 400。

**必须限长**：`mcp_{server}_{tool}` 三段拼接易超 64。sha1 后缀保证同一原名永远映到同一 sanitized 名字，跨启动稳定。

### 5.5 progress notification filter（[mcp.py:57-124](../nanobot/agent/tools/mcp.py#L57)）

有些 MCP server 会发**畸形的 `notifications/progress` 消息**——method 对但 `params` 里没 `progressToken`。MCP SDK 收到会 crash。所以在 `read` stream 外套一层过滤器：`method == "notifications/progress"` 且没 `progressToken` 就吞掉 continue。

**兼容层补丁**：上游没修但你等不了。

### 5.6 URL / DNS 安全（HTTP 类 MCP 特有，[mcp.py:171-238](../nanobot/agent/tools/mcp.py#L171)）

| 层 | 防的攻击 |
|---|---|
| `_probe_http_url` | 端口关着时 MCP SDK anyio cleanup 抛 ExceptionGroup 逃出 try/except 炸事件循环 |
| `validate_url_target` | 内网/环回 URL（AWS 元数据、内网服务）→ SSRF |
| `_validate_mcp_request_url`（挂 httpx event_hooks） | 每次请求包括**重定向**都重新校验 → 防 302 到内网绕过 |
| `PinnedDNSAsyncTransport` | DNS rebind：初次解析公网，实际请求被换成 127.0.0.1 |
| `_redact_url` | 日志脱敏 credentials / query / path |

**MCP server URL 是用户可配置的 = 攻击者可控输入**，每层都在堵一个具体攻击面。

### 5.7 独立 AsyncExitStack per server

MCP SDK 底层用 anyio task group。若共用一个 stack：weather server 挂了 → 它的 task group 炸 → 连带把 github server 的 cancel 掉。**独立 stack = 故障隔离**。

### 5.8 session terminated 重连的完整链（[mcp.py:1264-1352](../nanobot/agent/tools/mcp.py#L1264)）

wrapper.execute 的异常处理认三档：

```python
_TRANSIENT_EXC_NAMES = {
    "ClosedResourceError", "BrokenResourceError", "EndOfStream",
    "BrokenPipeError", "ConnectionResetError", "ConnectionRefusedError",
    "ConnectionAbortedError", "ConnectionError",
}
# session_terminated ⊇ transient；再加 message 里含 "session terminated"/"connection closed"
```

首次触发 `_refresh_session_after_termination`：

```
_refresh_terminated_server:
    async with _reload_lock(state):     # 同 server 多并发调用共用一次重连
        _unregister_server_tools(server_name)   # registry 里这个 server 的 tool 全注销
        _close_server(server_name)              # 旧 stack.aclose()
        connect_mcp_servers({server_name: cfg}, registry)  # 重建连接、握手、重新 register
        return registry.get(tool_name)  # 新 wrapper
```

**per-server 而非 per-tool**：一个 server 挂 → 它所有 tool wrapper 共享新 session。

**`refreshed_session` 是局部变量**：跨不同 tool 调用是重置的，每次调用都允许重连一次，不会因"上次重连过就永远不重连"僵局。

### 5.9 hot reload 必须在 loop 主任务里做

用户在 WebUI 改 MCP 配置想不重启生效：`request_mcp_reload(bus)` 发 `channel="system"` + `runtime_control=MCP_RELOAD` 的 InboundMessage → AgentLoop 岔口①拦截 → `handle_runtime_control` → `reload_servers` **同步**在 loop 主任务里做。

**为什么不能起新 task**：AsyncExitStack 里 stdio_client/sse_client 用的 anyio cancel scope 绑定到**创建它的 task**。在别的 task 里 `stack.aclose()` 抛 `RuntimeError("Attempted to exit a cancel scope in a different task than it was entered in")`。

`reload_servers` 三步 diff：

```
current_names ∩ next_names 里签名变了的 → changed
current_names - next_names → removed
next_names - current_names → added

removed + changed：先注销 tool 再 close server_stack
added + changed + retry_missing：connect_mcp_servers 重连
```

### 5.10 image 结果不进模型上下文

MCP tool 返 image 时，`_image_block_data_url` 抽 base64 → `store_generated_image_artifact` 落盘 → 返 `{artifacts: [{path: "..."}], next_step: "call message tool"}`。**base64 全程绕开模型上下文**，避免几 MB 图塞爆 context window。

### 5.11 `enabled_tools != ["*"]` 时不注册 resources/prompts

`enabled_tools` 是 per-tool 白名单。resources/prompts 没有等价白名单。若不做限制：operator 想只放开一个 tool，但同 server 的 resource 能读任意文件——白名单被绕过。**保守策略**：只要不是 `["*"]`，同时跳过 resource/prompt 注册。

## 六、Skills：只写 prompt 不写代码（[skills.py](../nanobot/agent/skills.py)）

Skills 在**工具通道之外**，是 system prompt 的补充。

### 6.1 SKILL.md frontmatter 契约

```yaml
---
name: cron
description: Schedule reminders and recurring tasks.
always: true                        # 可选
metadata:                            # 可选
  nanobot:
    requires:
      bins: [git, gh]                # 依赖的 CLI
      env: [GITHUB_TOKEN]            # 依赖的环境变量
---
```

`_check_requirements`：`shutil.which(cmd)` 检查每个 bin 在 PATH 里，`os.environ.get(var)` 检查每个 env 有值。任一不满足就 unavailable。

### 6.2 两条加载路径 —— always vs on-demand

- `get_always_skills()` 返 `always: true` 且 requirements 满足的：**完整 markdown 全文**塞进 system prompt 的第 ⑤ 段；
- `build_skills_summary(exclude=always)` 剩下的只给一句话摘要（name + description + path + 可用性）塞进第 ⑥ 段。LLM 想要完整内容自己 `read_file` 去读。

**分层动机**：skill 全塞进上下文会爆 token。always 表达"随时可能触发"（如 memory skill），其他只需要一句话让 LLM 知道"有这么个东西"。

### 6.3 workspace skills 覆盖 builtin

```
workspace/skills/         # 用户自定义（优先）
nanobot/skills/           # 项目自带
```

Workspace 里的**覆盖** builtin 同名的（`skip_names={workspace_names}`）。**不改代码就能覆盖 prompt** —— skill 系统存在的关键：把"怎么用 tool"从代码里解耦。

### 6.4 拼进 prompt 前剥 frontmatter

用 `_STRIP_SKILL_FRONTMATTER` 剥掉 YAML——那是给 loader 用的元数据，不是给 LLM 看的。

## 七、Tool vs Skill 的正交

| 维度 | Tool | Skill |
|---|---|---|
| 本质 | 代码（Python class + execute） | 文本（Markdown） |
| 进模型 | 作为 tools schema，LLM 通过 tool_call 调 | 作为 system prompt 片段 |
| 装配 | Loader/MCP 注册进 Registry | SkillsLoader 拼进 build_system_prompt 的 ⑤⑥ 段 |
| 依赖检查 | `enabled(ctx)`（class method） | frontmatter `requires` + `shutil.which` |
| 添加成本 | 写 Python + 处理 JSON Schema | 写 markdown |
| 触发者 | LLM 主动 `tool_call` | LLM 读到 skill 后决定用什么 tool |

**tool 提供"能力"（能做什么），skill 提供"知识"（怎么做）**。

## 八、模块 4 与其他模块的耦合

```
模块 2 build_system_prompt ─── tools schema (registry.get_definitions) 计入 token 预算
                            └─ always_skills / skills_summary (SkillsLoader) 拼 system prompt

模块 1 runner._execute_tools ─── registry.execute → prepare_call → tool.execute
                              └─ concurrency_safe / exclusive 决定 asyncio.gather 分批

ContextVar 层：
  runner 每轮开始 → request_context(RequestContext(session_key=..., channel=...))
  tool.execute() 里 → current_request_context() / current_request_session_key()

MCP hot reload：
  webui-settings → bus.publish_inbound(control=MCP_RELOAD)
  → AgentLoop 岔口① handle_runtime_control
  → mcp.reload_servers 在 loop 主任务里同步做（anyio cancel scope 约束）
```

**唯一耦合面四个**：
1. Registry 是**工具的唯一入口**——runner 只通过 registry 调；
2. ContextVar 是**tool 拿 session 上下文的唯一方式**——不改接口签名；
3. SkillsLoader 是**skill 进 prompt 的唯一入口**——直接嵌 system prompt；
4. MCP hot reload 通过 bus.control 消息**必须在 loop 主任务里**做——anyio task group 的 cancel scope task-bound。

## 九、一句话总结

> **模块 4 = "Tool 是自描述黑盒"的一次到底的抽象：schema 由 tool 自己声明、装配从三源合流（pkgutil builtins + entry_points plugins + MCP wrappers）在 Registry 汇集、runner 只按接口调用。ContextVar 让 tool 无痛拿 session 上下文，read_only/exclusive 让 runner 敢并发。MCP 是同一接口的远程版：wrap-per-tool、name sanitize/hash 限长、progress-notification 补丁 filter、pinned DNS 防 SSRF、per-server 独立 AsyncExitStack、session_terminated 一次重连（sleep 1s 兜底再一次）。Skills 完全正交：不写代码写 markdown，always 全文 + on-demand 摘要两档拼进 system prompt。**
