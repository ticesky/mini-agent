# 09 — `skills/` 与 `templates/`：prompt 工程的两层抽象

> mini-agent 的 system prompt 是 `index.ts` 里硬编码的一句话。
> nanobot 把"prompt 工程"做成了**两层独立子系统**：skills（按需加载的工作流文档）+ templates（运行时拼装的 prompt 零件）。
>
> 这是从"agent 能跑"走到"agent 能成长"的关键设计。

## 一句话理解

```
skills/      = "可复用的 agent 工作流文档"
               写给 LLM 看的，告诉它"做某类任务时怎么调工具"
templates/   = "拼 prompt 用的零件"
               写给 nanobot 代码看的，运行时 render 后塞进 system prompt
```

两者都是 markdown 文件，但消费者完全不同：
- **skills**：LLM 在对话中按需阅读
- **templates**：nanobot 运行时拼 prompt

## skills/ —— 工作流文档作为能力扩展

### 目录结构

```
nanobot/skills/
├── README.md             ← 索引
├── github/SKILL.md       ← 用 gh CLI 操作 GitHub
├── weather/SKILL.md      ← 用 wttr.in 查天气
├── summarize/SKILL.md    ← 摘要 URL/文件/视频
├── tmux/SKILL.md         ← 远控 tmux
├── clawhub/SKILL.md      ← 从 ClawHub 装新 skill
├── skill-creator/SKILL.md← 创建新 skill
├── long-goal/SKILL.md    ← long_task / complete_goal 用法
├── cron/SKILL.md         ← cron 工具用法
├── memory/SKILL.md       ← 记忆系统操作
├── image-generation/SKILL.md
├── update-setup/SKILL.md
└── my/SKILL.md
```

每个 skill 是**一个目录**，里面至少有一个 `SKILL.md`。

### SKILL.md 的格式

```markdown
---
name: cron
description: Schedule reminders and recurring tasks.
---

# Cron

Use the `cron` tool to schedule reminders or recurring tasks.

## Three Modes

1. **Reminder** - message is sent directly to user
2. **Task** - message is a task description, agent executes and sends result
3. **One-time** - runs once at a specific time, then auto-deletes

## Examples

Fixed reminder:
\`\`\`
cron(action="add", message="Time to take a break!", every_seconds=1200)
\`\`\`
...
```

关键细节：

1. **YAML frontmatter** 是 metadata：`name` 用作 ID，`description` 是 skill 索引时让 LLM 看的"摘要"
2. **正文是给 LLM 看的工具用法说明**，包含示例命令、参数表、最佳实践
3. **不是 nanobot 自己解析的格式**——nanobot 把整段 markdown 直接塞给 LLM

### 重点：skill 不是新工具

> **skill 不是新工具——它是"用现有工具解决某类问题的说明书"。**

举例：
- `cron/SKILL.md` 里说的 "cron 工具" 其实是 nanobot 内置的 `cron` 工具（`agent/tools/cron.py`）
- skill 的作用是：当用户说"每天 9 点提醒我"时，**LLM 加载 cron skill → 看完文档 → 知道该用 `cron(action="add", cron_expr="0 9 * * *")` 这种格式**

→ skill = **prompt 形态的文档**，把"工具该怎么用"从代码里独立出来给 LLM。

### Skill 怎么被加载

不会一启动就把 12 个 skill 全塞进 system prompt（那 token 直接爆了）。
**按需加载**模式：

1. **system prompt 里只列 skill 索引**（name + description 一句话）
   ```
   Available skills:
   - github: Interact with GitHub using the gh CLI
   - cron: Schedule reminders and recurring tasks
   - long-goal: Sustained objectives via long_task / complete_goal
   - ...
   ```
2. LLM 看到任务后**自己决定要读哪个 SKILL.md**
3. 调 `read_file` 或专用工具读对应文件
4. 完整说明书进上下文，按文档指引调工具

→ 这是**"把 system prompt 切成索引 + 按需文档"** 的设计。
单个 SKILL.md 几百到几千字，全加载会占满 context；按需加载只在需要时付出 token 成本。

### Skill 跟 SOUL/USER/MEMORY 的关系

回笔记 07：

```
SOUL.md   = Agent 性格（不变）
USER.md   = 用户画像（慢变）
MEMORY.md = 客观事实（中变）
SKILL.md  = 工作流文档（按需加载）
```

四者层次：
- 前三个是**每次请求都加载**的 prompt（因为它们决定"我是谁、跟谁聊、聊过什么"）
- skill 是**按需加载**的（"这次任务用得上才看"）

dream.md 里讲得很清楚：

> SKILL.md / `skills/<name>/SKILL.md` / 内容：Reusable workflow templates with concrete steps, commands, and examples ([SKILL] entries only)

