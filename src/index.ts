/**
 * CLI 入口 —— 用 commander 注册子命令，把 provider/registry/tools/runner/CLI 串起来。
 *
 * 用法：
 *   pnpm dev chat                       # 启动交互式对话
 *   pnpm dev chat --workspace /tmp/xxx  # 指定工作目录
 *
 * 对应 nanobot/cli/commands.py（极简版）。
 */
import { config as loadEnv } from "dotenv";
import { Command } from "commander";
import { resolve } from "node:path";
import { stdout } from "node:process";

import type { Message } from "./types.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { readFileTool } from "./tools/readFile.ts";
import { writeFileTool } from "./tools/writeFile.ts";
import { bashTool } from "./tools/bash.ts";
import { todoWriteTool } from "./tools/todoWrite.ts";
import { webSearchTool } from "./tools/webSearch.ts";
import { webFetchTool } from "./tools/webFetch.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { runTurn } from "./agent/runner.ts";
import { MessageBus, runAgentLoop } from "./agent/loop.ts";
import { CliChannel } from "./channels/cli.ts";
import { SessionStore } from "./session/memory.ts";
import { maybeCompact } from "./session/compact.ts";
import {
  closeMcpConnection,
  connectMcpServer,
  type McpConnection,
  type McpServerConfig,
} from "./mcp/client.ts";

// .env 优先级高于 shell 环境（项目级配置 > 全局）
loadEnv({ override: true });

const DEFAULT_MODEL = "claude-sonnet-4-6";
const SYSTEM_PROMPT =
  "你是一个运行在用户本地终端的小型 AI 助手。" +
  "你能调用以下工具：read_file / write_file / bash 读写文件和跑命令；" +
  "TodoWrite 维护任务清单；web_search 搜互联网；web_fetch 抓 URL 正文。" +
  "用户的 workspace 已经设置好，相对路径都相对于它。" +
  "" +
  "调用规则：" +
  "- 如果用户问问题不需要调工具就直接回答；需要看代码或跑命令时主动用工具。" +
  "- 对于包含 3 个或更多独立步骤的任务，先调 TodoWrite 列出清单，每完成一项再调 TodoWrite 把它标记为 completed、" +
  "把下一项标为 in_progress；简单的 1-2 步任务不需要列清单。" +
  "" +
  "实时信息：" +
  "- 天气类问题用 bash 调 wttr.in，例如 `curl -s 'wttr.in/Beijing?format=3'`，比 web_search 更快更准。" +
  "- 其他实时信息（新闻、最新版本、人物近况、价格等）用 web_search 找候选 URL，必要时用 web_fetch 读详情。" +
  "- 不要凭记忆回答时效性强的问题（你训练数据有截止日期）。" +
  "" +
  "回答用中文，言简意赅。";

const program = new Command();
program
  .name("mini-agent")
  .description("最小 AI agent 框架（学习项目）")
  .version("0.0.1");

