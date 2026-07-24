# 08 — `agent/tools/mcp.py`：生产级 MCP 客户端

> nanobot 1122 行 vs mini-agent 130 行 = **9 倍代码量**。多出来的全是边缘工程包浆：3 种 capability + 3 种 transport + 错误处理 + 重连 + 热重载 + SSRF + Windows 兼容 + Schema 适配。
>
> 一句话：**核心 wrapper 逻辑跟 mini-agent 几乎一样，多出来的全是"被生产事故喂出来的"。**

## 文件全貌

```
agent/tools/mcp.py (1122 行)
├── 顶部常量（行 29-46）
│   ├── _TRANSIENT_EXC_NAMES          ← 哪些异常算"临时"可重试
│   ├── _WINDOWS_SHELL_LAUNCHERS       ← Windows 上要包 shell 的命令
│   ├── _SANITIZE_RE                   ← 工具名字符过滤
│   └── _RELOAD_LOCKS                  ← 防并发重载的全局锁
│
├── 工具函数（行 49-204）
│   ├── _sanitize_name                 ← 工具名归一化
│   ├── _is_transient                  ← 判断是不是临时错误
│   ├── _is_session_terminated         ← 判断 session 是不是死了
│   ├── _probe_http_url                ← 启动前先 ping 一下 URL
│   ├── _validate_mcp_request_url      ← SSRF 防护
│   ├── _normalize_windows_stdio_command ← Windows 兼容
│   └── _normalize_schema_for_openai   ← schema 适配
│
├── 三个 Wrapper 体系 ★（行 205-577）
│   ├── _MCPWrapperBase                ← 共同基类，负责 reconnect
│   ├── MCPToolWrapper                 ← 包远程 tool（mini-agent 有的）
│   ├── MCPResourceWrapper             ← 包远程 resource（mini-agent 没有）
│   └── MCPPromptWrapper               ← 包远程 prompt（mini-agent 没有）
│
├── 启动连接（行 578-794）
│   └── connect_mcp_servers            ← 连所有 server，三种 transport 分支
│
└── 运行时管理（行 859-1122）
    ├── connect_missing_servers        ← 增量连新加的 server（不重启）
    ├── reload_servers                 ← 配置变更后热重载
    ├── request_mcp_reload             ← 通过 bus 触发重载
    ├── handle_runtime_control         ← 接收"重载 MCP"系统消息
    ├── _attach_reconnect_handlers     ← 给 wrapper 装 reconnect 回调
    ├── _refresh_terminated_server     ← session 死了时重连
    └── _unregister_server_tools       ← 卸下某 server 的所有工具
```

→ **mini-agent 只做了图里"启动连接 + MCPToolWrapper"两块，其他都是 nanobot 为生产环境补的。**

## 三种 wrapper 解决什么问题

### MCP 协议有三种"能力"（capability）

```
MCP Server 暴露三种东西：
  ├── tools     ← 可以"调用执行"的能力（类似函数）
  ├── resources ← 可以"读取内容"的能力（类似只读文件）
  └── prompts   ← 可以"获取模板"的能力（类似预写好的 prompt 片段）
```

举个具体例子，假设你有个 "knowledge-base" MCP server：

| 能力类型 | 例子 | 用法 |
|---|---|---|
| tool | `search_kb(query)` | 让 LLM 主动调用搜索 |
| resource | `kb://articles/123` | 让 LLM 把某篇文章当只读上下文 |
| prompt | `summarize_article` | 给 LLM 一个预写好的摘要模板 |

### 三个 wrapper 各包一种

```python
class MCPToolWrapper(_MCPWrapperBase):       # 包 tool
    async def execute(self, **kwargs):
        result = await self._session.call_tool(self._original_name, arguments=kwargs)

class MCPResourceWrapper(_MCPWrapperBase):    # 包 resource
    @property
    def read_only(self) -> bool:
        return True                            # ← 关键：标记为只读
    async def execute(self, **kwargs):
        result = await self._session.read_resource(self._uri)

class MCPPromptWrapper(_MCPWrapperBase):      # 包 prompt
    @property
    def read_only(self) -> bool:
        return True
    async def execute(self, **kwargs):
        result = await self._session.get_prompt(self._prompt_name, arguments=kwargs)
```