### 用户自定义 skills

`workspace/skills/` 也能放 skills（在用户自己的 workspace，跟 nanobot 内置的并列）。
Dream 任务（笔记 07）可以**自动**写出新的 skill：当 LLM 发现"这个工作流我反复在做"，就生成一个 SKILL.md 放到 `workspace/skills/`，下次自动可用。

→ **agent 自我学习的载体**。这是 SOUL/USER/MEMORY/SKILL 四件套真正的厉害之处：agent 跟用户聊得多了，会自己长出新文档。

## templates/ —— 运行时拼 prompt 的零件

### 目录结构

```
nanobot/templates/
├── AGENTS.md             ← 给 AI agent（包括读源码的 Claude）看的项目说明
├── HEARTBEAT.md          ← 心跳任务的 system prompt
├── SOUL.md               ← 默认 SOUL（"我是谁"）
├── USER.md               ← 默认 USER（空白模板）
├── memory/
│   └── MEMORY.md         ← 默认 MEMORY（空白模板）
└── agent/
    ├── _snippets/        ← 可复用片段
    ├── identity.md       ← 注入"我是谁、workspace 在哪、当前 channel"
    ├── consolidator_archive.md ← 摘要 prompt
    ├── dream.md          ← Dream 任务的 system prompt
    ├── cron_reminder.md
    ├── evaluator.md
    ├── max_iterations_message.md
    ├── platform_policy.md
    ├── skills_section.md ← 列出 skill 索引
    ├── subagent_announce.md
    ├── subagent_system.md
    └── tool_contract.md
```

### Template 跟 Skill 的根本区别

| 维度 | skills/ | templates/ |
|---|---|---|
| 谁消费 | LLM | nanobot 代码 |
| 何时加载 | LLM 按需调 read_file | 启动 / 每次请求时 render |
| 是否 render | 不 render（原文给 LLM） | 用 Jinja2 模板 render |
| 用户能改吗 | 能（workspace/skills/） | 一般不能（nanobot 内置） |
| 数量 | 13 个 | 13+ 个片段 |

### Template 用 Jinja2 渲染

`templates/agent/identity.md` 的真实内容：

```jinja
## Workspace
Your workspace is at: {{ workspace_path }}
- Long-term memory: {{ workspace_path }}/memory/MEMORY.md
- History log: {{ workspace_path }}/memory/history.jsonl
- Custom skills: {{ workspace_path }}/skills/{skill-name}/SKILL.md

{% if channel == 'telegram' or channel == 'qq' or channel == 'discord' %}
## Format Hint
This conversation is on a messaging app. Use short paragraphs...
{% elif channel == 'whatsapp' or channel == 'sms' %}
## Format Hint
This conversation is on a text messaging platform that does not render markdown...
{% elif channel == 'cli' or channel == 'mochat' %}
...
{% endif %}
```

`{{ }}` 是变量插值，`{% if %}` 是条件分支——这就是 Jinja2 模板。

代码里调用：

```python
render_template("agent/identity.md", channel="telegram", workspace_path="...")
```

→ **同一个 template 渲染出针对不同 channel 的 prompt**：
- 在 Telegram 上提示"用短段落"
- 在 WhatsApp 上提示"用纯文本"
- 在 CLI 上提示"少用 markdown headings"

### 几个最重要的 template

#### `SOUL.md`（默认人格）

```markdown
# Soul
I am nanobot 🐈, a personal AI assistant.

## Core Principles
- Solve by doing, not by describing what I would do.
- Keep responses short unless depth is asked for.
- Say what I know, flag what I don't, and never fake confidence.
...

## Execution Rules
- Act immediately on single-step tasks — never end a turn with just a plan.
- For multi-step tasks, outline the plan first and wait for user confirmation.
- Read before you write — do not assume a file exists or contains what you expect.
- If a tool call fails, diagnose the error and retry with a different approach.
...
```

新用户第一次跑 nanobot 时，这个文件被**复制**到 `workspace/SOUL.md`。
之后用户和 Dream 都能修改它，agent 的个性会随对话演化。

#### `agent/identity.md`（每次请求都 render）

```jinja
## Runtime
{{ runtime }}                            ← 当前时间、模型、版本

## Workspace
Your workspace is at: {{ workspace_path }}

{{ platform_policy }}                    ← 各平台政策

{% if channel == 'cli' %}
## Format Hint
Output is rendered in a terminal. Avoid markdown headings...
{% endif %}
```

每次请求 LLM 时拼 system prompt 都从这里 render 一段塞进去。

#### `agent/dream.md`（Dream 任务的 system prompt）

笔记 07 讲过 Dream 任务，它的 system prompt 就是这个文件：

