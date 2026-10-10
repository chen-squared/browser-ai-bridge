import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it } from 'node:test';

import { deriveTitle, MeetingStore } from '../src/meeting-store.js';

/**
 * 会议记录存储。
 *
 * 会议的多轮与"留记录可管理"全靠这一层。网页侧的会话只是当次编排用到的标签页，
 * 不是会议本身——记录丢了就没法复盘、也没法接着聊，所以落盘的可靠性比普通缓存高。
 */

async function freshStore(): Promise<{ store: MeetingStore; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'meeting-store-'));
  const file = path.join(dir, 'meetings.json');
  return { store: await MeetingStore.open(file), file };
}

const base = {
  title: '未命名会议',
  mode: 'round-robin' as const,
  participants: ['chatgpt', 'deepseek'] as const,
  summarizer: 'qwen' as const,
  summarizerSeat: '',
  rounds: 1,
};

describe('会议记录的增删改查', () => {
  it('创建后可取出，列表按更新时间倒序', async () => {
    const { store } = await freshStore();
    const first = store.create({ ...base, id: 'm1', participants: ['chatgpt', 'claude'] });
    await new Promise((r) => setTimeout(r, 5));
    const second = store.create({ ...base, id: 'm2', participants: ['grok', 'qwen'] });

    assert.equal(store.get('m1')?.id, 'm1');
    assert.deepEqual(
      store.list().map((m) => m.id),
      ['m2', 'm1'],
      '最近更新的排在前面，和各家聊天列表的习惯一致',
    );
    assert.equal(first.turns.length, 0);
    assert.equal(second.turns.length, 0);
  });

  it('改动标题不影响轮次', async () => {
    const { store } = await freshStore();
    store.create({ ...base, id: 'm1', participants: ['chatgpt', 'claude'] });
    store.appendTurn('m1', { userMessage: '问题', entries: [] });
    store.update('m1', { title: '方案评审' });

    const record = store.get('m1');
    assert.equal(record?.title, '方案评审');
    assert.equal(record?.turns.length, 1, '改标题不该丢掉已发生的轮次');
  });

  it('删除后取不到，且不会影响别的记录', async () => {
    const { store } = await freshStore();
    store.create({ ...base, id: 'm1', participants: ['chatgpt', 'claude'] });
    store.create({ ...base, id: 'm2', participants: ['grok', 'qwen'] });

    assert.equal(store.remove('m1'), true);
    assert.equal(store.get('m1'), undefined);
    assert.equal(store.remove('m1'), false, '重复删除应当返回 false，而不是抛错');
    assert.ok(store.get('m2'));
  });

  it('追加轮次时自动补标题（用户还没改过名时）', async () => {
    const { store } = await freshStore();
    store.create({ ...base, id: 'm1', participants: ['chatgpt', 'claude'] });
    store.appendTurn('m1', { userMessage: '比较一下这三种实现\n第二行不算', entries: [] });

    assert.equal(store.get('m1')?.title, '比较一下这三种实现');
  });

  it('用户改过标题后，后续轮次不再覆盖它', async () => {
    const { store } = await freshStore();
    store.create({ ...base, id: 'm1', participants: ['chatgpt', 'claude'] });
    store.appendTurn('m1', { userMessage: '第一个问题', entries: [] });
    store.update('m1', { title: '我起的名字' });
    store.appendTurn('m1', { userMessage: '第二个问题', entries: [] });

    assert.equal(store.get('m1')?.title, '我起的名字');
  });
});