→ **目的相同**：把不同协议方法（`call_tool` / `read_resource` / `get_prompt`）**统一伪装成 nanobot Tool**。
LLM 看到的是 `mcp_kb_search_kb`、`mcp_kb_resource_articles_123`、`mcp_kb_prompt_summarize_article` —— 都是工具，没有协议差异。

### 命名前缀区分类型

```
mcp_<server>_<tool_name>           ← 普通工具
mcp_<server>_resource_<res_name>   ← 资源
mcp_<server>_prompt_<prompt_name>  ← prompt
```

中间多一段 `resource_` / `prompt_` 防止重名（同一个 server 可能 tool 和 resource 同名）。

### 为什么 mini-agent 没做后两个

**因为生态里 90% MCP server 只暴露 tools**。
resources 和 prompts 是 MCP 协议的扩展能力，目前用得很少：
- resources 适合"动态文档库"场景（比如 GitHub、Notion 集成）
- prompts 适合"工作流模板"场景（比如 code review 流程）

mini-agent 现在接的是 `server-memory`、`server-filesystem` 这种纯 tool server，根本没碰到 resources/prompts。**等真接到带 resources 的 server 再补也来得及。**

### 共同基类 `_MCPWrapperBase`

```python
class _MCPWrapperBase(Tool):
    def _set_mcp_connection(self, session, server_name):
        self._session = session
        self._server_name = server_name
        self._reconnect = None  # ← 重连回调

    def set_reconnect_handler(self, reconnect):
        self._reconnect = reconnect

    async def _refresh_session_after_termination(self, exc, already_refreshed, kind):
        # 检测 session 是不是死了，死了就调 reconnect
        ...
```

**职责单一**：所有 wrapper 共享的"session 维护 + 重连"逻辑。每个 wrapper 子类只负责自己那一种 RPC 方法。

→ 经典 OO 应用：把"对所有子类都一样"的代码提到基类。
mini-agent 只有一种 wrapper，所以这层没必要。

## 三种 transport 解决什么问题

**MCP 协议是用来传 JSON-RPC 消息的，但消息怎么走有 3 种选择**：

```python
if transport_type == "stdio":            # 1. 本地进程通过 stdin/stdout 通信
    read, write = await stdio_client(params)
elif transport_type == "sse":             # 2. 远程通过 Server-Sent Events
    read, write = await sse_client(cfg.url, ...)
elif transport_type == "streamableHttp":  # 3. 远程通过流式 HTTP（新版协议）
    read, write = await streamable_http_client(url, ..., http_client)
```

### 三种 transport 对比

| transport | 适用场景 | 特点 | mini-agent 支持 |
|---|---|---|---|
| **stdio** | 本地工具 | spawn 子进程 → 用 stdin/stdout 双向 JSON | ✅ |
| **sse** | 远程服务器（旧版） | HTTP GET 长连接，server 一直推 SSE | ❌ |
| **streamableHttp** | 远程服务器（新版） | HTTP POST 流式响应，更高效 | ❌ |

### 为什么有这么多种

| 触发场景 | 选哪种 transport |
|---|---|
| 想接本地 `npx server-memory` | stdio（最简单，spawn 子进程） |
| 想接公司内部部署的 MCP gateway | sse 或 streamableHttp（HTTP 协议，能过防火墙、能负载均衡） |
| 接 Anthropic 官方托管的 MCP | streamableHttp（最新规范） |

**本地 vs 远程**是核心选择：
- stdio 要求 server 跟 agent 同一台机器（spawn 子进程）
- sse / streamableHttp 可以跨机器跨网络

mini-agent 接的全是 npm 包形式的 server（stdio），所以**不需要**远程 transport。

### 远程 transport 多两件事：URL 探测 + SSRF 防护

```python
# 远程 transport 启动前：
if not await _probe_http_url(cfg.url):
    logger.warning("MCP server '{}': {} unreachable, skipping", name, cfg.url)
    return name, None

# 每个请求都会过 hook：
event_hooks={"request": [_validate_mcp_request_url]},
```

