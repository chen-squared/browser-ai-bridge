/**
 * 会议记录存储。
 *
 * 为什么要存：会议要能**多轮**并且**留记录可管理**，而网页侧的会话只是"当次编排
 * 用到的几个标签页"，不是会议本身。会议记录（用户问了什么、谁答了什么、怎么收口的）
 * 只存在于 bridge 这一侧，不存下来就没有第二次。
 *
 * 落盘位置与 conversation-urls 同级（默认 `.sessions/`），原子写入 + 串行 flush，
 * 避免并发请求互相覆盖。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProviderId } from './types.js';

export type MeetingStage = 'input' | 'assignment' | 'discussion' | 'summary';

export type MeetingEntry = {
  role: 'user' | 'assistant';
  speaker: string;
  provider?: ProviderId;
  stage: MeetingStage;
  content: string;
};

/** 一轮 = 用户一句话 + 随之而来的全部发言与总结。 */
export type MeetingTurn = {
  /** 用户在这一轮说的话。 */
  userMessage: string;
  /** 这一轮产生的全部发言（含分工、各席位发言、总结），顺序即发生顺序。 */
  entries: MeetingEntry[];
  createdAt: number;
};

export type MeetingRecord = {
  id: string;
  /** 由首轮用户消息截断生成，可在界面上改。 */
  title: string;
  mode: 'round-robin' | 'parallel';
  /** 席位对应的 provider，按发言顺序。席位名由服务端按序号推导。 */
  participants: ProviderId[];
  summarizer: ProviderId;
  /** 复用哪个席位的会话；空串=总结者开新会话。 */
  summarizerSeat: string;
  rounds: number;
  turns: MeetingTurn[];
  createdAt: number;
  updatedAt: number;
};

const MAX_RECORDS = 200;
/** 每场会议保留多少轮。超出的从最早开始丢，避免文件无限长。 */
const MAX_TURNS = 50;

function isProvider(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    ['chatgpt', 'gemini', 'claude', 'grok', 'qwen', 'deepseek'].includes(value)
  );
}

function coerceEntry(value: unknown): MeetingEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.content !== 'string' || typeof raw.speaker !== 'string') {
    return null;
  }
  const stage = raw.stage;
  return {
    role: raw.role === 'user' ? 'user' : 'assistant',
    speaker: raw.speaker,
    ...(isProvider(raw.provider) ? { provider: raw.provider } : {}),
    stage:
      stage === 'assignment' || stage === 'discussion' || stage === 'summary' ? stage : 'input',
    content: raw.content,
  };
}

function coerceTurn(value: unknown): MeetingTurn | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.userMessage !== 'string') {
    return null;
  }
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(coerceEntry).filter((entry): entry is MeetingEntry => entry !== null)
    : [];
  return {
    userMessage: raw.userMessage,
    entries,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
  };
}

function coerceRecord(value: unknown): MeetingRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id) {
    return null;
  }
  const participants = Array.isArray(raw.participants) ? raw.participants.filter(isProvider) : [];
  if (participants.length < 2) {
    // 少于两个席位的记录不可能被复现出来（服务端要求至少两个），直接丢掉
    return null;
  }
  const turns = Array.isArray(raw.turns)
    ? raw.turns.map(coerceTurn).filter((turn): turn is MeetingTurn => turn !== null)
    : [];
  return {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title ? raw.title : '未命名会议',
    mode: raw.mode === 'parallel' ? 'parallel' : 'round-robin',
    participants,
    summarizer: isProvider(raw.summarizer) ? raw.summarizer : 'deepseek',
    summarizerSeat: typeof raw.summarizerSeat === 'string' ? raw.summarizerSeat : '',
    rounds: typeof raw.rounds === 'number' && raw.rounds > 0 ? raw.rounds : 1,
    turns,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

export class MeetingStore {
  private readonly records = new Map<string, MeetingRecord>();
  private flushQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<MeetingStore> {
    const store = new MeetingStore(filePath);
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const value of Object.values(parsed as Record<string, unknown>)) {
          const record = coerceRecord(value);
          if (record) {
            store.records.set(record.id, record);
          }
        }
      }
    } catch {
      // 文件不存在或读不了都当作"还没有记录"，不该让服务起不来
    }
    return store;
  }

  list(): MeetingRecord[] {
    return [...this.records.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  get(id: string): MeetingRecord | undefined {
    return this.records.get(id);
  }

  create(input: Omit<MeetingRecord, 'turns' | 'createdAt' | 'updatedAt'>): MeetingRecord {
    const now = Date.now();
    const record: MeetingRecord = { ...input, turns: [], createdAt: now, updatedAt: now };
    this.records.set(record.id, record);
    this.prune();
    this.persist();
    return record;
  }

  /** 追加一轮，并把标题补成首轮用户消息的截断（用户还没改名时）。 */
  appendTurn(id: string, turn: Omit<MeetingTurn, 'createdAt'>): MeetingRecord | undefined {
    const record = this.records.get(id);
    if (!record) {
      return undefined;
    }
    record.turns.push({ ...turn, createdAt: Date.now() });
    if (record.turns.length > MAX_TURNS) {
      record.turns.splice(0, record.turns.length - MAX_TURNS);
    }
    if (record.title === '未命名会议' || record.turns.length === 1) {
      record.title = deriveTitle(turn.userMessage);
    }
    record.updatedAt = Date.now();
    this.persist();
    return record;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        MeetingRecord,
        'title' | 'participants' | 'summarizer' | 'summarizerSeat' | 'rounds' | 'mode'
      >
    >,
  ): MeetingRecord | undefined {
    const record = this.records.get(id);
    if (!record) {
      return undefined;
    }
    Object.assign(record, patch, { updatedAt: Date.now() });
    this.persist();
    return record;
  }

  remove(id: string): boolean {
    const removed = this.records.delete(id);
    if (removed) {
      this.persist();
    }
    return removed;
  }

  /** 跨场的全部发言，按时间顺序——新一轮的种子。 */
  transcriptOf(id: string): MeetingEntry[] {
    return (this.records.get(id)?.turns ?? []).flatMap((turn) => [
      {
        role: 'user' as const,
        speaker: 'user',
        stage: 'input' as const,
        content: turn.userMessage,
      },
      ...turn.entries,
    ]);
  }

  private prune(): void {
    const overflow = [...this.records.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(MAX_RECORDS);
    for (const record of overflow) {
      this.records.delete(record.id);
    }
  }

  /**
   * 落盘走「先写临时文件再改名」：直接覆盖的话，中途崩了会留下半截 JSON，
   * 而这个文件是唯一的会议记录，丢了没法补。
   */
  private persist(): void {
    const snapshot = Object.fromEntries(this.records);
    this.flushQueue = this.flushQueue
      .then(async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        await writeFile(tmp, JSON.stringify(snapshot, null, 1), 'utf8');
        await rename(tmp, this.filePath);
      })
      .catch(() => undefined);
  }

  /** 等落盘完成。测试和关进程前用得上。 */
  async flushed(): Promise<void> {
    await this.flushQueue;
  }
}

/** 从首轮用户消息生成标题。取第一行的前 24 个码点，避免 emoji 被切半。 */
export function deriveTitle(message: string): string {
  const firstLine =
    message
      .trim()
      .split('\n')
      .find((line) => line.trim()) ?? '';
  const points = [...firstLine.trim()];
  const clipped = points.length > 24 ? `${points.slice(0, 24).join('')}…` : points.join('');
  return clipped || '未命名会议';
}
