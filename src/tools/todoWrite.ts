/**
 * TodoWrite 工具：让 LLM 维护一个"任务清单"。
 *
 * 工作机制：
 *   - LLM 调 TodoWrite 时，全量替换内部 todos 数组（不是增量）
 *   - 每次更新触发已注册的 listener，CLI 拿到后重新渲染整个 box
 *   - 工具执行结果返回给 LLM 时只回一行简短确认，
 *     避免把整个 list 又复读一遍占 token
 *
 * 这是"ReAct + todo 工具"模式的最小实现——LLM 自己决定何时列、何时改，
 * UI 只负责把当前状态画出来。
 */
import { z } from "zod";
import { defineTool } from "./base.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface Todo {
  content: string;
  status: TodoStatus;
}

/** 模块级状态：当前的 todolist。整个进程共享一份。 */
const todos: Todo[] = [];

type TodoListener = (todos: readonly Todo[]) => void;
const listeners = new Set<TodoListener>();

/** CLI / WebUI 等订阅者注册回调。返回反订阅函数。 */
export function subscribeTodos(listener: TodoListener): () => void {
  listeners.add(listener);
  // 立刻喂一次当前状态，订阅者不需要自己去拉初始值
  listener([...todos]);
  return () => listeners.delete(listener);
}

/** 兜底查询接口（一般不用，订阅模式更好）。 */
export function getTodos(): readonly Todo[] {
  return [...todos];
}

export const todoWriteTool = defineTool({
  name: "TodoWrite",
  description:
    "维护当前任务的待办清单。" +
    "适用场景：用户给的任务包含 3 个或以上独立步骤时主动列出来；" +
    "执行过程中每完成一项就再次调用 TodoWrite 把对应项标记为 completed，" +
    "下一项标记为 in_progress；" +
    "全部完成时所有项目都应为 completed。" +
    "简单任务（1-2 步）不要调用此工具。",
  readOnly: false,
  schema: z.object({
    todos: z.array(z.object({
      content: z.string().min(1).describe("任务条目的简短描述（中文）"),
      status: z.enum(["pending", "in_progress", "completed"]),
    })).min(1).describe("完整的任务列表（每次调用都会全量替换）"),
  }),
  execute: async ({ todos: newTodos }) => {
    todos.length = 0;
    todos.push(...newTodos);
    // 通知 UI 重渲染
    for (const l of listeners) {
      try {
        l([...todos]);
      } catch {
        // 单个 listener 出错不影响其他 listener
      }
    }
    // 返回给 LLM 的是简短确认，不复读整个 list（避免 token 浪费）
    const counts = countByStatus(newTodos);
    return `Todo list updated: ${newTodos.length} item(s) — ` +
      `${counts.completed} done, ${counts.in_progress} in progress, ${counts.pending} pending.`;
  },
});

function countByStatus(items: Todo[]): Record<TodoStatus, number> {
  const out: Record<TodoStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
  };
  for (const t of items) out[t.status]++;
  return out;
}
