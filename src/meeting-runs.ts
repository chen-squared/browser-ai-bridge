import type { MeetingTranscriptEntry } from './meeting.js';

/**
 * 会议「正在跑」的状态。
 *
 * 之前整场会议绑在一次 HTTP 长连接上：进度靠 SSE 推给页面，结果在最后才落库。
 * 后果是用户中途切到控制台、或者去翻别的会议记录，那条连接一断，页面上的进度
 * 就全没了，人只能干等，回头再看已经是"卡住"的样子——实际上服务器那边还在跑。
 *
 * 这里把进度记在服务端。页面订阅只是**看**，不是**依赖**：
 * 关掉页面、换到别的会议、甚至整个浏览器都不关，会议照跑，跑完照样落库。
 */
export type MeetingRunStatus = 'running' | 'done' | 'error';

export interface MeetingRun {
  meetingId: string;
  status: MeetingRunStatus;
  /** 本次运行新增的发言，按发生顺序。 */
  entries: MeetingTranscriptEntry[];
  /**
   * 当前正在写的人。
   *
   * 没有它，用户中途关掉页面再回来时，只能看到已经写完的几条，
   * 分不清"剩下的还没开始"还是"有人正卡在生成上"。
   */
  speaking?: { speaker: string; provider: string; round: number };
  /** 最终总结；只在 status === 'done' 时有值。 */
  summary: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

/**
 * 只保留最近若干次运行，免得长时间开着服务把内存吃光。
 * 一场会议通常 5~8 条发言，几十条完全够用。
 */
const MAX_TRACKED_RUNS = 40;

const runs = new Map<string, MeetingRun>();

function evictOldest(): void {
  while (runs.size > MAX_TRACKED_RUNS) {
    // 正在跑的绝不能挤掉：挤掉它进度就凭空消失，页面轮询直接 404。
    // 先挤已结束里最老的；要是全在跑，就不动（多占几条比丢进度强）。
    const finished = [...runs.entries()]
      .filter(([, run]) => run.status !== 'running')
      .sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (!finished) {
      return;
    }
    runs.delete(finished[0]);
  }
}

/** 同一场会议已经在跑就别再起一次，否则两边的发言会混在一起。 */
export function isRunning(meetingId: string): boolean {
  return runs.get(meetingId)?.status === 'running';
}

export function startRun(meetingId: string): MeetingRun {
  const now = Date.now();
  const run: MeetingRun = {
    meetingId,
    status: 'running',
    entries: [],
    summary: '',
    startedAt: now,
    updatedAt: now,
  };
  runs.set(meetingId, run);
  evictOldest();
  return run;
}

export function getRun(meetingId: string): MeetingRun | undefined {
  return runs.get(meetingId);
}

/** 记下"谁正在写"。 */
export function setRunSpeaking(
  meetingId: string,
  speaker: string,
  provider: string,
  round: number,
): void {
  const run = runs.get(meetingId);
  if (!run || run.status !== 'running') {
    return;
  }
  run.speaking = { speaker, provider, round };
  run.updatedAt = Date.now();
}

/** 他写完了（或者整场结束了），把"正在写"撤掉。 */
export function clearRunSpeaking(meetingId: string): void {
  const run = runs.get(meetingId);
  if (run) {
    run.speaking = undefined;
  }
}

/**
 * 记一段增量。返回 true 表示这是该发言的第一段。
 *
 * 中途关掉页面再回来时，靠这个把已经写出来的一半补回去，而不是只看到空白。
 * 拿到的是完整发言时 `content` 一次性全到，行为和以前一样。
 */
export function appendRunDelta(
  meetingId: string,
  speaker: string,
  provider: string,
  round: number,
  contentDelta: string,
  stage: MeetingTranscriptEntry['stage'] = 'discussion',
): boolean {
  const run = runs.get(meetingId);
  if (!run || run.status !== 'running') {
    return false;
  }
  const existing = run.entries.find(
    (entry) => entry.speaker === speaker && entry.round === round && entry.stage === stage,
  );
  if (existing) {
    existing.content = (existing.content || '') + contentDelta;
    run.updatedAt = Date.now();
    return false;
  }
  run.entries.push({
    role: 'assistant',
    speaker,
    provider: provider as MeetingTranscriptEntry['provider'],
    stage,
    round,
    content: contentDelta,
  } as MeetingTranscriptEntry);
  run.updatedAt = Date.now();
  return true;
}

/**
 * 记一条完整发言。
 *
 * 如果之前已经用 `appendRunDelta` 攒了半条，这里**替换**掉而不是再追加一条——
 * 否则同一个人会在列表里出现两次（一次半截、一次完整）。
 */
export function appendRunEntry(meetingId: string, entry: MeetingTranscriptEntry): void {
  const run = runs.get(meetingId);
  if (!run || run.status !== 'running') {
    return;
  }
  const index = run.entries.findIndex(
    (item) =>
      item.speaker === entry.speaker && item.round === entry.round && item.stage === entry.stage,
  );
  if (index >= 0) {
    run.entries[index] = entry;
  } else {
    run.entries.push(entry);
  }
  // 他写完了，"正在写"就该换下一个人
  if (run.speaking?.speaker === entry.speaker && run.speaking?.round === entry.round) {
    run.speaking = undefined;
  }
  run.updatedAt = Date.now();
}

export function finishRun(meetingId: string, summary: string): void {
  const run = runs.get(meetingId);
  if (!run) {
    return;
  }
  run.status = 'done';
  run.summary = summary;
  run.speaking = undefined;
  run.updatedAt = Date.now();
}

export function failRun(meetingId: string, error: string): void {
  const run = runs.get(meetingId);
  if (!run) {
    return;
  }
  run.status = 'error';
  run.error = error;
  run.speaking = undefined;
  run.updatedAt = Date.now();
}

/** 清掉某场会议的运行状态。落库成功后调用，免得下次打开还显示"正在跑"。 */
export function clearRun(meetingId: string): void {
  runs.delete(meetingId);
}

/** 所有仍在跑的会议。页面回来时据此提示"有会议正在后台运行"。 */
export function listRunningRuns(): MeetingRun[] {
  return [...runs.values()]
    .filter((run) => run.status === 'running')
    .sort((left, right) => left.startedAt - right.startedAt);
}

/** 只用于测试：把状态清空。 */
export function resetRunsForTest(): void {
  runs.clear();
}
