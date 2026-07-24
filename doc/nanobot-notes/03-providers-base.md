# 03 — `providers/base.py`：错误归一三层判定 + 重试

> nanobot 把"调 LLM"做扎实的代表作（964 行）。也是 mini-agent 现在最薄弱的部分。

## 一句话总结整个文件

> **把"一次 LLM 调用可能出的所有问题，归一成一种统一形态。"**

## 文件三层结构

```
Layer 1：数据形态归一
  ToolCallRequest / LLMResponse 等 dataclass
  → 让上层 runner 不管 SDK 差异

Layer 2：错误归一  ★ 核心
  _is_transient_response / is_arrearage_response
  → 把异常翻译成"要不要重试"

Layer 3：重试封装  ★ mini-agent 没有
  chat_with_retry / chat_stream_with_retry
  → 在 Layer 2 的判定下自动重试，配合指数退避
```

## Layer 1：数据形态归一

跟 mini-agent `types.ts` 一一对应，但 LLMResponse **多 4 个错误字段**：

```python
@dataclass
class LLMResponse:
    content: str | None
    tool_calls: list[ToolCallRequest]
    finish_reason: str | None
    usage: Usage | None
    # ── 错误相关字段 ──
    error_kind: str | None         # "rate_limit" / "billing" / "fatal" / ...
    error_message: str | None
    error_status_code: int | None
    error_should_retry: bool | None
```

mini-agent 现在只有 `error: { message, retryable }`。多出来的字段是为了 Layer 2 用。

## Layer 2：错误归一（核心）

### 关键问题：什么算"可重试"？

mini-agent 当前写法：

```ts
const retryable = (status === 429 || status >= 500) ||
  /timeout|ECONNRESET|.../.test(msg);
```

**够用，但有几个死角**：

#### 死角 1：429 不一定能重试

```
429 + "rate_limit"           → 等几秒就好（可重试）
429 + "insufficient_quota"   → 钱用完了（不可重试）
```

nanobot 在 `_is_retryable_429_response` 区分：

```python
@classmethod
def _is_retryable_429_response(cls, response):
    if cls.is_arrearage_response(response):
        return False  # 钱用完了，重试无意义
    return True
```

**现实意义**：mini-agent 现在遇到欠费会无限重试烧钱（如果加上重试的话）。

#### 死角 2：5xx 也不一定能重试

```
500 + "model overloaded"    → Anthropic 模型过载，重试有用
500 + "billing_exception"   → 计费系统崩了，重试也是 500
503 + "no available channel"→ 模型名错（不可重试）
```

nanobot 用 `_TRANSIENT_ERROR_KINDS` 集合精准匹配：

```python
_TRANSIENT_ERROR_KINDS: frozenset = frozenset({
    "rate_limit", "overloaded", "service_unavailable",
    "internal_error", "api_error", ...
})
```

#### 死角 3：欠费要识别为"永久错误"

```python
@classmethod
def is_arrearage_response(cls, response):
    """识别 API key 欠费 / 配额耗尽 / 计费错误。"""
    # 看 status==402 (Payment Required)
    # 看错误消息里 "insufficient_quota"、"payment_required"、"账户欠费"等
    ...
```

**为什么这条单独拎出来**？

重试无意义还是次要的，**关键是给用户明确信号**："不是网络问题，是钱用完了"。
否则用户会以为"网络抽风一会儿就好"，等一小时还在 429。

### 三层判定的优先级链

```python
@classmethod
def _is_transient_response(cls, response):
    if response.error_should_retry is not None:
        return bool(response.error_should_retry)  # 显式标记最高优先级

    if response.error_status_code is not None:
        status = int(response.error_status_code)
        if status == 429:
            return cls._is_retryable_429_response(response)  # 区分 quota
        if status in cls._RETRYABLE_STATUS_CODES or status >= 500:
            return True

    kind = (response.error_kind or "").strip().lower()
    if kind in cls._TRANSIENT_ERROR_KINDS:
        return True

    return cls._is_transient_error(response.content)  # 兜底用文本匹配
```

**优先级链**：

1. 显式 `error_should_retry` 字段（最准）
2. status code（HTTP 标准）
3. error kind（业务语义）
4. 文本关键词（兜底）

层层降级，前面更准就用前面的，避免误判。

### 这一层教你什么

> **错误处理不是 if/else 多，而是分层归一。**
>
> 对 runner 来说，世界只有 3 种 LLM 响应：
>   1. 成功 → 用结果
>   2. 临时错误 → 重试
>   3. 永久错误 → 立刻报告用户
>
> Layer 2 把 N 种 SDK 错误压成这 3 种状态。

## Layer 3：重试封装

```python
async def chat_with_retry(self, *, max_attempts=3, **kwargs):
    backoff = 1.0
    for attempt in range(max_attempts):
        response = await self._safe_chat(**kwargs)

        if not response.error_message:
            return response  # 成功

        if not self._is_transient_response(response):
            return response  # 永久错误：立刻返回

        if attempt < max_attempts - 1:
            await asyncio.sleep(backoff)
            backoff *= 2  # 指数退避：1s → 2s → 4s

    return response
```