describe('多轮的上下文来自存储的 transcript', () => {
  it('跨轮按时间顺序返回，且带上每轮的用户消息', async () => {
    const { store } = await freshStore();
    store.create({ ...base, id: 'm1', participants: ['chatgpt', 'claude'] });
    store.appendTurn('m1', {
      userMessage: '第一问',
      entries: [{ role: 'assistant', speaker: 'chatgpt1', stage: 'discussion', content: '第一答' }],
    });
    store.appendTurn('m1', {
      userMessage: '第二问',
      entries: [{ role: 'assistant', speaker: 'claude1', stage: 'discussion', content: '第二答' }],
    });

    const transcript = store.transcriptOf('m1');
    assert.deepEqual(
      transcript.map((e) => [e.role, e.speaker, e.content]),
      [
        ['user', 'user', '第一问'],
        ['assistant', 'chatgpt1', '第一答'],
        ['user', 'user', '第二问'],
        ['assistant', 'claude1', '第二答'],
      ],
      '新一轮的种子必须是完整的历史，且顺序不能乱',
    );
  });

  it('每轮只存本轮新增的发言，不把整场历史再叠一遍', async () => {
    const { store } = await freshStore();
    store.create({ ...base, id: 'm1', participants: ['chatgpt', 'claude'] });
    store.appendTurn('m1', {
      userMessage: '第一问',
      entries: [{ role: 'assistant', speaker: 'chatgpt1', stage: 'discussion', content: 'A' }],
    });
    store.appendTurn('m1', {
      userMessage: '第二问',
      entries: [{ role: 'assistant', speaker: 'chatgpt1', stage: 'discussion', content: 'B' }],
    });

    assert.deepEqual(
      store.get('m1')?.turns.map((t) => t.entries.length),
      [1, 1],
      '第二轮的 entries 只应有第二轮的发言；混进历史会让 transcript 无限膨胀',
    );
    assert.equal(store.transcriptOf('m1').length, 4, '2 轮 × (1 用户 + 1 发言)');
  });
});

describe('落盘与读回', () => {
  it('重启后记录还在', async () => {
    const { store, file } = await freshStore();
    store.create({ ...base, id: 'm1', participants: ['chatgpt', 'claude'] });
    store.appendTurn('m1', {
      userMessage: '问题',
      entries: [{ role: 'assistant', speaker: 'chatgpt1', stage: 'discussion', content: '答案' }],
    });
    await store.flushed();

    const reopened = await MeetingStore.open(file);
    const record = reopened.get('m1');
    assert.equal(record?.turns.length, 1);
    assert.equal(record?.turns[0].entries[0].content, '答案');
  });

  it('文件损坏时当作"还没有记录"，而不是让服务起不来', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'meeting-broken-'));
    const file = path.join(dir, 'meetings.json');
    await writeFile(file, '{ 这不是 JSON', 'utf8');

    const store = await MeetingStore.open(file);
    assert.deepEqual(store.list(), []);
  });

  it('结构不对的记录被丢弃，不让坏数据进来', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'meeting-bad-'));
    const file = path.join(dir, 'meetings.json');
    await writeFile(
      file,
      JSON.stringify({
        // 少于两个席位：不可能被复现出来
        onlyOne: { ...base, id: 'bad1', participants: ['chatgpt'] },
        noId: { ...base, participants: ['chatgpt', 'claude'] },
        good: {
          ...base,
          id: 'ok1',
          participants: ['chatgpt', 'claude'],
          turns: [
            { userMessage: '问', entries: [{ speaker: 'x', content: '答', role: 'assistant' }] },
          ],
        },
      }),
      'utf8',
    );

    const store = await MeetingStore.open(file);
    assert.equal(store.get('bad1'), undefined);
    assert.equal(store.get('ok1')?.turns.length, 1);
    assert.equal(store.list().length, 1);
  });

  it('落盘用临时文件再改名，中断不会留下半截 JSON', async () => {
    const { store, file } = await freshStore();
    store.create({ ...base, id: 'm1', participants: ['chatgpt', 'claude'] });
    await store.flushed();

    const raw = await readFile(file, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
    assert.ok(!raw.trimEnd().endsWith(','), '不该是写到一半的 JSON');
  });
});

describe('标题生成', () => {
  it('取第一行的前 24 个码点', () => {
    assert.equal(deriveTitle('比较这三种实现的取舍\n第二行不要'), '比较这三种实现的取舍');
    assert.equal(deriveTitle('一'.repeat(40)).length, 25, '超长要截断并加省略号');
  });

  it('按码点而不是 UTF-16 单元切，不会把 emoji 劈成乱码', () => {
    // 一个 emoji 是代理对，占 2 个 UTF-16 单元但只有 1 个码点
    const title = deriveTitle('❄️'.repeat(30));
    assert.ok(!title.includes('�'), '不该出现替换字符');
    assert.ok([...title].every((ch) => ch === '❄' || ch === '️' || ch === '…'));
  });

  it('空消息给出占位标题而不是空串', () => {
    assert.equal(deriveTitle('   \n  '), '未命名会议');
  });
});
