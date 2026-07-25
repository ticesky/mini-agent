# 步骤 1.6 — CLI channel + 入口（Day 1 收官）

> 对应 plan.md 的 Day 1 第 6 步。把前 5 步的零件串起来，**第一次让 agent 真正跑起来**。

## 目标

打通"用户在终端输入 → agent loop → LLM → 工具 → 输出"的完整链路。Day 1 验收。

## 交付清单

```
src/
├── channels/
│   ├── base.ts    ≈ 50 行 — Channel 接口（ChannelMessage / start / send / renderProgress）
│   └── cli.ts     ≈ 110 行 — readline + ANSI 染色 + 进度渲染
└── index.ts       ≈ 90 行 — commander 入口 + dotenv + 装配
```

## 关键设计

### 1. Channel 抽象（即使只有一个也写）

```ts
export interface Channel {
  readonly name: string;
  start(onMessage: (msg: ChannelMessage) => Promise<void>): Promise<void>;
  send(msg: ChannelMessage): Promise<void> | void;
  renderProgress?(event: ProgressEvent): void;
  onTurnEnd?(result: RunResult): void;
}
```

MVP 第一版只有 CLI 一个实现，但仍写出抽象有两个原因：
1. **步骤 2.2 加 MessageBus 时需要 channel ↔ runner 解耦**
2. **暴露给读者一个清晰的扩展点**：日后想加 Slack/Telegram 直接 `implements Channel`

跟 nanobot 不同：nanobot 把 `InboundMessage` / `OutboundMessage` 拆成两个类，因为 channel 既有"读队列"又有"写队列"两条路径。我们 MVP 没有 bus，简化成一个 `ChannelMessage`。

### 2. CliChannel：四个职责

```ts
class CliChannel implements Channel {
  start(onMessage)         // 1. 监听 stdin，收到一行就丢给 onMessage
  send(msg)                // 2. 把 agent 最终回复打印出去
  renderProgress(event)    // 3. 渲染 runner 中间事件（"正在调 read_file..."）
  onTurnEnd(result)        // 4. 一轮结束时的尾注（[steps=2 in=5791 out=17]）
}
```

#### 进度渲染策略

```ts
case "tool_start":
  stdout.write(c.cyan(`  ⚙ ${name}(${args})\n`));
case "tool_end":
  stdout.write(c.dim(`    ↳ ${preview}\n`));    // 结果首行预览
// step_start / assistant_text / step_end 不渲染
```

刻意**不**渲染 `assistant_text`，因为最终的 assistant 文本由 `send()` 在 `onMessage` 回调结束时统一打印。否则在多步 turn 里中间助手文本会出现两次。

#### 极简颜色

没引 chalk，自己写了 6 行 ANSI 转义：

```ts
const c = {
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};
```

学习项目能少装一个依赖就少装一个。

### 3. `index.ts`：装配的"生命周期"

```ts
loadEnv({ override: true });             // 1. .env > shell 环境
program.command("chat").action(async (opts) => {
  // 2. 检查 API key
  // 3. registry.register(...) 三个工具
  // 4. new AnthropicProvider({ apiKey, baseURL? })
  // 5. messages = [{ role: "system", content: SYSTEM_PROMPT }]
  // 6. new CliChannel({ onClear: () => messages.length = 1 })
  // 7. channel.start(async (msg) => {
  //      messages.push({ role: "user", content: msg.text });
  //      const result = await runTurn({ ... });
  //      if (result.final.content) channel.send({ role: "agent", text: ... });
  //      channel.onTurnEnd(result);
  //    });
});
```

这就是整个 agent 的"装配生命周期"。看完这 90 行代码 + 前面 5 步的零件，你就完整掌握一个 agent 框架的所有部件了。

### 4. `.env` 优先级 > shell 环境

```ts
loadEnv({ override: true });
```

默认 dotenv 是 **shell 优先**（已存在的环境变量不会被 .env 覆盖）。我们改成 **.env 优先**，原因是你 shell 里可能有别处设的全局 `ANTHROPIC_MODEL` 等变量，会盖掉项目级配置——开发体验很差。

项目级配置 > 全局配置，是更符合开发直觉的优先级。

### 5. 内置 system prompt

```ts
const SYSTEM_PROMPT =
  "你是一个运行在用户本地终端的小型 AI 助手。你能调用 read_file / write_file / bash 三个工具来" +
  "读写文件、跑命令。用户的 workspace 已经设置好，相对路径都相对于它。" +
  "如果用户问问题不需要调工具就直接回答；需要看代码或跑命令时主动用工具。" +
  "回答用中文，言简意赅。";
```

刻意写得短。**长 system prompt 是经验性的负担**，不是越长越好。这版的最小集合：
- 自我定位（一句话）
- 能力清单（三个工具名）
- 路径约定（相对 workspace）
- 调用策略（什么时候主动用工具）
- 回复风格（中文 + 言简意赅）

对照 nanobot 的 `templates/`，那里有大量预置 prompt，等你需要哪个再抄哪个。

## 排坑实录：网关的"显示名"陷阱

这一步把 `.env` 配成 OneAPI 网关时第一次跑起来报：

```
[steps=1 error: Error: 503 {"error":{"message":"当前分组 default 下对于模型 claude-sonnet-4-6 无可用渠道"}}]
```

