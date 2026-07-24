# 02 — `agent/tools/base.py`：cast 与 validate 双递归

> nanobot 的工具基类 296 行 vs mini-agent 100 行。
> 主要原因：nanobot 用 JSON Schema dict（纯描述），mini-agent 用 zod（自带运行时方法）。

## 一句话理解 cast 和 validate 的关系

```
cast_params (递归"修参数")  →  validate_value (递归"挑错")
       先尝试纠正                   再报告剩下的错
```

它们是 `prepare_call` 里**先后执行的两步**：

```python
cast_params = tool.cast_params(params)      # 1. 先 cast：能纠正的纠正
errors = tool.validate_params(cast_params)  # 2. 再 validate：纠正完了还有错就报
```

两步都在 schema 树上递归，所以**形状相似**，但职责完全不同：

|  | cast_value | validate_value |
|---|---|---|
| 输入 | 一个值 + schema 片段 | 一个值 + schema 片段 |
| 行为 | **修改并返回新值** | **不改值，返回错误列表** |
| 失败时 | 原样返回（让 validate 报） | append 错误进 errors 列表 |
| 例子 | `"123"` → `123` | `123 ≥ minimum?` 不满足报错 |

## mini-agent 一行就搞定，为什么 nanobot 要写两遍递归

```ts
// mini-agent
const result = tool.schema.safeParse(coerced);  // cast + validate 一次完成
```

nanobot 必须分开做，**因为它用的是 JSON Schema dict，不是 zod**：

- zod 是 schema 对象，自带 `.parse()` 方法既校验又转换
- JSON Schema 是"标准格式 dict"，**纯描述**，不带运行时行为
- 想要 cast 和 validate 都得**自己写一遍遍历**

→ 这正好印证 "核心精简，边缘补"：
- JSON Schema 是核心（能喂给 LLM、能跨语言、跨工具复用）
- cast 是边缘（专门解决"LLM 乱传参"这一个问题）

## 递归怎么工作（用 Python 注释一下）

### `_cast_object` 处理对象

```python
def _cast_object(self, obj, schema):
    if not isinstance(obj, dict):
        return obj  # 不是 dict 就原样返回（让 validate 去报错）

    props = schema.get("properties", {})  # 拿到 schema 里描述的子字段

    # dict comprehension：等价于 TS 的 Object.fromEntries(...)
    return {
        k: self._cast_value(v, props[k]) if k in props else v
        # ↑ key  ↑ 递归 cast 子值                  ↑ schema 没描述的字段原样返回
        for k, v in obj.items()
    }
```

对照 TypeScript 写法：

```ts
function castObject(obj: Record<string, unknown>, schema: any) {
  if (typeof obj !== "object" || obj === null) return obj;
  const props = schema.properties ?? {};
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      k in props ? castValue(v, props[k]) : v,  // ← 递归
    ]),
  );
}
```

### `validate_json_schema_value` 处理对象

```python
if t == "object":
    props = schema.get("properties", {})
    for k in schema.get("required", []):
        if k not in val:
            errors.append(f"missing required {Schema.subpath(path, k)}")
    for k, v in val.items():
        if k in props:
            errors.extend(
                Schema.validate_json_schema_value(v, props[k], Schema.subpath(path, k))
                # ↑ 递归调用自己，把子字段的错也收集进来
            )
```

`Schema.subpath(path, k)` 把"错误路径"维护成树状的：

```
parameter         ← 顶层
config.api_key    ← config 是子对象，api_key 是它的子字段
items[3].name     ← items 是数组，[3] 是第 4 个元素，name 是它的子字段
```

→ 报错才能精确告诉 LLM"你哪个字段写错了"。

## 数组的递归

```python
if t == "array":
    if "items" in schema:
        prefix = f"{path}[{{}}]" if path else "[{}]"
        for i, item in enumerate(val):
            errors.extend(
                Schema.validate_json_schema_value(item, schema["items"], prefix.format(i))
                #                                  ↑ 数组每个元素同一个 schema    ↑ 路径成 path[3]
            )
```

JSON Schema 里数组的 items schema **是一个**（不像 tuple 每个位置不同），所以对每个元素递归用同一个 schema。

## "被 LLM 实际坑过"的代码片段

```python
if t == "boolean" and isinstance(val, str):
    low = val.lower()
    if low in self._BOOL_TRUE:    # frozenset(("true", "1", "yes"))
        return True
    if low in self._BOOL_FALSE:   # frozenset(("false", "0", "no"))
        return False
    return val
```

**LLM 会传字符串 `"true"` 而不是 boolean `True`**——让 LLM 调一个 `read_file(path: string, recursive: boolean)`，模型一不留神就会写 `{"path": "...", "recursive": "true"}`。

不同模型、不同 prompt 风格命中率不一样。这段代码就是为了**不让一个低级错误让整轮工具调用失败**。

## 一个值得带走的设计观察

nanobot **把 cast 和 validate 都做成"返回值"而不是"抛异常"**：
- `cast_value` 返回新值
- `validate_value` 返回错误数组

跟 mini-agent 用 zod 的 `.safeParse()` 同一个哲学——**用值传递错误，而不是 throw**。

为什么这种风格在 agent 里特别合适？

- 一次可能有多个错误（required 缺 3 个字段），需要**全部收集**给 LLM
- LLM 看到完整错误列表才能一次性改对
- 如果 throw，遇到第一个错就停了

mini-agent 的 zod `result.error.issues` 也是数组，**同一个设计直觉，不同的实现方式**。

## Python 几个陌生语法（顺手记一下）

```python
# 1. 三元表达式：value_if_true if condition else value_if_false
return v if k in props else default

# 2. dict.get(key, default)：等价于 obj[key] ?? default
schema.get("properties", {})

# 3. list/dict comprehension（推导式）
[x*2 for x in nums]                  # 等价于 nums.map(x => x*2)
{k: v for k, v in pairs}             # 等价于 Object.fromEntries(pairs)

# 4. f-string（模板字符串）
f"missing {key}"                     # 等价于 `missing ${key}`

# 5. isinstance(x, T)：等价于 x instanceof T，但对原始类型也工作
isinstance(val, (int, float))         # 等价于 typeof val === "number"

# 6. *args / **kwargs：可变参数
def execute(self, **kwargs): ...      # 等价于 (kwargs: Record<string, unknown>) => ...

# 7. frozenset：不可变集合，O(1) 查找
_BOOL_TRUE = frozenset(("true", "1", "yes"))
"true" in _BOOL_TRUE                  # 等价于 set.has("true")
```
