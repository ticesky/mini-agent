/**
 * 工具注册表。
 *
 * 对应 nanobot/agent/tools/registry.py：
 *   - register / unregister / get / has
 *   - prepareCall：解析、cast、校验 → 返回 (tool, params, error)
 *   - execute：跑工具，把异常翻成字符串塞回给 LLM
 *   - getDefinitions：把所有工具 schema 收齐喂给 LLM（带稳定排序，利于 prompt cache）
 *
 * 简化点：
 *   - 不做 mcp_/builtin_ 的分桶排序（MVP 第一版只有 builtin，第二天加 MCP 时再调）
 *   - 不做"名字相近自动建议"（你打错就报错，靠 LLM 自我纠正）
 *   - 参数 cast 完全交给 zod 的 .safeParse()——它已经做了大部分工作
 */
import type { Tool, ToolContext } from "./base.ts";
import { toolToOpenAISchema } from "./base.ts";

/** prepareCall 的返回结构：要么成功（ok=true），要么报错（ok=false）。 */
export type PreparedCall =
  | { ok: true; tool: Tool; params: Record<string, unknown> }
  | { ok: false; tool?: Tool; error: string };

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  /** 缓存 getDefinitions() 结果，注册/注销时置空。 */
  private definitionsCache: ReturnType<typeof toolToOpenAISchema>[] | null =
    null;

  /** 注册一个工具。同名会覆盖（方便热替换）。 */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.definitionsCache = null;
  }

  /** 注销一个工具（不存在时静默忽略）。 */
  unregister(name: string): void {
    this.tools.delete(name);
    this.definitionsCache = null;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 已注册工具名列表（顺序未保证）。 */
  get toolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 全部工具实例的列表（runner 调 provider 时要把这个传过去）。 */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 把所有工具的 schema 收齐，按名字排序后返回。
   * 稳定排序对 prompt cache 命中很关键 —— 同一组工具应永远以同样顺序出现。
   * 对应 nanobot/agent/tools/registry.py 的 `get_definitions()`。
   */
  getDefinitions(): ReturnType<typeof toolToOpenAISchema>[] {
    if (this.definitionsCache !== null) return this.definitionsCache;

    const schemas = Array.from(this.tools.values())
      .map(toolToOpenAISchema)
      .sort((a, b) => a.function.name.localeCompare(b.function.name));

    this.definitionsCache = schemas;
    return schemas;
  }

  /**
   * 准备一次工具调用：找工具、parse 参数、校验。
   *
   * 注意：LLM 偶尔会把整个 arguments 包成 JSON 字符串发过来，这里先尝试反序列化。
   * 对应 nanobot 的 `_coerce_argument_value`。
   */
  prepareCall(
    name: string,
    rawArgs: unknown,
  ): PreparedCall {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        error:
          `Tool '${name}' not found. Available: ${this.toolNames.join(", ")}`,
      };
    }

    // 1. 把"是 JSON 字符串的 args"反序列化成对象
    const coerced = coerceArgs(rawArgs);
    if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) {
      return {
        ok: false,
        tool,
        error:
          `Tool '${name}' expects an object of named parameters, got ${typeof coerced}.`,
      };
    }

    // 2. 用 zod 做校验 + 强制类型转换
    const result = tool.schema.safeParse(coerced);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, tool, error: `Invalid parameters for '${name}': ${issues}` };
    }

    return { ok: true, tool, params: result.data as Record<string, unknown> };
  }

  /**
   * 执行一个工具。任何异常都被捕获并翻译成字符串结果，
   * 这样 LLM 能"看到"自己的错误并自我纠正——这是 agent 自纠错的关键设计。
   *
   * 对应 nanobot/agent/tools/registry.py `execute()`。
   */
  async execute(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<string> {
    const HINT = "\n\n[请分析上面的错误并尝试不同的方法。]";
    const prepared = this.prepareCall(name, rawArgs);
    if (!prepared.ok) return prepared.error + HINT;

    try {
      const out = await prepared.tool.execute(prepared.params, ctx);
      // 工具自己返回的字符串以 "Error" 开头时，加上提示让 LLM 重试
      if (typeof out === "string" && out.startsWith("Error")) {
        return out + HINT;
      }
      return out;
    } catch (e) {
      const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return `Error executing ${name}: ${err}` + HINT;
    }
  }
}

/**
 * 把"可能是 JSON 字符串"的参数尽量解析回对象/数组/原始值。
 * 这是 LLM 偶发"把整个 arguments 当字符串发"的兜底。
 */
function coerceArgs(value: unknown): unknown {
  if (value === null || value === undefined) return {};
  if (typeof value !== "string") return value;

  const stripped = value.trim();
  if (stripped === "") return {};
  if (!stripped.startsWith("{") && !stripped.startsWith("[")) return value;

  try {
    return JSON.parse(stripped);
  } catch {
    return value;
  }
}