```markdown
You are a memory consolidation engine. Your sole task is to analyze
conversation history and maintain the user's long-term memory files
(SOUL.md, USER.md, MEMORY.md, SKILL.md). You are ruthless about pruning...

## File routing
| File | Path | Content |
|------|------|---------|
| SOUL.md | `SOUL.md` | Agent behavior rules, guardrails, ... |
| USER.md | `USER.md` | Personal attributes: identity, preferences, ... |
| MEMORY.md | `memory/MEMORY.md` | Project context: goals, architecture, ... |
| SKILL.md | `skills/<name>/SKILL.md` | Reusable workflow templates ... |
...
```

**这就是 Dream 怎么"知道"该把什么写到哪个文件**——不是 hardcode，是 prompt 里写清楚的规则。

#### `agent/consolidator_archive.md`（笔记 07 提过）

`Consolidator.archive()` 调 LLM 摘要时用的 system prompt。

### `_snippets/` 目录

```
templates/agent/_snippets/
├── untrusted_content.md    ← 处理用户上传文件的安全提示
├── ...
```

Jinja2 模板支持 `{% include 'agent/_snippets/untrusted_content.md' %}`，把片段嵌进主 template。
**避免重复**：相同的"安全提示"不用在 5 个 template 里各写一遍。

### 为什么用 Jinja2 而不是 Python f-string

```python
# 不用这样：
prompt = f"You are at {workspace_path}.\n## Skills\n{skills_section}"

# 而用：
prompt = render_template("agent/identity.md", workspace_path=..., skills_section=...)
```

三个理由：

1. **prompt 可以让非工程师改**——markdown 文件谁都能读改，f-string 必须懂 Python
2. **条件分支整洁**：channel 那段 if/elif 用 Jinja2 写在 markdown 里，比 Python 拼字符串清楚得多
3. **A/B 测试方便**：换 prompt 不用改代码，改 .md 文件就行

→ **"让 prompt 跟代码分离"**的工程实践，跟现代 web 开发"模板和逻辑分离"是一个思路。

## skills 与 templates 在系统里的协作

放在一张图里：

```
启动 nanobot
   ↓
读 templates/SOUL.md → 复制到 workspace/SOUL.md（如果不存在）
读 templates/USER.md → 复制到 workspace/USER.md（如果不存在）
   ↓
用户输入"每天提醒我喝水"
   ↓
loop._state_build:
   render_template("agent/identity.md", channel="cli", workspace_path=...)
   render_template("agent/skills_section.md", skills=[...])  ← 列出 skill 索引
   读 workspace/SOUL.md → 拼进 system prompt
   读 workspace/USER.md → 拼进 system prompt
   读 workspace/memory/MEMORY.md → 拼进 system prompt
   ↓
调 LLM
   ↓
LLM 看到 "Available skills: cron - Schedule reminders ..."
   ↓
LLM 调 read_file("nanobot/skills/cron/SKILL.md")
   ↓
看完详细文档，调 cron(action="add", cron_expr="0 9 * * *", ...)
   ↓
结果回到 LLM，回复用户
   ↓
turn 结束 → history.jsonl append
   ↓
Dream 后台跑：
   render_template("agent/dream.md")
   读 history.jsonl 里 .dream_cursor 之后的条目
   调 LLM 决定哪些事实写到 SOUL/USER/MEMORY/SKILL
   写文件，commit git
```

**skills + templates 是 prompt 工程的两层抽象**：
- templates = 结构化的 prompt 拼装系统
- skills = LLM 按需消费的工作流文档库

## 跟 mini-agent 对比

| 议题 | mini-agent | nanobot |
|---|---|---|
| system prompt | 硬编码在 index.ts 里一句话 | Jinja2 模板 + workspace 里的 SOUL/USER/MEMORY |
| 工具用法说明 | 工具的 description 字段 | description + 独立 SKILL.md |
| 按需加载文档 | ❌ | LLM 自己读 SKILL.md |
| 平台差异化 prompt | ❌ | identity.md 按 channel 分支 |
| 用户自定义 prompt | ❌ | 编辑 workspace/SOUL.md 即可 |
| Prompt 跟代码分离 | ❌ | templates/ 全部 markdown |

**mini-agent 没做这两层完全合理**：
- CLI 一个 channel，不需要平台差异化
- 工具就 3 个，description 够用
- 学习项目，不需要"非工程师能改 prompt"

但**做完 mini-agent 之后看 nanobot 的 prompt 体系，能学到 prompt 工程的真正打法**。

## 几个值得带走的设计观察

### 1. "把 prompt 当代码" vs "把 prompt 当数据"

| 风格 | 谁在用 |
|---|---|
| **prompt 当代码**（在 .py 里 f-string 拼） | 大多数小 agent 项目 |
| **prompt 当数据**（独立 .md + render） | nanobot / Cursor / Claude Code |

