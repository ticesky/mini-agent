# 步骤 1.2 — Tool 抽象 + ToolRegistry

> 对应 plan.md 的 Day 1 第 2 步。这是整个项目最值得对照学习的两个文件之一。

## 目标

把"工具"这个概念建模出来，并提供一个注册/查找/执行的中心。完成这一步后，下一步就能写真正的 `read_file` / `bash` 工具，并被 LLM 调用。

## 交付清单

```
src/tools/
├── base.ts        ≈ 100 行 — Tool 接口、defineTool 工厂、toolToOpenAISchema
└── registry.ts    ≈ 150 行 — ToolRegistry：注册/查找/prepareCall/execute
```

## 关键设计

### 1. Tool 用工厂而不是继承

nanobot 那边是经典 OO：

```python
class ReadFileTool(Tool):
    @property
    def name(self): return "read_file"
    @property
    def description(self): return "..."
    ...
    async def execute(self, **kwargs): ...
```

我们用 `defineTool({...})`：

```ts
const readFile = defineTool({
  name: "read_file",
  description: "...",
  schema: z.object({ path: z.string() }),
  readOnly: true,
  execute: async ({ path }, ctx) => fs.readFile(path, "utf8"),
});
```

**为什么这样更好**：
- 工具就是"配置 + 一个函数"，没有需要复用的方法，OO 继承在这里只是仪式
- TS 的对象字面量 + 泛型推断让 `execute` 的入参 `input` 直接拿到 `z.infer<S>` 的类型，无需手写
- nanobot 用 `@tool_parameters({...})` 装饰器走了同样的路（只是因为 Python class 必须存在），它本质也是把 schema 注入 class 属性

### 2. 用 zod 替代手写 JSON Schema 校验

nanobot/agent/tools/base.py 里 `validate_json_schema_value` 写了 60 行处理 type/enum/min/max/required —— 因为 pydantic 不会无中生有跑校验，工具参数那一层是手写的。

我们直接：
- schema 用 zod 写
- 校验/cast 调用 `.safeParse(input)` 一行解决
- 输出 JSON Schema 用 `zod-to-json-schema(target: "openApi3")`

> **mini-agent 第二处比 nanobot 简洁的地方** —— 不是因为 zod 强（pydantic 也很强），是因为 nanobot 的工具系统比 pydantic 更早、为了给 LLM 更友好的报错单独写了一层。我们站在巨人肩膀上。

### 3. PreparedCall 用 discriminated union

注意这里：

```ts
export type PreparedCall =
  | { ok: true; tool: Tool; params: Record<string, unknown> }
  | { ok: false; tool?: Tool; error: string };
```

这是 TS 里的黄金搭配。代码里写 `if (!prepared.ok) return ...`，编译器立刻知道下面分支里 `prepared.tool` 是确定存在的。
nanobot 用 3-tuple `(tool, params, error)`，调用方还得手动判 `error is None` —— 类型上没保障。

### 4. 错误回填给 LLM 是 agent 自纠错的关键

整个 `execute()` 里所有异常路径都不抛出，全部翻成字符串 + `[请分析上面的错误并尝试不同的方法。]` 提示语。

这是 agent 框架最重要的"模式级设计"之一：**让 LLM 看见自己的错误**，下一轮它会自动改参数/换工具。
对应 nanobot：`agent/tools/registry.py:159` 的 `hint = "\n\n[Analyze the error above and try a different approach.]"`。

### 5. 稳定排序帮助 prompt cache

`getDefinitions()` 永远按工具名字典序排，并把结果缓存到 `definitionsCache`，注册/注销时清空。

为什么？**Anthropic / OpenAI 都按"前缀完全一致"才给 prompt cache 命中**。如果工具列表顺序不稳，每次发请求 system 段都不一样，cache 永远 miss。
对应 nanobot：`agent/tools/registry.py:67-90` 的 `get_definitions()`，它甚至把 builtin 和 mcp_ 工具分桶各自排序——MVP 第一版用不到，第二天加 MCP 时再考虑。

## 跟 nanobot 的差异表

| 议题 | nanobot 做法 | mini-agent 做法 | 为什么 |
|---|---|---|---|
| Tool 定义 | 继承 Tool ABC | `defineTool({...})` 工厂 | TS 类型推断更顺 |
| 参数 schema | 手写 dict + 装饰器 | zod schema | zod-to-json-schema 一步出 JSON Schema |
| 参数 cast | `_cast_value` 手写一堆类型转换 | zod 内置 | zod 已经覆盖 |
| 校验失败返回 | 3-tuple `(tool, params, error)` | discriminated union | 类型安全 |
| 错误回填 | "Analyze the error above..." | "请分析上面的错误..." | 翻成中文 |
| 排序 | builtin 在前、mcp 在后，各自字典序 | 统一字典序 | 第二天加 MCP 再分桶 |
| 名字相近建议 | `_suggest_name` | 不做 | LLM 看到 Available 列表能自纠 |

## 对照 nanobot 看什么

最值得读的两段代码（直接对照我们的实现来看）：

1. **`nanobot/agent/tools/base.py:124-262`** —— `Tool` ABC 完整定义
   - `_cast_value`（200 行附近）—— 看它处理了多少 LLM 实际乱传的参数：`"true"` 当 boolean、`"123"` 当数字、把 array 包成字符串。这是被生产 bug 喂出来的代码
   - 我们靠 zod 的 `z.coerce.boolean()` / `z.coerce.number()` 一步搞定（如果需要）

2. **`nanobot/agent/tools/registry.py` 整个文件**（180 行）
   - `_coerce_argument_value` —— 我们对应的就是 `coerceArgs`，几乎等价
   - `prepare_call` 的三步：找工具 → cast → validate —— 跟我们一样
   - `_suggest_name` —— 这是工程老化产物，新项目可以不写

## 验证

`pnpm typecheck` 通过。

我跑了一个 5 场景的 smoke test（验证完已经删除了，留个备忘）：

- ✅ `getDefinitions()` 输出正确的 OpenAI function schema
- ✅ happy path：参数对、工具正常返回
- ✅ JSON-string args：LLM 把 `arguments` 整体当字符串发，能被还原
- ✅ unknown tool：返回带 Available 列表的错误 + 提示语
- ✅ invalid params：zod 报错被翻译成 "Invalid parameters for 'echo': text: ..." + 提示语
- ✅ throwing tool：执行抛异常被翻译成 "Error executing boom: Error: kaboom" + 提示语

## 下一步

**步骤 1.3 — 三个工具**（≈ 120 行）：
- `src/tools/readFile.ts`
- `src/tools/writeFile.ts`
- `src/tools/bash.ts`

写完这三个，registry 就有真东西可注册了。
