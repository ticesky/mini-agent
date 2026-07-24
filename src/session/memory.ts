/**
 * 会话历史持久化。
 *
 * 对应 nanobot/agent/memory.py + nanobot/session/manager.py（极简版）。
 *
 * 设计：
 *   - 每个 sessionId 一个 JSON 文件：sessions/<sessionId>.json
 *   - 原子写：写到 .tmp 再 rename，避免进程崩溃留下半截文件
 *   - 强制 fsync：rename 之前调 fdatasync，保证数据真的落盘
 *   - 写入间隔节流（debounce）：用户连续输入时不每次都写硬盘，
 *     而是合并 200ms 内的写入。最后一次 flush 必须 await。
 *
 * 没做的事（vs nanobot）：
 *   - 不做 Dream 两阶段记忆巩固（短期/长期分层）
 *   - 不做 TTL 自动清理
 *   - 不做按 channel + user 拼 sessionId（MVP CLI 永远只有 "cli"）
 *   - 不做并发锁（filelock）—— MVP 同一个 sessionId 同时只有一个进程在用
 */
import {
  mkdir,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Message } from "../types.ts";

/** 持久化在硬盘上的形态：版本 + system + 多轮消息。 */
interface PersistedSession {
  /** 数据格式版本，便于将来升级时兼容。 */
  version: 1;
  sessionId: string;
  /** ISO 时间戳，最后一次落盘时间。 */
  updatedAt: string;
  messages: Message[];
}

const FORMAT_VERSION = 1;

/** 单个 session 的内存视图 + 自动持久化。 */
export class SessionStore {
  /** 在内存里的完整历史（与硬盘最终一致，但可能比硬盘新 200ms）。 */
  readonly messages: Message[];
  /** 节流写入：最近一次预约的 setTimeout id。 */
  private flushTimer: NodeJS.Timeout | null = null;
  /** 节流写入间隔。 */
  private readonly debounceMs: number;
  /** 落盘路径。 */
  private readonly file: string;
  private readonly sessionId: string;

  private constructor(opts: {
    sessionId: string;
    file: string;
    messages: Message[];
    debounceMs: number;
  }) {
    this.sessionId = opts.sessionId;
    this.file = opts.file;
    this.messages = opts.messages;
    this.debounceMs = opts.debounceMs;
  }

  /**
   * 加载或新建一个 session。
   * 文件不存在/损坏时返回空的 SessionStore，不抛异常。
   */
  static async load(opts: {
    dir: string;
    sessionId: string;
    debounceMs?: number;
    /** 文件不存在时使用的初始 messages（一般是 system prompt）。 */
    initialMessages?: Message[];
  }): Promise<SessionStore> {
    const file = join(opts.dir, `${opts.sessionId}.json`);
    let messages: Message[] = opts.initialMessages ? [...opts.initialMessages] : [];

    try {
      const raw = await readFile(file, "utf8");
      const data = JSON.parse(raw) as PersistedSession;
      if (data && data.version === FORMAT_VERSION && Array.isArray(data.messages)) {
        messages = data.messages;
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        // 损坏文件：仅警告，不阻塞启动。下一次保存会覆盖。
        console.warn(
          `[session] 文件 ${file} 解析失败，已忽略并使用初始历史。原因：${err.message}`,
        );
      }
    }

    return new SessionStore({
      sessionId: opts.sessionId,
      file,
      messages,
      debounceMs: opts.debounceMs ?? 200,
    });
  }

  /** 标记需要保存。会节流：连续调用合并到 debounceMs 后一次写盘。 */
  scheduleSave(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // 触发但不 await——失败也只 console.warn
      this.saveNow().catch((e) => {
        console.warn(`[session] 自动保存失败：${(e as Error).message}`);
      });
    }, this.debounceMs);
  }

  /**
   * 立刻落盘。原子写：tmp + fdatasync + rename。
   * 调用方应在退出前 await 一次以确保最终态保留。
   */
  async saveNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const data: PersistedSession = {
      version: FORMAT_VERSION,
      sessionId: this.sessionId,
      updatedAt: new Date().toISOString(),
      messages: this.messages,
    };
    const json = JSON.stringify(data, null, 2);
    const tmp = `${this.file}.tmp`;

    await mkdir(dirname(this.file), { recursive: true });
    // 写 tmp + fsync 确保数据真的落盘（不是只在 page cache）
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(json, "utf8");
      await fh.datasync();
    } finally {
      await fh.close();
    }
    // rename 是原子的：要么旧文件还在、要么新文件就位
    await rename(tmp, this.file);
  }

  /** 清空消息（保留 system prompt）。立即写盘。 */
  async clear(keep: Message[] = []): Promise<void> {
    this.messages.length = 0;
    this.messages.push(...keep);
    await this.saveNow();
  }
}