第一反应是 key 错或额度问题，但这两个都被排除——`hi` 测试请求成功，只是模型名不行。

#### 调试步骤

**1. 列出网关支持的模型清单**：

```bash
curl https://oneapi-comate.baidu-int.com/v1/models \
  -H "Authorization: Bearer sk-..."
```

返回里赫然写着：

```json
{"id":"Claude Sonnet 4.6", ...}
{"id":"Claude Opus 4.7", ...}
{"id":"Claude Haiku 4.5", ...}
{"id":"gpt-5.5", ...}
```

**2. 看出问题**：网关用的是**显示名**（首字母大写、含空格），不是 Anthropic 官方 ID（`claude-sonnet-4-5-20250929` 之类）。

**3. 用正确名字测一发**：

```bash
curl -X POST https://oneapi-comate.baidu-int.com/v1/messages \
  -H "x-api-key: ..." -H "anthropic-version: 2023-06-01" \
  -d '{"model":"Claude Sonnet 4.6", "max_tokens":30, "messages":[...]}'
# → {"content":[{"text":"你好，世界！🌍"}], ...}  ✓
```

**4. 改 `.env`**：

```diff
-ANTHROPIC_MODEL=claude-sonnet-4-6
+ANTHROPIC_MODEL=Claude Sonnet 4.6
```

#### 通用排查 Tip

接任何 OpenAI/Anthropic 兼容网关时，先做两件事：
- `GET /v1/models` 列出真实支持的模型 ID
- 用 curl 直接测一个最简请求，确认 key + URL + model 三件套对得上

绕过 SDK 直接 curl 能极大缩短排错路径——SDK 错误信息常常不如 HTTP 响应原文清晰。

## Day 1 完整交付

```
mini-agent/
├── package.json
├── tsconfig.json
├── .env / .env.example
├── .gitignore
├── README.md
├── doc/
│   ├── plan.md / list.md
│   └── step-1.1 ~ step-1.6.md  ← 本步
└── src/
    ├── index.ts                                  ✅ commander 入口
    ├── types.ts                                  ✅
    ├── tools/
    │   ├── base.ts / registry.ts                 ✅ 工具抽象 + 注册表
    │   ├── readFile.ts / writeFile.ts / bash.ts  ✅ 三个工具
    ├── providers/
    │   ├── base.ts                               ✅ Provider 接口
    │   └── anthropic.ts                          ✅ Anthropic 实现（含双向翻译）
    ├── agent/
    │   └── runner.ts                             ✅ Agent loop 核心
    └── channels/
        ├── base.ts                               ✅ Channel 接口
        └── cli.ts                                ✅ 终端实现
```

总代码量：约 1100 行 TypeScript（含注释）。

## 验收

实测端到端跑通：

```
$ pnpm dev chat
workspace: /Users/caozhong/caozhong/source-code/mini-agent
model: Claude Sonnet 4.6
baseURL: https://oneapi-comate.baidu-int.com
mini-agent CLI — 输入 /exit 退出，/clear 清空历史，Ctrl-D 也可退出。

> 请读 package.json 文件，告诉我里面的 name 字段值。
  ⚙ read_file(path="package.json")
    ↳ {

`name` 字段的值是 `"mini-agent"`。

[steps=2 in=5791 out=17]
```

链路全打通：
- ✅ readline 读用户输入
- ✅ index.ts 拼 messages、调 runTurn
- ✅ runner 调 provider.chat()
- ✅ Anthropic SDK 走自定义 baseURL
- ✅ 翻译层：Message → Anthropic 格式
- ✅ LLM 决定调 read_file 工具
- ✅ runner 切批次、调 registry.execute
- ✅ readFileTool 执行、返回字符串
- ✅ runner 把 tool 结果塞回 messages
- ✅ runner 再调 LLM
- ✅ LLM 给最终回答
- ✅ channel.send 渲染输出
- ✅ channel.onTurnEnd 显示 token 用量

## Day 1 学到了什么

按 plan.md 的学习目标对照：

| 学习目标 | 状态 |
|---|---|
| Agent loop 的本质（事件循环 vs agent 循环） | ✅ 步骤 1.5 |
| LLM provider 抽象与 SDK 包装 | ✅ 步骤 1.4 |
| Tool 系统：定义/注册/校验/并发执行/错误回填 | ✅ 步骤 1.2/1.3/1.5 |
| MCP 协议接入 | ⏳ Day 2 步骤 2.4 |
| 会话记忆与历史压缩 | ⏳ Day 2 步骤 2.3/2.5 |
| channel ↔ agent 解耦的消息总线 | ⏳ Day 2 步骤 2.2 |

Day 1 完成 3 个核心目标，Day 2 还剩 3 个。

## 下一步

**Day 2 起点：步骤 2.1 — 流式响应** ≈ 150 行：

把 `provider.chat()` 改成 `provider.chatStream()`，让 LLM 边生成边输出，CLI 看到的不再是"等几秒蹦出整段"，而是逐字流出。

技术挑战：
- 消费 Anthropic SDK 的 `messages.stream()` async iterable
- **tool_call arguments 是分片到达的 JSON 字符串**，要边累积边等到 `input_json_delta` 全部到齐才能 parse
- runner 端的状态机要重写一部分（在 stream 模式下边输出边判断要不要执行工具）