5 行核心逻辑，但每行都有讲究：

| 行为 | 为什么这样 |
|---|---|
| `_safe_chat` 而不是 `chat` | 把 `chat()` 内部抛的异常翻译成 LLMResponse（捕获兜底） |
| 永久错误立刻返回 | 不浪费 API 调用 + 让用户尽快看到欠费提示 |
| 指数退避 1→2→4 | 服务器过载时，密集重试会让它更糟（thundering herd） |
| 默认 3 次 | 4 次以上收益递减（90%+ 临时错误 2 次内恢复） |

### chat_stream_with_retry 的额外难题

流式更复杂：**重试时已经流出去的内容怎么办？**

```python
async def chat_stream_with_retry(
    self,
    on_stream_recover: Callable | None = None,
    ...
):
    for attempt in range(max_attempts):
        response = await self._safe_chat_stream(...)

        if not response.error_message:
            return response

        if not self._is_transient_response(response):
            return response

        # 重试前，让 caller 知道前面流的内容作废
        if on_stream_recover:
            await on_stream_recover()  # ← caller 这里清屏 / 告诉 LLM "重新生成"
        ...
```

`on_stream_recover` 是个**让步设计**：base 不知道 caller 怎么处理已流出的内容，干脆让 caller 注册一个回调。
- CLI 可以打印 `[正在重试...]` 然后清屏
- WebUI 可以发一个 `stream_reset` 消息让前端清掉已收到的字

→ 典型 nanobot 风格：**核心做骨架，把"具体怎么处理"留给 caller。** 跟 hook 系统同一个思路。

## 几个值得记的工程小技巧

### 技巧 1：错误词表用 frozenset 而不是 list

```python
_BOOL_TRUE = frozenset(("true", "1", "yes"))
_TRANSIENT_ERROR_KINDS = frozenset({"rate_limit", "overloaded", ...})
```

`x in frozenset` 是 **O(1)**，`x in list` 是 O(n)。LLM 调用频率高，这种小优化值得。

### 技巧 2：classmethod 让子类微调常量

```python
@classmethod
def _is_transient_response(cls, response):
    ...
```

子类（AnthropicProvider / OpenAIProvider）可以**覆盖 `_TRANSIENT_ERROR_KINDS` 这个集合**，每家 provider 有自己的错误词表。
classmethod 在子类里 `cls` 自动指向子类，访问的就是子类版本的常量。

→ "OO 用得恰当"的例子：父类定义算法，子类微调常量。

### 技巧 3：用 `error_should_retry` 字段允许 SDK 直接告诉你

```python
if response.error_should_retry is not None:
    return bool(response.error_should_retry)
```

有些 SDK（比如 Anthropic 新版）在错误对象上**自带** `should_retry` 字段。这种情况下根本不用我们手猜，直接信 SDK 就行。

→ 原则：**有更可靠的信息来源时，就不用低层启发式**。先看 SDK 给的 → status code → error kind → 文本匹配。一步步降级。

## 把这一层"补回 mini-agent"的草图

将来想加 `chatWithRetry` 时，最少改动方案约 50 行：

```ts
// providers/base.ts 加：
const ARREARAGE_PATTERNS = [
  /insufficient[ _]quota/i, /payment[ _]required/i, /账户欠费/, ...
];

export function classifyError(err: unknown): {
  retryable: boolean;
  kind: "transient" | "billing" | "fatal";
  message: string;
} {
  // 三层判定
}

export async function chatWithRetry(
  provider: Provider,
  opts: ChatOptions,
  maxAttempts = 3,
): Promise<LLMResponse> {
  let backoff = 1000;
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await provider.chat(opts);
    if (!resp.error) return resp;
    const cls = classifyError(...);
    if (cls.kind !== "transient") return resp;
    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, backoff));
      backoff *= 2;
    }
  }
  return resp;
}
```

**做这个改造你会真懂这一层。** 是阶段 5 推荐的改造项之一。

## 这一层值得带走的核心心智模型

读 nanobot 代码时，**永远问"这段代码在解决哪个真实场景的什么具体问题"**。

`providers/base.py` 是反例：**任何一段代码都能找到对应的真实场景**：

| 代码 | 场景 |
|---|---|
| 区分 retryable 429 | 配额耗尽时不烧钱无限重试 |
| `is_arrearage_response` | 给用户准确"是钱用完了"提示 |
| `error_should_retry` 优先 | 信任 SDK 显式信号 |
| 指数退避 | 避免 thundering herd |
| `on_stream_recover` 回调 | 让 caller 决定怎么清理已流出的内容 |
| `_RETRYABLE_STATUS_CODES` 是 frozenset | O(1) 查表 |

**没有一段是"防御性编程"或"以防万一"**——每段都是真踩过的坑。

读 nanobot 看到陌生代码时，先别想"这到底在做什么"，先想"这是为了不再被什么坑"。
**一旦想清楚后者，前者自然就懂了。**