`_probe_http_url`：发个 HEAD 请求，3 秒超时，**失败就跳过这个 server**。
为什么需要？远程 server 可能挂了——如果 connect 时阻塞 30 秒，启动体验很差。

`_validate_mcp_request_url`：每个 HTTP 请求前检查 URL，**禁止 127.0.0.1 / 内网 IP / file:// 等危险目标**。
这是 SSRF（Server-Side Request Forgery）防护——防止攻击者通过配置 MCP server URL 让你的进程去访问内网资源。

→ 本地 stdio 不需要这两层（没有网络），所以 mini-agent 不做完全合理。

### Windows 特殊处理

```python
_WINDOWS_SHELL_LAUNCHERS = frozenset(("npx", "npm", "pnpm", "yarn", "bunx"))

def _normalize_windows_stdio_command(command, args, env):
    # Windows 上 npx 不能直接 spawn，要包一层 cmd /c
    ...
```

为什么？**Windows 上 `npx` 是 .cmd 批处理脚本**，Node 的 child_process 直接 spawn 会失败。要包成 `cmd.exe /c npx ...`。
mini-agent 在 Mac 跑，没遇到——但要做跨平台，这一段必抄。

## 重试与重连：双保险机制

`MCPToolWrapper.execute` 里那 60 多行错误处理是精华。看核心结构：

```python
async def execute(self, **kwargs):
    retried_transient = False      # 临时错误标志
    refreshed_session = False       # session 重连标志
    while True:                     # ← 用 while + continue 实现可重入
        try:
            result = await asyncio.wait_for(
                self._session.call_tool(self._original_name, arguments=kwargs),
                timeout=self._tool_timeout,
            )
        except asyncio.TimeoutError:
            return f"(MCP tool call timed out after {self._tool_timeout}s)"

        except asyncio.CancelledError:
            # 区分"用户主动 /stop"和"SDK 内部 cancel scope 泄漏"
            task = asyncio.current_task()
            if task is not None and task.cancelling() > 0:
                raise
            return "(MCP tool call was cancelled)"

        except Exception as exc:
            # 1. 先看是不是 session 死了 → 试图重连
            if await self._refresh_session_after_termination(
                exc, refreshed_session, "tool",
            ):
                refreshed_session = True
                continue            # ← 重连成功，重试一次

            # 2. 再看是不是临时错误 → 退避一秒重试
            if _is_transient(exc):
                if not retried_transient:
                    retried_transient = True
                    await asyncio.sleep(1)
                    continue        # ← 退避后重试

                # 第二次还失败，给 retry-specific 错误信息
                return f"(MCP tool call failed after retry: {type(exc).__name__})"

            # 3. 永久错误 → 直接报错
            return f"(MCP tool call failed: {type(exc).__name__})"
        else:
            # 成功路径
            return "\n".join(...)
```

注意三层处理：

### 1. session 死了 → 重连一次

```python
def _is_session_terminated(exc: BaseException) -> bool:
    # 检测 "Session terminated" / "ClosedResourceError" 等标志
```

stdio 子进程崩溃、SSE 连接断开、HTTP 502 都会触发。**整个 server 的连接都死了**，不是单次调用问题。

`_refresh_session_after_termination` 会调 `_reconnect` 回调（外层注入的），让外层去重新 spawn 子进程或重建 HTTP 连接。**重连成功后这次工具调用 retry**，对 LLM 透明。

### 2. 临时错误 → 退避一次

```python
_TRANSIENT_EXC_NAMES = frozenset((
    "ReadTimeout", "ConnectTimeout", "ConnectError", "RemoteProtocolError",
    "TransportError", "BrokenResourceError", ...
))

def _is_transient(exc: BaseException) -> bool:
    return type(exc).__name__ in _TRANSIENT_EXC_NAMES
```

网络抖动、服务过载 → 等 1 秒重试一次。**只重试一次**——再失败就放弃，不要 hammer。

### 3. CancelledError 的特殊处理

