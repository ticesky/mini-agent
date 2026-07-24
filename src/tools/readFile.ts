/**
 * read_file 工具：读取文本文件内容。
 *
 * 对应 nanobot/agent/tools/filesystem.py 中的 ReadFileTool（精简版）。
 *
 * 简化点：
 *   - 不做 line range（offset/limit）切片：MVP 第一版交给 LLM 自己用 head/tail
 *   - 不做"文件被改过就拒绝读"的 stale 检测（nanobot 有 file_state.py 跟踪）
 *   - 不做二进制/图像识别
 *   - 安全：把 path 限制在 ctx.workspace 之下，防止 LLM 越界读 ~/.ssh 之类
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { defineTool } from "./base.ts";

/** 单次读取的最大字节数。超过就截断并提示。 */
const MAX_BYTES = 200_000;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "读取文本文件的内容。path 可以是相对路径（相对 workspace）或绝对路径。" +
    "超过 200KB 会被截断。",
  readOnly: true,
  schema: z.object({
    path: z
      .string()
      .min(1)
      .describe("要读取的文件路径，相对 workspace 或绝对路径。"),
  }),
  execute: async ({ path }, ctx) => {
    const abs = isAbsolute(path) ? resolve(path) : resolve(ctx.workspace, path);

    // 安全检查：禁止跳出 workspace
    const rel = relative(ctx.workspace, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return `Error: path '${path}' is outside the workspace '${ctx.workspace}'.`;
    }

    try {
      const buf = await fsReadFile(abs);
      if (buf.byteLength > MAX_BYTES) {
        const head = buf.subarray(0, MAX_BYTES).toString("utf8");
        return `${head}\n\n[文件被截断：原始大小 ${buf.byteLength} 字节，仅显示前 ${MAX_BYTES}。]`;
      }
      return buf.toString("utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error reading '${path}': ${msg}`;
    }
  },
});
