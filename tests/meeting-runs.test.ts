import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  appendRunDelta,
  appendRunEntry,
  clearRun,
  failRun,
  finishRun,
  getRun,
  isRunning,
  listRunningRuns,
  resetRunsForTest,
  startRun,
} from '../src/meeting-runs.js';

const entry = (speaker: string, content: string) =>
  ({ role: 'assistant', speaker, provider: 'chatgpt', stage: 'discussion', content }) as const;

describe('会议后台运行状态', () => {
  beforeEach(() => {
    resetRunsForTest();
  });

  it('开始后处于 running，重跑会被挡住', () => {
    startRun('meeting-1');
    assert.equal(isRunning('meeting-1'), true);
    // 同一场会议再起一次会两边的发言混在一起，必须挡住
    assert.equal(isRunning('meeting-1'), true);
  });

  it('按顺序记录发言', () => {
    startRun('meeting-1');
    appendRunEntry('meeting-1', entry('chatgpt1', '素洁'));
    appendRunEntry('meeting-1', entry('claude1', '皎洁'));
    assert.deepEqual(
      getRun('meeting-1')?.entries.map((e) => e.speaker),
      ['chatgpt1', 'claude1'],
    );
  });

  it('结束后不再接受发言', () => {
    startRun('meeting-1');
    appendRunEntry('meeting-1', entry('chatgpt1', '素洁'));
    finishRun('meeting-1', '最终答复');
    appendRunEntry('meeting-1', entry('claude1', '迟到的发言'));

    assert.equal(getRun('meeting-1')?.status, 'done');
    assert.equal(getRun('meeting-1')?.summary, '最终答复');
    assert.deepEqual(
      getRun('meeting-1')?.entries.map((e) => e.speaker),
      ['chatgpt1'],
      '跑完之后到达的发言要被丢掉，否则会串进结果',
    );
    assert.equal(isRunning('meeting-1'), false);
  });

  it('失败也留痕，页面回来能看到原因', () => {
    startRun('meeting-1');
    failRun('meeting-1', 'gemini 没能确认这一轮是否真的发出去了');
    assert.equal(getRun('meeting-1')?.status, 'error');
    assert.match(getRun('meeting-1')?.error ?? '', /gemini/);
  });

  it('落库后清掉，下次打开不会误显示"正在跑"', () => {
    startRun('meeting-1');
    clearRun('meeting-1');
    assert.equal(getRun('meeting-1'), undefined);
    assert.equal(isRunning('meeting-1'), false);
  });

  it('列出所有还在跑的会议', () => {
    startRun('meeting-1');
    startRun('meeting-2');
    finishRun('meeting-2', '好了');
    assert.deepEqual(
      listRunningRuns().map((run) => run.meetingId),
      ['meeting-1'],
    );
  });

  it('没开始的会议不会被凭空写出状态', () => {
    appendRunEntry('meeting-不存在', entry('chatgpt1', '素洁'));
    finishRun('meeting-不存在', '答复');
    assert.equal(getRun('meeting-不存在'), undefined);
  });

  describe('增量（只有 Grok 走 WebSocket 才推得出来）', () => {
    it('逐段累加到同一条发言上', () => {
      startRun('meeting-1');
      assert.equal(appendRunDelta('meeting-1', 'grok1', 'grok', 1, '冬'), true, '第一次是新发言');
      assert.equal(appendRunDelta('meeting-1', 'grok1', 'grok', 1, '日'), false, '后续是追加');

      const run = getRun('meeting-1');
      assert.equal(run?.entries.length, 1);
      assert.equal(run?.entries[0].content, '冬日');
    });

    it('不同人各占一条', () => {
      startRun('meeting-1');
      appendRunDelta('meeting-1', 'grok1', 'grok', 1, '甲');
      appendRunDelta('meeting-1', 'claude1', 'claude', 1, '乙');
      assert.deepEqual(
        getRun('meeting-1')?.entries.map((e) => e.content),
        ['甲', '乙'],
      );
    });

    it('完整发言到达时替换掉半截的，不产生第二条', () => {
      // 不替换的话，时间线上会先出现半句、再出现完整的一句，看起来像说了两遍。
      startRun('meeting-1');
      appendRunDelta('meeting-1', 'grok1', 'grok', 1, '冬日的清晨');
      appendRunEntry('meeting-1', {
        role: 'assistant',
        speaker: 'grok1',
        provider: 'grok',
        stage: 'discussion',
        round: 1,
        content: '冬日的清晨，大地被一层薄霜轻轻覆盖。',
      });

      const run = getRun('meeting-1');
      assert.equal(run?.entries.length, 1);
      assert.match(run?.entries[0].content ?? '', /薄霜轻轻覆盖。$/);
    });

    it('完整发言带 round 时才对得上——这是 meeting.entry 的真实形状', () => {
      // 增量条目带 round，完整条目也必须带，否则两边对不上号。
      startRun('meeting-1');
      appendRunDelta('meeting-1', 'grok1', 'grok', 2, '甲');
      assert.deepEqual(
        getRun('meeting-1')?.entries.map((e) => e.round),
        [2],
      );
    });

    it('跑完就不再收增量', () => {
      startRun('meeting-1');
      finishRun('meeting-1', '答复');
      assert.equal(appendRunDelta('meeting-1', 'grok1', 'grok', 1, '迟到的'), false);
      assert.equal(getRun('meeting-1')?.entries.length, 0);
    });
  });
});
