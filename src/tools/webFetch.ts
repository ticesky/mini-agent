/**
 * web_fetch 工具：抓取指定 URL 的网页正文。
 *
 * 对应 nanobot/agent/tools/web.py 的 WebFetchTool（极简版）。
 *
 * 简化点：
 *   - 不做 readability 提取主内容（直接 strip 标签）
 *   - 不做 SSRF 防护（生产场景必须加）
 *   - 不做代理 / 自定义 headers / cookie
 *   - 不做图片提取
 */
import { z } from "zod";
import { defineTool } from "./base.ts";

// 用 Chrome 的 UA：很多站会拦默认 fetch UA
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_BYTES = 200_000;
const TIMEOUT_MS = 15_000;

export const webFetchTool = defineTool({
  name: "web_fetch",
  description:
    "抓取指定 URL 的网页正文，返回纯文本（已去除 HTML 标签）。" +
    "通常先用 web_search 找到候选 URL，再用本工具读详情。" +
    "超时 15 秒，最多返回 200KB（超长截断）。",
  readOnly: true,
  schema: z.object({
    url: z
      .string()
      .url()
      .describe("完整的 http(s) URL"),
  }),
  execute: async ({ url }) => {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/json,*/*",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        return `Error: HTTP ${res.status} ${res.statusText}`;
      }
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      const text = await res.text();

      // 非 HTML（JSON / 纯文本）直接返回
      if (!ct.includes("html")) {
        return truncate(text, MAX_BYTES);
      }

      // 简陋正文提取：去 script/style/注释 + 标签
      const stripped = stripHtml(text);
      return truncate(stripped, MAX_BYTES);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error fetching '${url}': ${msg}`;
    }
  },
});

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n\n[内容被截断：原始 ${s.length} 字符，仅显示前 ${n}。]`;
}
