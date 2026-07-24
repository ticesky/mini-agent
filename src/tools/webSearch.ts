/**
 * web_search 工具：通过 Bing 中文站做联网搜索。
 *
 * 对应 nanobot/agent/tools/web.py 的 WebSearchTool（极简版）。
 *
 * 简化点：
 *   - 只支持 Bing（国内可访问，无需 API key）
 *   - 直接 scrape Bing 搜索结果页 HTML
 *   - 不做缓存、不做去重、不做安全评分
 *   - Bing 可能改 HTML 结构，失败时返回错误字符串让 LLM 自行处理
 *
 * 注意：Bing HTML 接口非官方，仅用于学习。生产建议接 Bing Web Search API
 * 或 Tavily / Brave Search 等带 API key 的搜索 provider。
 */
import { z } from "zod";
import { defineTool } from "./base.ts";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const webSearchTool = defineTool({
  name: "web_search",
  description:
    "通过 Bing 搜索互联网，返回标题 / URL / 摘要。" +
    "用于查询实时信息（新闻、最新版本、人物近况等）。" +
    "如果某条结果看起来相关但摘要不够，再用 web_fetch 抓取详情。" +
    "默认返回 5 条，最多 10 条。",
  readOnly: true,
  schema: z.object({
    query: z.string().min(1).describe("搜索查询语句（中英文都可以）"),
    count: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("返回结果数量，默认 5"),
  }),
  execute: async ({ query, count = 5 }) => {
    try {
      // 用 cn.bing 国内可直连；非国内会自动跳转 www.bing.com
      const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        return `Error: 搜索失败，HTTP ${res.status}`;
      }
      const html = await res.text();
      const results = parseBingHtml(html, count);
      if (results.length === 0) {
        return `Error: 没有解析到 Bing 结果（HTML 结构可能变了，或请求被限频）。原查询："${query}"`;
      }
      return formatResults(query, results);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error searching '${query}': ${msg}`;
    }
  },
});

/**
 * 从 Bing HTML 页面解析结果。
 *
 * Bing 结构（cn.bing.com 截至 2026）：
 *   <li class="b_algo">
 *     ...
 *     <h2><a href="URL" ...>TITLE</a></h2>
 *     ...
 *     <p>SNIPPET</p>
 *     ...
 *   </li>
 */
function parseBingHtml(html: string, count: number): SearchResult[] {
  // 匹配每一个 result item，s 标志多行模式
  const itemRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  const titleRegex = /<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRegex = /<p[^>]*>([\s\S]*?)<\/p>/;

  const results: SearchResult[] = [];
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(html)) && results.length < count) {
    const block = m[1]!;
    const title = titleRegex.exec(block);
    const snippet = snippetRegex.exec(block);
    if (!title) continue;
    results.push({
      url: title[1]!,
      title: stripHtml(title[2]!),
      snippet: snippet ? stripHtml(snippet[1]!).slice(0, 300) : "",
    });
  }
  return results;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#0*1[83]3;/g, "—") // &#0183; / &#183; → ·
    .replace(/\s+/g, " ")
    .trim();
}

function formatResults(query: string, results: SearchResult[]): string {
  const lines: string[] = [`搜索 "${query}" 找到 ${results.length} 条结果：`, ""];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push("");
  }
  return lines.join("\n");
}
