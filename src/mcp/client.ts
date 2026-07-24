/**
 * MCP（Model Context Protocol）客户端 —— 把远程 MCP server 的工具
 * 包装成本地 nanobot Tool 注册到 ToolRegistry。
 *
 * 对应 nanobot/agent/tools/mcp.py 的 MCPToolWrapper（极简版）。
 *
 * 设计：
 *   - 每个 server 一个 Client，启动时 list_tools 拿到全部 tool schema
 *   - 每个远程 tool 包成一个 MCPTool 实例，name 形如 "mcp_<server>_<tool>"
 *   - 调用时 client.callTool() 把 input 透传过去
 *   - Tool 的 schema 用一个"宽松对象"描述：因为 MCP 给的是任意 JSON Schema，
 *     而我们的 Tool 抽象期望 zod schema。这里用 z.object({}).passthrough() 兜底，
 *     真校验交给 MCP server 自己。
 *
 * MVP 只支持 stdio 一种 transport（最常见，也是官方示例 server 用的）。
 */
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { Tool, ToolContext } from "../tools/base.ts";
import type { ToolRegistry } from "../tools/registry.ts";

/** 单个 MCP server 的配置。 */
export interface McpServerConfig {
  /** server 在 registry 里使用的 name 前缀，如 "fs" → mcp_fs_<tool>。 */
  name: string;
  /** 启动 server 进程的命令。 */
  command: string;
  /** 命令参数。 */
  args?: string[];
  /** 额外的环境变量。 */
  env?: Record<string, string>;
}

/** 已连接的 MCP server 状态。 */
export interface McpConnection {
  config: McpServerConfig;
  client: Client;
  /** 已注册到 registry 的工具名列表，断开时用来注销。 */
  registeredTools: string[];
}

/**
 * 启动一个 MCP server，把它暴露的 tool 包装并注册到 registry。
 * 返回 McpConnection，调用方在退出时调 close() 优雅关闭。
 */
export async function connectMcpServer(
  cfg: McpServerConfig,
  registry: ToolRegistry,
): Promise<McpConnection> {
  // 1. 启动 stdio transport（spawn 子进程，stdin/stdout 走 JSON-RPC）
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    ...(cfg.env ? { env: { ...process.env, ...cfg.env } as Record<string, string> } : {}),
  });

  // 2. 建 Client，握手
  const client = new Client(
    { name: "mini-agent", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);

  // 3. 列出所有 tool
  const { tools: remoteTools } = await client.listTools();

  // 4. 包装成本地 Tool 并注册
  const registered: string[] = [];
  for (const remote of remoteTools) {
    const localName = `mcp_${cfg.name}_${remote.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
    const wrapped = makeMcpToolWrapper({
      localName,
      remoteName: remote.name,
      description: remote.description ?? remote.name,
      client,
    });
    registry.register(wrapped);
    registered.push(localName);
  }

  return {
    config: cfg,
    client,
    registeredTools: registered,
  };
}

/** 优雅断开：注销 registry 里的工具，关闭 client 与底层进程。 */
export async function closeMcpConnection(
  conn: McpConnection,
  registry: ToolRegistry,
): Promise<void> {
  for (const name of conn.registeredTools) {
    registry.unregister(name);
  }
  try {
    await conn.client.close();
  } catch {
    // 忽略关闭错误
  }
}

/** 包装一个远程 MCP tool 成本地 Tool。 */
function makeMcpToolWrapper(args: {
  localName: string;
  remoteName: string;
  description: string;
  client: Client;
}): Tool {
  // MCP 的参数 schema 是任意 JSON Schema，用 zod 没法精确表达。
  // 用一个 passthrough 对象先放过去——实际参数校验交给 server 自己。
  const schema = z.object({}).passthrough();

  return {
    name: args.localName,
    description: args.description,
    schema,
    readOnly: false, // 保守起见：MCP tool 默认按写工具串行
    async execute(input: unknown, _ctx: ToolContext): Promise<string> {
      try {
        const result = await args.client.callTool({
          name: args.remoteName,
          arguments: (input as Record<string, unknown>) ?? {},
        });
        // result.content 是 ContentBlock[]，把 text 块拼起来返回
        const blocks = (result.content as unknown as Array<
          { type: string; text?: string }
        >) ?? [];
        const parts: string[] = [];
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string") {
            parts.push(b.text);
          } else {
            parts.push(JSON.stringify(b));
          }
        }
        return parts.join("\n") || "(无输出)";
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `Error: MCP tool '${args.remoteName}' failed: ${msg}`;
      }
    },
  };
}