program
  .command("chat")
  .description("启动交互式对话")
  .option("-w, --workspace <path>", "工作目录（默认当前目录）")
  .option("-m, --model <name>", "模型名（也可通过 ANTHROPIC_MODEL 环境变量设置）", process.env.ANTHROPIC_MODEL || DEFAULT_MODEL)
  .option("--max-steps <n>", "单轮最多步数", (v) => parseInt(v, 10), 10)
  .option("--no-stream", "禁用流式输出（默认开启流式）")
  .option("-s, --session <id>", "会话 id（决定持久化文件名）", "default")
  .option("--session-dir <path>", "会话历史目录", process.env.SESSION_DIR ?? "./sessions")
  .option("--no-persist", "不持久化会话历史")
  .option("--mcp-config <path>", "MCP servers 配置文件（JSON）")
  .option(
    "--compact-threshold <n>",
    "上下文 token 阈值，超过自动压缩历史",
    (v) => parseInt(v, 10),
    parseInt(process.env.COMPACT_THRESHOLD_TOKENS ?? "32000", 10),
  )
  .action(async (opts: {
    workspace?: string;
    model: string;
    maxSteps: number;
    stream: boolean;
    session: string;
    sessionDir: string;
    persist: boolean;
    mcpConfig?: string;
    compactThreshold: number;
  }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      stdout.write(
        "缺少 ANTHROPIC_API_KEY，请把它写到 .env 或导出到环境变量。\n",
      );
      process.exit(1);
    }

    // workspace 优先级：--workspace > 用户启动 CLI 时的 cwd（INIT_CWD）> 当前 process.cwd()
    // 用 INIT_CWD 是因为 pnpm dev 会把 cwd 切到包根，导致从其它目录启动失效
    const workspace = resolve(
      opts.workspace ?? process.env.INIT_CWD ?? process.cwd(),
    );
    stdout.write(`workspace: ${workspace}\nmodel: ${opts.model}\n\n`);

    // 1. 准备 registry
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    registry.register(writeFileTool);
    registry.register(bashTool);
    registry.register(todoWriteTool);
    registry.register(webSearchTool);
    registry.register(webFetchTool);

    // 1b. 可选：连接 MCP servers
    const mcpConns: McpConnection[] = [];
    if (opts.mcpConfig) {
      const cfgPath = resolve(opts.mcpConfig);
      try {
        const raw = await (await import("node:fs/promises")).readFile(cfgPath, "utf8");
        const cfg = JSON.parse(raw) as { mcpServers: Record<string, Omit<McpServerConfig, "name">> };
        for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
          stdout.write(`[mcp] connecting ${name}: ${server.command} ${(server.args ?? []).join(" ")}\n`);
          const conn = await connectMcpServer({ name, ...server }, registry);
          mcpConns.push(conn);
          stdout.write(`[mcp] ${name}: ${conn.registeredTools.length} tool(s) → ${conn.registeredTools.join(", ")}\n`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        stdout.write(`[mcp] 加载失败：${msg}\n`);
      }
    }

    // 2. 准备 provider
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    const provider = new AnthropicProvider({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
    if (baseURL) stdout.write(`baseURL: ${baseURL}\n`);

    // 3. 准备会话历史（system + 多轮）
    //    --no-persist 时直接用内存数组；否则从 SessionStore 加载
    const initialMessages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];
    let messages: Message[];
    let store: SessionStore | null = null;
    if (opts.persist) {
      const dir = resolve(opts.sessionDir);
      store = await SessionStore.load({
        dir,
        sessionId: opts.session,
        initialMessages,
      });
      messages = store.messages;
      stdout.write(`session: ${opts.session} (${dir}/${opts.session}.json, ${messages.length - 1} 条历史)\n`);
    } else {
      messages = initialMessages;
    }
    stdout.write("\n");

    // 4. 消息总线 + agent loop（步骤 2.2）
    const bus = new MessageBus();

    // 5. CLI channel：负责输入 + 输出 + 进度展示
    const channel = new CliChannel({
      bus,
      streaming: opts.stream,
      onClear: async () => {
        // 保留 system，砍掉用户/助手历史
        if (store) {
          await store.clear(initialMessages);
        } else {
          messages.length = 1;
        }
      },
    });

    // 6. 后台启动 agent loop：从 bus.inbound 取消息，跑 turn，把结果 push 到 bus.outbound
    const loopDone = runAgentLoop({
      bus,
      handleTurn: async (msg) => {
        messages.push({ role: "user", content: msg.text });
        const result = await runTurn({
          provider,
          registry,
          messages,
          ctx: { workspace },
          model: opts.model,
          maxSteps: opts.maxSteps,
          stream: opts.stream,
          onProgress: (e) => channel.renderProgress?.(e),
        });

        // 一轮结束后：
        //   1. 检查是否需要压缩历史
        //   2. 节流保存到硬盘
        const compacted = await maybeCompact(messages, {
          provider,
          model: opts.model,
          thresholdTokens: opts.compactThreshold,
        });
        if (compacted.compacted) {
          stdout.write(
            `\x1b[2m[compact] ${compacted.before} → ${compacted.after} tokens\x1b[0m\n`,
          );
        }
        store?.scheduleSave();
        return { text: result.final.content, result };
      },
    });

    // 7. CLI channel 启动：阻塞读 stdin，把消息 push 进 bus，等 outbound 回复
    await channel.start(async () => {
      // bus 模式下不会走到这条路径
    });

    // 等 agent loop 收到 bus 关闭后退出
    await loopDone;

    // 退出前 flush 一次会话
    if (store) await store.saveNow();

    // 关闭 MCP 连接
    for (const conn of mcpConns) {
      await closeMcpConnection(conn, registry);
    }

    stdout.write("\n再见。\n");
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