成熟项目都走第二条路——因为 prompt 比代码改得勤多了。

### 2. "skill 是文档不是工具"

很多人写 agent 时倾向于把"工作流"做成新工具（`scheduleReminderTool`、`replyOnGitHubTool`...）。
nanobot 反其道而行——**这些都做成 SKILL.md，工具保持极简**。

为什么？
- **工具数量爆炸的代价是 LLM 选择困难**（30 个工具时模型经常选错）
- **复杂工具难维护**（每加一个新场景都要改代码 + 测试）
- **skills 用文档替代代码**——加新工作流只需要写一个 .md

→ 这是"核心精简，边缘扩展"原则在 prompt 层的体现：**核心工具集冻结，工作流自由生长**。

### 3. 默认 prompt 是种子，让用户长

```
templates/SOUL.md  ← nanobot 写的"种子人格"
   ↓ 第一次启动复制
workspace/SOUL.md  ← 用户和 agent 共同维护
```

**模板只是起点，不是终点**。
跟 Vue/React 的项目脚手架一样：`create-vue` 给你初始代码，之后你想怎么改怎么改。

### 4. Dream 通过修改 prompt 实现学习

笔记 07 提过 Dream 工具集只能写 SOUL/USER/MEMORY/SKILL。
**它不修改代码，只修改 prompt 文件**。

→ 这是 LLM 时代独特的学习方式：
- 传统 ML：模型权重训练
- nanobot：让 LLM 写 prompt 给下次的 LLM 看

每次 Dream 跑完，agent 实际上更"了解"用户、对世界更"有看法"。这是**用文件系统模拟 fine-tuning**。

## 给读 nanobot 的检查清单

读到任何一段跟 prompt 相关的代码，问自己：

1. **这是 skill 还是 template？** → LLM 消费 vs 代码消费
2. **是按需加载还是每次加载？** → skills 索引 + 按需 read，templates 每次 render
3. **它是种子（templates/）还是用户态（workspace/）？** → 第一次启动复制，之后用户态可改
4. **Dream 能不能修改？** → 只 SOUL/USER/MEMORY/SKILL 能（沙箱 by capability）
5. **render 时需要哪些上下文变量？** → channel / workspace / runtime / 用户态文件内容

## 给 mini-agent 加 skills/templates 的最小方案

### Skill 系统（半天工作量）

```ts
// src/skills/loader.ts
export async function loadSkillIndex(skillsDir: string): Promise<string> {
  const skills = await readdir(skillsDir);
  const lines: string[] = ["Available skills:"];
  for (const name of skills) {
    const skillFile = join(skillsDir, name, "SKILL.md");
    const front = await readFrontmatter(skillFile);
    lines.push(`- ${front.name}: ${front.description}`);
  }
  return lines.join("\n");
}

// 在 index.ts 拼 system prompt 时：
const skillIndex = await loadSkillIndex("./skills");
const SYSTEM_PROMPT = `${BASE_PROMPT}\n\n${skillIndex}`;
```

LLM 看到索引后，让它用 `read_file` 工具读具体的 SKILL.md 即可——**不需要专门的 skill_load 工具**。

### Template 系统（1 小时工作量）

用 `nunjucks`（Node 上 Jinja2 兼容的实现）：

```ts
import nunjucks from "nunjucks";

const env = new nunjucks.Environment(
  new nunjucks.FileSystemLoader("./templates"),
  { autoescape: false },
);

const systemPrompt = env.render("agent/identity.md", {
  workspace_path: workspace,
  channel: "cli",
});
```

加上 3-4 个 template 文件就够了：
- `templates/SOUL.md` 默认人格
- `templates/agent/identity.md` 每次请求 render
- `templates/agent/skills_section.md` skill 索引

### 学习收益

| 改造 | 学到 |
|---|---|
| skills/ 索引 + 按需加载 | LLM 怎么消费"延迟加载"的文档 |
| templates 用 Jinja2 | prompt 工程的现代实践 |
| SOUL/USER/MEMORY 三层 | （配合笔记 07）自我学习的基础 |

前两个是 minimal effort big return。第三个是大改造，但做完你就拥有了"会自我改进的 agent"。

## 一句话总结

> **mini-agent 的 prompt = 一行硬编码字符串**。
> **nanobot 的 prompt = templates 拼装系统 + skills 文档库 + 用户态可演化文件**。
>
> 关键设计：
> - skills 是 LLM 按需读的工作流说明书，不是新工具
> - templates 是 nanobot 代码运行时 render 的零件，让 prompt 跟代码分离
> - SOUL/USER/MEMORY/SKILL 四件套是**用文件系统模拟 fine-tuning**
> - 默认 prompt 是种子，workspace 里的副本由用户和 Dream 共同演化
