/**
 * write_file 工具：写入文本文件（覆盖式）。
 *
 * 对应 nanobot/agent/tools/filesystem.py 中的 WriteFileTool（精简版）。
 *
 * 简化点：
 *   - 没有 file_state 跟踪（nanobot 写之前要求"必须先 read 过"以防 stale 覆盖）
 *   - 不做 atomic write（temp + rename）—— 留到 session/memory.ts 做完整版
 *   - 不做 diff 风格的 edit（apply_patch 在 stretch 列表里）
 *   - 安全：把 path 限制在 ctx.workspace 之下
 */
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "./base.ts";

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "写入文本文件（覆盖现有内容）。会自动创建缺失的父目录。" +
    "path 可以是相对路径（相对 workspace）或绝对路径。",
  readOnly: false, // 写工具不能并发
  schema: z.object({
    path: z.string().min(1).describe("目标文件路径。"),
    content: z.string().describe("要写入的完整文件内容（UTF-8）。"),
  }),
  execute: async ({ path, content }, ctx) => {
    const abs = isAbsolute(path) ? resolve(path) : resolve(ctx.workspace, path);

    const rel = relative(ctx.workspace, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return `Error: path '${path}' is outside the workspace '${ctx.workspace}'.`;
    }

    try {
      await mkdir(dirname(abs), { recursive: true });
      await fsWriteFile(abs, content, "utf8");
      return `Wrote ${content.length} characters to ${path}.`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error writing '${path}': ${msg}`;
    }
  },
});
