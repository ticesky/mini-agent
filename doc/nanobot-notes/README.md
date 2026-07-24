# nanobot 源码学习笔记

> 边读 nanobot 源码边记的笔记。每篇对应一个核心模块或主题。
>
> 笔记风格：**对照 mini-agent 学**——所有差异都对回我们已写的代码，问"为什么 nanobot 这么做、值不值得抄回来"。

## 阅读路径

- [`00-design-principles.md`](./00-design-principles.md) — `.agent/design.md` 读后总结："核心精简，边缘扩展"
- [`01-tools-registry.md`](./01-tools-registry.md) — `agent/tools/registry.py`：动态注册的真实需求
- [`02-tools-base.md`](./02-tools-base.md) — `agent/tools/base.py`：cast 与 validate 双递归
- [`03-providers-base.md`](./03-providers-base.md) — `providers/base.py`：错误归一三层判定 + 重试
- [`04-autocompact.md`](./04-autocompact.md) — `agent/autocompact.py`：多 session 闲置归档（不是单 session 压缩！）
- [`05-runner-vs-loop-and-resources.md`](./05-runner-vs-loop-and-resources.md) — `runner.py` vs `loop.py`：职责切分 + 记忆双阶段 + subagent + 资源归属
- [`06-hook.md`](./06-hook.md) — `agent/hook.py`：扩展点设计 + Python 语法速通
- [`07-memory-store.md`](./07-memory-store.md) — `agent/memory.py` 完整解读：MemoryStore + Consolidator（SOUL/USER/MEMORY 三层 + Dream + 双游标 + 多策略压缩）
- [`08-mcp.md`](./08-mcp.md) — `agent/tools/mcp.py`：生产级 MCP（3 种 wrapper + 3 种 transport + 重试重连 + 热重载）
- [`09-skills-and-templates.md`](./09-skills-and-templates.md) — `skills/` 与 `templates/`：prompt 工程的两层抽象（按需加载工作流 + 运行时拼 prompt）

## 学习方法备忘

1. **永远带着 mini-agent 对照读**——已知的代码是基准答案
2. **grep + 跳读**，不要顺读
3. **困惑就跑断点**——`pip install -e .` 加 `breakpoint()`
4. **判断核心 vs 边缘**：核心 = 不能动；边缘 = 自由增删
5. **永远问"这段代码在解决哪个真实场景的什么具体问题"**——找不到的可能是过早抽象
