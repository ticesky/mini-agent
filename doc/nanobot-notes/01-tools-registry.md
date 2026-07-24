# 01 — `agent/tools/registry.py`：动态注册的真实需求

> nanobot 的 ToolRegistry（182 行）跟 mini-agent 的 `tools/registry.ts` 几乎是双胞胎。
> 主要差异：nanobot 把 builtin / mcp_ 工具分桶排序（mini-agent 统一字典序）。

## 主要相似点

- 内部都是 `dict[str, Tool]` / `Map<string, Tool>`
- 都暴露 `register / unregister / has / get / execute`
- 都有 `prepareCall` 三步走：找工具 → cast → validate
- 都做"参数 JSON 字符串反序列化"的 coerce 兜底
- 都把工具异常翻译成字符串 + 提示语回灌给 LLM

→ **核心抽象稳到几乎没什么变化空间**。这就是"核心精简"的真实威力。

## 关键差异：分桶排序

```python
def get_definitions(self):
    builtins, mcp_tools = [], []
    for schema in definitions:
        if name.startswith("mcp_"):
            mcp_tools.append(schema)
        else:
            builtins.append(schema)
    builtins.sort(key=...)
    mcp_tools.sort(key=...)
    return builtins + mcp_tools
```

为什么这么做？

- **prompt cache 友好**：builtin 工具集合在不同 session 间稳定，放前面更易命中 cache
- **MCP 工具集合可能因 server 增减而变**，放后面变化只影响 cache 后段

mini-agent 现在不需要这个优化（工具少且固定），但**这是日后值得抄的细节**。

## "Dynamic Registration" 真正解决的问题

刚开始读到 docstring 里 "Allows dynamic registration and execution of tools" 觉得是"听起来高级的术语"。
但仔细想：**只用 3 个内置工具时，硬编码 Map 完全够用**——为什么 nanobot 还要"dynamic"？

### 真正逼出动态注册的 4 个场景

#### 1. MCP 工具

```ts
// 启动时不知道 MCP server 暴露什么工具
const conn = await connectMcpServer(cfg, registry);
// server.listTools() 返回后才知道有 9 个工具要注册
for (const remote of tools) {
  registry.register(makeMcpToolWrapper({...}));  // ← 运行时才执行
}
```

如果是静态注册，**根本接不进 MCP**。

#### 2. MCP server 断开重连

```ts
await closeMcpConnection(conn, registry);   // unregister 9 个工具
const conn2 = await connectMcpServer(cfg, registry);  // 重新 register
```

**unregister 不是装饰性 API，是真有人用。**

#### 3. 多用户/多 session 工具集差异

- 用户 A 的 session 启用了 web 搜索
- 用户 B 的 session 没启用
- 用户 A 在对话过程中调用 `/disable web_search`

每个 session 有自己的 registry，工具组合**因人而异、因时而异**。

#### 4. 插件 / entry_points 自动发现

```python
for entry in importlib.metadata.entry_points(group="nanobot.tools"):
    cls = entry.load()
    registry.register(cls(...))
```

第三方包通过 entry_points 注册的工具，**进程启动时**才被发现。

## 一句话总结

> **"动态注册"不是为了花哨，是为了让以下三种事可能：**
>
> 1. 运行时才知道有什么工具（MCP）
> 2. 运行时才知道哪些工具该启用（per-session、per-user）
> 3. 运行时才发现工具的存在（插件 / entry_points）

mini-agent 已经支持 MCP，**已经在用动态注册了**。那条 docstring 不是描述能力，是描述刚需。

## 反例：为什么 LLM provider **没有** 动态注册

mini-agent 和 nanobot 的 provider 系统都是静态的：

```ts
const provider = new AnthropicProvider({ apiKey });  // 硬编码
```

为什么 provider 可以静态、tool 必须动态？

- **provider**：一个进程通常只用一家（或固定 fallback 链）。运行时切 provider 是罕见操作
- **tool**：MCP / per-session 都要求运行时调整，**频率高得多**

→ **能不能用动态注册，看的是"运行时变化频率"**，不是"听起来高级"。

## 判断"某抽象是否有真实价值"的方法

**找一个让它静态化就破功的场景**：

- 找不到 → 这层抽象是装饰
- 找得到 → 它是刚需

回头看 mini-agent `index.ts`：

```ts
// 前 3 行只是"用动态接口做静态注册"——可以用 hardcoded Map
registry.register(readFileTool);
registry.register(writeFileTool);
registry.register(bashTool);

// 后面 MCP 那一段如果没有动态注册根本写不出来 ←
if (opts.mcpConfig) {
  for (const [name, server] of ...) {
    const conn = await connectMcpServer({ name, ...server }, registry);
  }
}
```

**找到这种"破功的场景"就是判断抽象价值的钥匙。**
