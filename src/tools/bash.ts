/**
 * bash 工具：执行 shell 命令。
 *
 * 对应 nanobot/agent/tools/shell.py（极简版）。
 *
 * 简化点：
 *   - 不做沙箱（nanobot 有 sandbox.py 走 macOS sandbox-exec / Linux bwrap）
 *   - 不做持久 shell session（每次新 shell，环境变量不保留）
 *   - 不做后台任务（runInBackground 直接砍掉）
 *   - 超时硬编码 60s，不让 LLM 自己设
 *   - cwd 默认 ctx.workspace；LLM 想换可以传 cwd 参数
 *
 * 安全提醒：MVP 没有沙箱，只能在受信任本地环境跑。生产环境要补 sandbox。
 */
import { execa } from "execa";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "./base.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 100_000;

export const bashTool = defineTool({
  name: "bash",
  description:
    "执行 bash 命令（非交互式）。" +
    "stdout / stderr 会合并返回。超时 60 秒。" +
    "命令在 workspace 目录下执行，可通过 cwd 参数切换。",
  readOnly: false,
  schema: z.object({
    command: z.string().min(1).describe("要执行的 shell 命令。"),
    cwd: z
      .string()
      .optional()
      .describe("可选工作目录，相对 workspace 或绝对路径。"),
  }),
  execute: async ({ command, cwd }, ctx) => {
    const workdir = cwd
      ? isAbsolute(cwd)
        ? resolve(cwd)
        : resolve(ctx.workspace, cwd)
      : ctx.workspace;

    try {
      const result = await execa("bash", ["-c", command], {
        cwd: workdir,
        timeout: DEFAULT_TIMEOUT_MS,
        reject: false, // 非 0 退出码不抛异常，自己处理
        all: true, // 合并 stdout + stderr
        stripFinalNewline: false,
        encoding: "utf8",
      });

      const output = truncate(
        (result.all ?? `${result.stdout}\n${result.stderr}`) as string,
      );

      // 用结构化形式返回，方便 LLM 判断成功失败
      const parts = [
        output.trim() || "(无输出)",
        "",
        `[exit=${result.exitCode}${result.timedOut ? " timed-out" : ""}]`,
      ];
      return parts.join("\n");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error running command: ${msg}`;
    }
  },
});

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  return (
    s.slice(0, MAX_OUTPUT_BYTES) +
    `\n\n[输出被截断：原始 ${s.length} 字符，仅显示前 ${MAX_OUTPUT_BYTES}。]`
  );
}
