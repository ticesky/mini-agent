/**
 * Tool 抽象与 `defineTool` 工厂。
 *
 * 对应 nanobot/agent/tools/base.py：
 *   - Tool ABC（name / description / parameters / execute）
 *   - JSON Schema 校验（validate_json_schema_value）
 *   - 参数类型转换（_cast_value：把 LLM 偶尔传来的 "true"/"123" 等字符串纠正回来）
 *
 * 我们做了两处改进：
 *   1. 用 zod 表达 schema，再 zod-to-json-schema 转出去给 LLM 看。
 *      —— nanobot 用 pydantic 是因为 Python 没得选，我们用 zod 体验更好。
 *   2. 用 `defineTool({...})` 工厂代替继承 class。
 *      —— 工具基本是"一段配置 + 一个 execute 函数"，不需要 OO 继承。
 */
import type { z, ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * 工具运行时拿到的上下文。
 *
 * 对应 nanobot 的 ToolContext（agent/tools/context.py），但我们极度精简：
 * 第一版只放 workspace（当前工作目录），后续要加再说。
 */
export interface ToolContext {
  /** 工具默认的工作目录，文件读写都相对于它。 */
  workspace: string;
}

/**
 * 工具的"配置 + 行为"。Tool<S> 由 `defineTool()` 工厂构造，
 * 调用方一般只看到 `Tool`（不带泛型），保留 S 是为了在 execute 内部享受类型推断。
 */
export interface Tool<S extends ZodTypeAny = ZodTypeAny> {
  /** 工具名。LLM 看到的就是这个名字，必须与 registry 注册的 key 一致。 */
  readonly name: string;

  /** 给 LLM 看的描述：什么场景下用、注意事项。直接影响调用质量。 */
  readonly description: string;

  /**
   * zod schema，用来：
   *   1. 转出 JSON Schema 给 LLM
   *   2. 校验 + 强制类型转换 LLM 实际传来的参数
   */
  readonly schema: S;

  /**
   * 是否只读、可与其他只读工具并发执行。
   * 对应 nanobot 的 `read_only` / `concurrency_safe`。
   * 写工具默认 false（串行执行）。
   */
  readonly readOnly: boolean;

  /**
   * 真正干活的函数。
   * 入参 `input` 已经被 zod 解析 + 校验过，类型即 schema 推断出的类型。
   * 返回字符串或 Promise<string>，约定就是"塞回给 LLM 的工具消息内容"。
   */
  execute(
    input: z.infer<S>,
    ctx: ToolContext,
  ): Promise<string> | string;
}

/** 工厂函数：用法见下方 readFile/bash 工具。 */
export function defineTool<S extends ZodTypeAny>(
  spec: Tool<S>,
): Tool<S> {
  return spec;
}

/**
 * 把工具序列化成 LLM function-calling 需要的 schema。
 * 这里用的是 OpenAI 风格 `{type:"function", function:{name, description, parameters}}`；
 * Anthropic 在 provider 层会再适配一次。
 *
 * 对应 nanobot/agent/tools/base.py 的 `Tool.to_schema()`。
 */
export function toolToOpenAISchema(tool: Tool): {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
} {
  // strictUnions/$refStrategy 不开特殊配置：默认输出最常见的 JSON Schema 形式
  const parameters = zodToJsonSchema(tool.schema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as Record<string, unknown>;

  // zod-to-json-schema 在顶层会带 "$schema" 字段，OpenAI/Anthropic 不需要
  delete parameters["$schema"];

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters,
    },
  };
}