```python
except asyncio.CancelledError:
    task = asyncio.current_task()
    if task is not None and task.cancelling() > 0:
        raise          # ← 用户 /stop，应该传播
    # SDK 内部 cancel scope 泄漏，不应该传播
    return "(MCP tool call was cancelled)"
```

这一段最绝。**MCP SDK 用了 anyio 的 cancel scope，超时/失败时会"假装"抛 CancelledError**——但用户其实没真按 /stop。

如果直接 raise，会被解读为"用户主动取消"，整个 turn 都中断。
正确做法是看当前 task 的 `cancelling()` 计数：
- 真用户 cancel → 计数 > 0 → 传播
- SDK 误抛 → 计数 == 0 → 当成"工具失败"返回字符串

→ **这一段是被 MCP SDK bug 喂出来的**。光读不练永远写不出来。

### 三层处理的优先级

```
session 死了    → 重连后立即重试（不计入 retry 次数）
临时错误        → 退避 1s 重试一次
永久错误        → 直接报错
真用户 cancel    → 传播
SDK 误 cancel   → 当作工具失败返回
```

mini-agent 的版本只有"任何异常 → 转字符串"。够用，但生产场景下：
- **session 断了不重连，整个 server 永远不可用**
- **网络抖一下，所有依赖 MCP 的 turn 都失败**

## 启动 + 运行时管理

mini-agent 的 MCP 启动一次就完事。nanobot 还做了三件运行时管理：

### 1. `connect_missing_servers`：增量连接

```python
async def connect_missing_servers(state, registry):
    """配置加了新 server，但其他 server 还在跑 → 只连新的"""
```

不重启进程就能加新 MCP server。
**场景**：用户在配置文件里新增一个 server，UI 上点"应用配置"，agent 不重启。

### 2. `reload_servers`：热重载

```python
async def reload_servers(state, registry):
    """配置变了 → 关旧的连接 → 用新配置重连"""
```

通过 `_server_signature(cfg)` 检测哪些配置变了。**只重启变化的 server**，没变的不动——避免不必要的中断。

### 3. `handle_runtime_control` + `request_mcp_reload`：通过 bus 触发

```python
async def request_mcp_reload(bus, *, timeout=15.0):
    """从外部（比如 slash 命令）触发 MCP 重载"""
```

`/reload-mcp` 这种 slash 命令最终会调到这里。**让用户在不重启 agent 的情况下应用 MCP 配置变更**。

### `_attach_reconnect_handlers`：依赖反转

```python
def _attach_reconnect_handlers(state, registry, server_names):
    async def reconnect(server_name, tool_name, stale_tool):
        # 重连 server，找到同名新 wrapper，把 session 拷过去
        ...
    for tool in tools_of(server_names):
        tool.set_reconnect_handler(reconnect)
```

这是把"运行时管理"和"wrapper 内部错误处理"串起来的胶水。
wrapper 在 `_refresh_session_after_termination` 里调 `self._reconnect(...)`，`_attach_reconnect_handlers` 注入了具体的 reconnect 函数。

→ **wrapper 不直接知道怎么重连**（因为重连需要访问 transport / config / state，wrapper 没这些信息）；通过回调把"重连这件事"委托给外层。**依赖反转模式**。

## 跟 mini-agent 的完整对比

| 议题 | mini-agent | nanobot |
|---|---|---|
| Wrapper 类型 | 1 个 (Tool) | 3 个 (Tool/Resource/Prompt) + 共同基类 |
| Transport | stdio | stdio + sse + streamableHttp |
| URL 探测 | ❌ | `_probe_http_url` 启动前 ping |
| SSRF 防护 | ❌ | `_validate_mcp_request_url` 拦截内网 |
| Windows 兼容 | ❌ | `_normalize_windows_stdio_command` |
| Schema 转换 | zod passthrough | `_normalize_schema_for_openai` 完整处理 nullable / union |
| 临时错误重试 | ❌ | `_is_transient` + 退避 1s + 重试一次 |
| Session 死了重连 | ❌ | `_refresh_session_after_termination` + reconnect 回调 |
| CancelledError 区分 | ❌ | 真 cancel vs SDK 误抛 |
| Session 配额超时 | 60s 简单超时 | 工具/resource/prompt 各自独立 timeout |
| 增量连接新 server | ❌（重启进程） | `connect_missing_servers` |
| 配置热重载 | ❌ | `reload_servers` + `_server_signature` 比较 |
| 运行时控制（bus 触发） | ❌ | `handle_runtime_control` + `/reload-mcp` |

