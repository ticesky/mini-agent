# 步骤 2.4 — MCP 客户端接入

> 对应 plan.md 的 Day 2 第 4 步。把远程 MCP server 的工具接入 ToolRegistry。

## 目标

通过 `--mcp-config <file>` 指定一组 MCP server，启动时自动连上、列工具、注册到 registry，让 LLM 能像调本地工具一样调远程工具。

## 交付清单

```
src/mcp/client.ts    ≈ 130 行 — connectMcpServer / closeMcpConnection / makeMcpToolWrapper
mcp.example.json     示例配置（接 @modelcontextprotocol/server-memory）
src/index.ts         加 --mcp-config 选项 + 启动连接 + 退出关闭
```

## 关键设计

### 1. 一句话理解 MCP

> MCP server 把"工具"以 JSON-RPC 方式暴露在子进程的 stdin/stdout 上，
> 客户端连过去 → `listTools()` → 拿到 schema → `callTool({name, arguments})` → 拿到结果。

跟我们已有的 ToolRegistry 抽象**一一对应**：
- `listTools()` ≈ `registry.getDefinitions()`
- `callTool(...)` ≈ `tool.execute(...)`

所以本质上 MCP 客户端做的事就是：**在两个 ToolRegistry 之间架一座桥**。

### 2. MCPToolWrapper —— 把远程工具包成本地 Tool

整个 MCP 接入的精华就这一个函数：

```ts
function makeMcpToolWrapper(args): Tool {
  const schema = z.object({}).passthrough();    // 宽松 schema，校验交给 server

  return {
    name: args.localName,
    description: args.description,
    schema,
    readOnly: false,
    async execute(input, _ctx) {
      try {
        const result = await args.client.callTool({
          name: args.remoteName,
          arguments: input as Record<string, unknown>,
        });
        // 拍平 ContentBlock[] 成字符串
        return blocks.map(b => b.type === "text" ? b.text : JSON.stringify(b)).join("\n");
      } catch (e) {
        return `Error: MCP tool '${args.remoteName}' failed: ${...}`;
      }
    },
  };
}
```

注意点：

#### a) 名字加前缀防冲突

```ts
const localName = `mcp_${cfg.name}_${remote.name}`;
```

不同 MCP server 都可能暴露 `read_file` 工具，加 `mcp_<server>_` 前缀避免重名。
对应 nanobot 的 `_sanitize_name(f"mcp_{server_name}_{tool_def.name}")`。

#### b) schema 用 passthrough 兜底

```ts
const schema = z.object({}).passthrough();
```

为什么不把 MCP 的 inputSchema 转成 zod schema？两个原因：
1. **zod 没法表达任意 JSON Schema**（特别是 union / oneOf / 引用）
2. **重复校验**：MCP server 自己会校验，我们再校一遍是浪费

代价：mini-agent 这层不再校验参数，但 LLM 看到的仍然是**MCP server 给出的真 JSON Schema**（通过 `description` 字段或后续直接传 raw schema 都能实现），这是后话。MVP 就让 server 自己报错回来，反正 registry.execute 把错误回填给 LLM 自纠错。

#### c) ContentBlock[] 拍平成字符串

MCP `callTool` 返回的 `result.content` 是 `(text | image | resource)[]`，跟 Anthropic 的设计一脉相承（同一个团队搞的）。我们拍平成字符串：

```ts
for (const b of blocks) {
  if (b.type === "text") parts.push(b.text);
  else parts.push(JSON.stringify(b));      // image / resource 暂时序列化交给 LLM
}
```

未来要支持图像/资源就需要扩展 `Tool.execute()` 的返回类型。MVP 拍平就行。

### 3. 启动 + 关闭流程

```ts
async function connectMcpServer(cfg, registry) {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: { ...process.env, ...cfg.env },
  });

  const client = new Client(
    { name: "mini-agent", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);

  const { tools } = await client.listTools();
  for (const remote of tools) {
    registry.register(makeMcpToolWrapper({ ... }));
  }
  return { config: cfg, client, registeredTools: [...] };
}
```

关闭时：

```ts
async function closeMcpConnection(conn, registry) {
  for (const name of conn.registeredTools) {
    registry.unregister(name);              // 防止退出阶段的 LLM 调用看到坏工具
  }
  await conn.client.close();                // 这会自动关 transport（kill 子进程）
}
```

对应 nanobot：`agent/tools/mcp.py:581-756` 的 `_connect_servers` + `_unregister_server_tools`。

### 4. 配置文件格式

仿照 Claude Desktop / Cursor 的 MCP 配置格式：

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

每个 key 是 server 的逻辑名（会变成 `mcp_memory_<tool>` 前缀），value 是 stdio 子进程的命令配置。

## 验证

跑一个真 MCP server 看效果（用官方的 memory server）：

```
$ pnpm dev chat --mcp-config ./mcp.example.json

[mcp] connecting memory: npx -y @modelcontextprotocol/server-memory
Knowledge Graph MCP Server running on stdio
[mcp] memory: 9 tool(s) → mcp_memory_create_entities, mcp_memory_create_relations,
       mcp_memory_add_observations, mcp_memory_delete_entities, mcp_memory_delete_observations,
       mcp_memory_delete_relations, mcp_memory_read_graph, mcp_memory_search_nodes,
       mcp_memory_open_nodes

> 请用 read_graph 工具读一下知识图谱里有什么
  ⚙ mcp_memory_read_graph()
    ↳ {
知识图谱目前是空的，没有任何实体或关系。
[steps=2 in=1182 out=30]
```

九个 MCP 工具自动注册成功，LLM 看到这些 `mcp_memory_*` 工具的 schema 后正确选择并调用。返回结果被拍平成字符串塞回历史，LLM 给出最终回答。

## 跟 nanobot 的差异

| 议题 | nanobot 做法 | mini-agent 做法 |
|---|---|---|
| Transport | stdio + SSE + HTTP | 仅 stdio |
| 重连 | 自动检测 session 失效 + 重连 | 不做（连失败直接报错） |
| 临时错误重试 | 一次 retry + backoff | 不做 |
| 资源（resources） | 注册成只读 Tool | 不做 |
| Prompt 注入 | 注册成 Tool | 不做 |
| Session refresh | 检测 transport 断开后重启进程 | 不做 |

`mcp.py:272-336` 的 `MCPToolWrapper.execute` 那 60+ 行错误处理，几乎全是被生产 bug 喂出来的。MVP 用一个 try/catch 顶住先。