→ **mini-agent 130 行 vs nanobot 1122 行 = 9 倍代码量**。
但**核心 wrapper 逻辑几乎一样**，多出来的全是边缘：
- 多 capability 类型（resource / prompt）
- 多 transport
- 错误处理 + 重连
- 运行时管理

## 60 行错误处理 = 一部生产事故史

把 `MCPToolWrapper.execute` 那段错误处理拆开看：

```
被坑场景                                       对应代码
────────────────────────────────────────────────────────────
1. session 死了不重连                       → 加 _refresh_session_after_termination
2. 网络抖动一次就失败                       → 加 _is_transient + 重试一次
3. 重试无限次烧服务器                       → 加 retried_transient flag 限制 1 次
4. 用户 /stop 但 try/except 吃了 CancelledError → 看 task.cancelling() 区分
5. SDK anyio cancel scope 泄漏              → cancelling() == 0 时不传播
6. 超时报错信息跟其他错误混在一起           → asyncio.wait_for 单独处理 TimeoutError
7. 重连成功后还要不要 retry?                → refreshed_session flag 区分
8. 最后给 LLM 的错误信息要带 retry 上下文   → "failed after retry" vs "failed"
```

**8 个 commit 写出这 60 行**——每个 commit 对应一个真实生产事故。

→ 看陌生代码先想"这是为了不再被什么坑"——这就是这一段的最佳样本。

## 一句话总结

> **mini-agent 的 mcp.py 130 行 = "MCP 协议接入的最小集合：能用就行"。**
> **nanobot 的 mcp.py 1122 行 = "最小集合 + 8 类工程包浆"**：3 种 capability + 3 种 transport + 错误处理 + 重连 + 热重载 + SSRF + Windows 兼容 + Schema 适配。
>
> 关键设计：
> - 三个 Wrapper（Tool/Resource/Prompt）+ 共同基类 = 协议方法异，工具语义同
> - 三种 transport 启动分支 = 本地 / 远程旧 / 远程新
> - `_refresh_session_after_termination` + `_is_transient` 双层 = 区分"server 死了"和"网络抖了"
> - `task.cancelling() > 0` = 区分真用户 cancel 和 SDK 误抛
> - `_attach_reconnect_handlers` = 依赖反转，wrapper 不直接知道怎么重连
> - `connect_missing_servers` + `reload_servers` = 不重启进程加 / 改 server

## 给读 nanobot 的检查清单

读到 mcp.py 任何一段陌生代码，问自己：

1. **它在哪一层？** → wrapper（每次调用） vs connect（启动） vs reload（运行时）
2. **它处理的是哪种 capability？** → tool / resource / prompt
3. **它处理的是哪种 transport？** → stdio / sse / streamableHttp
4. **它在解决哪个真实生产场景？** → 找不到的话可能现在还不需要懂

## 可以抄回 mini-agent 的 5 个改造

按学习收益排序：

| 改造 | 工作量 | 价值 |
|---|---|---|
| 加 `_is_transient` + 临时错误重试 | 30 分钟 | 网络抖动不再让所有 turn 失败 |
| 加 session 死了重连 | 1 小时 | server 崩溃后能自动恢复 |
| 加 CancelledError 区分 | 30 分钟 | SDK bug 不让 turn 错误中断 |
| 加 streamableHttp transport | 半天 | 能接远程 MCP server |
| 加 MCPResourceWrapper | 半天 | 能接 GitHub / Notion 这种"资源型" MCP |

前三个加完，**mini-agent 的 MCP 客户端立刻有了 nanobot 70% 的鲁棒性**。
第四第五个等真有需求再说。
