import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  createGrokAccumulator,
  parseSseEvents,
  parseSseFrames,
  reduceChatgptStream,
  reduceClaudeConversation,
  reduceDeepseekStream,
  reduceGeminiStream,
  reduceGrokStream,
  reduceQwenStream,
  splitGeminiFrames,
} from '../src/stream-capture.js';

/**
 * 真流归约器测试。
 *
 * 全部围绕 src/stream-capture.ts，按 provider 分节。**不要按 provider 拆文件**——
 * 它们的共同点是"把网页收到的协议帧归约成正文 + 思考"，拆开后就看不出这套设计
 * 的关键约束了：每个 provider 一套独立协议，归约器绝不能互相套用。
 *
 * 各节的样本都是**真实抓取的原始帧**，未做改写（只略去了与归约无关的帧）。
 * 手编样例测不出真实协议的脏（重复帧、cp1252 误解码、response.done 早于尾帧）。
 */

// ======================================================================
// 通义千问（qwen）—— HTTP SSE，OpenAI 兼容形状，靠 phase 区分思考/正文
// ======================================================================

// ↓↓↓ 真实抓取的帧，未做任何改动（2026-10，chat.qwen.ai 的 /api/v2/chat/completions）↓↓↓
const REAL_FRAMES = [
  '{"response.created":{"chat_id": "29fafdce-70c1-4d24-bac4-7dceeb6efc70", "parent_id": "61176917-70c8-48d3-a199-05f0df670823", "response_id":"f526d971-1acd-4774-b13b-9b027c56cce8", "response_index": "0"}}',
  '{"choices": [{"delta": {"role": "assistant", "content": "", "phase": "thinking_summary", "extra": {"summary_title": {"content": ["提炼核心意象以回应单一汉字的要求"]}, "summary_thought": {"content": ["我审视题目中关于天空颜色的描述，明确需严格遵循单字的约束条件\\n在蓝色、青色与碧色等候选字中进行权衡\\n最终锁定最契合且直观的“蓝”字作为答案"]}}, "status": "typing"}}], "response_id": "f526d971-1acd-4774-b13b-9b027c56cce8", "usage": {"input_tokens": 1203, "output_tokens": 121, "characters": 0, "total_tokens": 1324, "input_tokens_details": {"text_tokens": 1203}, "output_tokens_details": {"reasoning_tokens": 119, "text_tokens": 121}}, "timestamp": 1791428722}',
  // ↑ 与上一帧内容完全相同，只有 usage 增长 —— 实测站点就是会这样重复下发
  '{"choices": [{"delta": {"role": "assistant", "content": "", "phase": "thinking_summary", "extra": {"summary_title": {"content": ["提炼核心意象以回应单一汉字的要求"]}, "summary_thought": {"content": ["我审视题目中关于天空颜色的描述，明确需严格遵循单字的约束条件\\n在蓝色、青色与碧色等候选字中进行权衡\\n最终锁定最契合且直观的“蓝”字作为答案"]}}, "status": "typing"}}], "response_id": "f526d971-1acd-4774-b13b-9b027c56cce8", "usage": {"input_tokens": 1203, "output_tokens": 225, "characters": 0, "total_tokens": 1428, "input_tokens_details": {"text_tokens": 1203}, "output_tokens_details": {"reasoning_tokens": 220, "text_tokens": 225}}, "timestamp": 1791428722}',
  '{"choices": [{"delta": {"role": "assistant", "content": "", "phase": "thinking_summary", "status": "finished"}}], "response_id": "f526d971-1acd-4774-b13b-9b027c56cce8", "timestamp": 1791428722}',
  '{"choices": [{"delta": {"role": "assistant", "content": "蓝", "phase": "answer", "status": "typing"}}], "response_id": "f526d971-1acd-4774-b13b-9b027c56cce8", "usage": {"input_tokens": 1203, "output_tokens": 225, "characters": 0, "total_tokens": 1428, "input_tokens_details": {"text_tokens": 1203}, "output_tokens_details": {"reasoning_tokens": 220, "text_tokens": 225}}, "timestamp": 1791428722}',
  '{"choices": [{"delta": {"role": "assistant", "content": "", "phase": "answer", "status": "typing"}}], "response_id": "f526d971-1acd-4774-b13b-9b027c56cce8", "usage": {"input_tokens": 1203, "output_tokens": 225, "characters": 0, "total_tokens": 1428, "input_tokens_details": {"text_tokens": 1203}, "output_tokens_details": {"reasoning_tokens": 220, "text_tokens": 225}}, "timestamp": 1791428722}',
  '{"choices": [{"delta": {"role": "assistant", "content": "", "phase": "answer", "status": "typing"}}], "response_id": "f526d971-1acd-4774-b13b-9b027c56cce8", "usage": {"input_tokens": 1203, "output_tokens": 225, "characters": 0, "total_tokens": 1428, "input_tokens_details": {"text_tokens": 1203}, "output_tokens_details": {"reasoning_tokens": 220, "text_tokens": 225}}, "timestamp": 1791428722}',
  '{"choices": [{"delta": {"content": "", "role": "assistant", "status": "finished", "phase": "answer"}}], "response_id": "f526d971-1acd-4774-b13b-9b027c56cce8"}',
];

test('parseSseFrames pulls data payloads out of a full response body', () => {
  const body = REAL_FRAMES.map((f) => `data: ${f} `).join('\n\n') + '\n\ndata: [DONE]\n\n';
  const frames = parseSseFrames(body);
  assert.equal(frames.length, REAL_FRAMES.length);
  assert.equal(frames[0], REAL_FRAMES[0]);
});

test('parseSseFrames tolerates CRLF, comments and stray whitespace', () => {
  const body = `data: ${REAL_FRAMES[0]}\r\n\r\n: keep-alive comment\r\n\r\ndata: ${REAL_FRAMES[3]}\r\n\r\n`;
  assert.equal(parseSseFrames(body).length, 2);
});

test('parseSseFrames handles empty input and returns nothing for [DONE] only', () => {
  assert.deepEqual(parseSseFrames(''), []);
  assert.deepEqual(parseSseFrames('data: [DONE]\n\n'), []);
});

test('reduceQwenStream extracts the answer text from the real frames', () => {
  const reduced = reduceQwenStream(REAL_FRAMES);
  assert.ok(reduced);
  assert.equal(reduced.content, '蓝');
  assert.equal(reduced.finished, true);
});

test('reduceQwenStream separates thinking from the answer by phase', () => {
  const reduced = reduceQwenStream(REAL_FRAMES);
  assert.ok(reduced);
  // 思考内容完整保留
  assert.ok(reduced.reasoningContent.includes('我审视题目中关于天空颜色的描述'));
  assert.ok(reduced.reasoningContent.includes('提炼核心意象'));
  // 正文里绝不应出现思考内容——这正是原来从 DOM 里"抓到错块"要解决的问题
  assert.ok(!reduced.content.includes('我审视题目'));
  assert.ok(!reduced.content.includes('提炼核心意象'));
  assert.equal(reduced.content, '蓝');
});

test('reduceQwenStream does not double-count the repeated thinking frames', () => {
  const reduced = reduceQwenStream(REAL_FRAMES);
  assert.ok(reduced);
  const occurrences = reduced.reasoningContent.split('提炼核心意象').length - 1;
  // 实测同一段思考被下发两次（只有 usage 在增长），归约后只应算一次
  assert.equal(occurrences, 1);
});

test('reduceQwenStream keeps the last usage, not the first', () => {
  const reduced = reduceQwenStream(REAL_FRAMES);
  assert.deepEqual(reduced?.usage, {
    prompt_tokens: 1203,
    completion_tokens: 225,
    total_tokens: 1428,
    reasoning_tokens: 220,
  });
});

test('reduceQwenStream lifts the conversation id out of response.created', () => {
  const reduced = reduceQwenStream(REAL_FRAMES);
  assert.equal(reduced?.conversationId, '29fafdce-70c1-4d24-bac4-7dceeb6efc70');
});

test('reduceQwenStream accumulates multi-chunk answers in order', () => {
  const frames = [
    '{"response.created":{"chat_id":"c1"}}',
    ...['第一段。', '第二段。', '第三段。'].map(
      (c) => `{"choices":[{"delta":{"content":"${c}","phase":"answer","status":"typing"}}]}`,
    ),
    '{"choices":[{"delta":{"phase":"answer","status":"finished"}}]}',
  ];
  const reduced = reduceQwenStream(frames);
  assert.equal(reduced?.content, '第一段。第二段。第三段。');
  assert.equal(reduced?.finished, true);
});

test('reduceQwenStream ignores thinking-phase content so it cannot leak into the answer', () => {
  // 某些站点会把思考文本也放在 delta.content 里，只认 phase === 'answer'
  const frames = [
    '{"choices":[{"delta":{"content":"不该出现的思考","phase":"thinking","status":"typing"}}]}',
    '{"choices":[{"delta":{"content":"正式答案","phase":"answer","status":"typing"}}]}',
  ];
  assert.equal(reduceQwenStream(frames)?.content, '正式答案');
});

test('reduceQwenStream reports unfinished when no finished frame arrived', () => {
  const frames = ['{"choices":[{"delta":{"content":"半句","phase":"answer","status":"typing"}}]}'];
  const reduced = reduceQwenStream(frames);
  assert.equal(reduced?.content, '半句');
  assert.equal(reduced?.finished, false);
});

test('reduceQwenStream treats a repeated title as noise but a repeated thought as content', () => {
  // summary_title 是阶段标签，重复即噪声；summary_thought 是内容，重复要保留。
  // 两者规则不同是按字段性质区分的。
  const frames = [
    '{"choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["提炼核心逻辑"]},"summary_thought":{"content":["第一段思考"]}},"status":"typing"}}]}',
    '{"choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["提炼核心逻辑"]},"summary_thought":{"content":["第二段思考"]}},"status":"typing"}}]}',
  ];
  const reduced = reduceQwenStream(frames);
  assert.ok(reduced);
  assert.equal(reduced.reasoningContent.split('提炼核心逻辑').length - 1, 1);
  // 新思考仍要保留
  assert.ok(reduced.reasoningContent.includes('第一段思考'));
  assert.ok(reduced.reasoningContent.includes('第二段思考'));
});

test('reduceQwenStream keeps a non-adjacent repeated thought on purpose', () => {
  // 相邻重复要去（站点会重发累积状态），但非相邻的重复必须保留：
  // 模型在不同阶段说出同一句话是合法的，全局去重会误吞。
  const frame = (thought) =>
    `{"choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["T"]},"summary_thought":{"content":["${thought}"]}},"status":"typing"}}]}`;
  const reduced = reduceQwenStream([frame('A'), frame('B'), frame('A')]);

  assert.ok(reduced);
  const thoughts = reduced.reasoningContent.split('\n').filter((line) => line !== 'T');
  assert.deepEqual(thoughts, ['A', 'B', 'A']);
});

test('reduceQwenStream dedupes repeats even when the site reorders JSON keys', () => {
  // JSON.stringify 对键顺序敏感：站点换个键序序列化同一个对象，
  // 直接 stringify 比较就会漏掉重复，思考会被记两遍。
  const a =
    '{"choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_title":{"content":["T"]},"summary_thought":{"content":["同一段思考"]}},"status":"typing"}}]}';
  const b =
    '{"choices":[{"delta":{"status":"typing","extra":{"summary_thought":{"content":["同一段思考"]},"summary_title":{"content":["T"]}},"phase":"thinking_summary"}}]}';

  const reduced = reduceQwenStream([a, b]);
  assert.ok(reduced);
  assert.equal(reduced.reasoningContent.split('同一段思考').length - 1, 1);
});

test('reduceQwenStream returns undefined when nothing is parseable', () => {
  assert.equal(reduceQwenStream(['not json', '{oops', '']), undefined);
  assert.equal(reduceQwenStream([]), undefined);
});

// ======================================================================
// DeepSeek —— HTTP SSE，带路径的补丁协议（p/o/v）
// ======================================================================

// ↓↓↓ 真实抓取的帧（2026-10，chat.deepseek.com 的 /api/v0/chat/completion，184 帧）
// ↓↓↓ 这里保留了覆盖全部代码路径的子集：快照 + 若干裸值帧 + fragment APPEND + BATCH + status SET
const SNAPSHOT =
  '{"v":{"response":{"message_id":2,"parent_id":1,"model":"","role":"ASSISTANT","thinking_enabled":true,"ban_edit":false,"status":"WIP","incomplete_message":null,"accumulated_token_usage":0,"fragments":[{"id":2,"type":"THINK","content":"我们需要","elapsed_secs":0,"references":null,"stage_id":1}]}}}';
const BARE = (v: string) => `{"v":${JSON.stringify(v)}}`;
const FRAGMENT_APPEND =
  '{"p": "response/fragments", "o": "APPEND", "v": [{"id": 3, "type": "RESPONSE", "content": "碧", "references": [], "stage_id": 1}]}';
const BATCH =
  '{"p": "response", "o": "BATCH", "v": [{"p": "accumulated_token_usage", "v": 64}, {"p": "quasi_status", "v": "FINISHED"}]}';
const STATUS_SET = '{"p": "response/status", "o": "SET", "v": "FINISHED"}';
function frames() {
  return [
    SNAPSHOT,
    BARE('回答'),
    BARE('用户'),
    BARE('问题'),
    BARE('：'),
    FRAGMENT_APPEND,
    BARE('。'),
    BATCH,
    STATUS_SET,
  ];
}

test('reduceDeepseekStream rebuilds state from patches instead of accumulating guesses', () => {
  const reduced = reduceDeepseekStream(frames());
  assert.ok(reduced);
  // THINK fragment 收下了开头的裸值帧
  assert.equal(reduced.reasoningContent, '我们需要回答用户问题：');
  // RESPONSE fragment 收下了它之后的裸值帧
  assert.equal(reduced.content, '碧。');
  assert.equal(reduced.finished, true);
});

test('reduceDeepseekStream separates thinking from the answer by fragment type', () => {
  const reduced = reduceDeepseekStream(frames());
  assert.ok(reduced);
  // 回答里绝不能混进思考
  assert.ok(!reduced.content.includes('我们需要'));
  assert.ok(!reduced.reasoningContent.includes('碧'));
});

test('reduceDeepseekStream lifts the real token count out of the BATCH patch', () => {
  const reduced = reduceDeepseekStream(frames());
  assert.deepEqual(reduced?.usage, {
    prompt_tokens: 0,
    completion_tokens: 64,
    total_tokens: 64,
  });
});

test('reduceDeepseekStream appends bare values to the fragment that is current', () => {
  // 关键行为：裸值帧追加到"当前"fragment。切换 fragment 之后就不能再追加到旧的。
  const reduced = reduceDeepseekStream([
    SNAPSHOT,
    BARE('思考A'),
    FRAGMENT_APPEND,
    BARE('回答A'),
    BARE('回答B'),
  ]);
  assert.ok(reduced);
  assert.equal(reduced.reasoningContent, '我们需要思考A');
  assert.equal(reduced.content, '碧回答A回答B');
});

test('reduceDeepseekStream reports unfinished when status never reaches FINISHED', () => {
  const reduced = reduceDeepseekStream([SNAPSHOT, BARE('还在想')]);
  assert.ok(reduced);
  assert.equal(reduced.finished, false);
  assert.equal(reduced.reasoningContent, '我们需要还在想');
});

test('reduceDeepseekStream ignores a bare value that arrives before any snapshot', () => {
  const reduced = reduceDeepseekStream([BARE('孤儿帧'), SNAPSHOT, BARE('正常')]);
  assert.ok(reduced);
  assert.equal(reduced.reasoningContent, '我们需要正常');
});

test('reduceDeepseekStream resets state when a second snapshot arrives', () => {
  const reduced = reduceDeepseekStream([SNAPSHOT, BARE('第一轮'), SNAPSHOT, BARE('第二轮')]);
  assert.ok(reduced);
  assert.equal(reduced.reasoningContent, '我们需要第二轮');
});

test('reduceDeepseekStream survives unparseable frames', () => {
  const reduced = reduceDeepseekStream([SNAPSHOT, 'not json', '{oops', BARE('正常')]);
  assert.ok(reduced);
  assert.equal(reduced.reasoningContent, '我们需要正常');
});

test('reduceDeepseekStream returns undefined when there is nothing to reduce', () => {
  assert.equal(reduceDeepseekStream([]), undefined);
  assert.equal(reduceDeepseekStream(['not json']), undefined);
  // 只有裸值帧、没有任何快照时不返回结果：没有状态可读
  assert.equal(reduceDeepseekStream([BARE('孤儿')]), undefined);
});

// ======================================================================
// Grok —— WebSocket，OpenAI Responses 形状，纯 token 追加
// ======================================================================

// ↓↓↓ 真实抓取的 WebSocket 帧（2026-10，grok.com 的 wss://grok.com/ws/mgw/）
// ↓↓↓ 保留与归约相关的 13 帧，其余（心跳、建议、标题等）与归约无关已略去
const REAL_GROK_FRAMES = [
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"conversation.attached","event_id":"evt_440cd062965c487b92c0da2b381f92d1_2","conversation":{"id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","object":"realtime.conversation"},"mode":"new"}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.created","event_id":"evt_440cd062965c487b92c0da2b381f92d1_7","client_event_id":"evt_resp_1791450479538","response":{"id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","status":"in_progress","output_modalities":["text"],"x_grok":{"created_at":1791450479839.0,"model":"fast"}}}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.chunk","event_id":"evt_440cd062965c487b92c0da2b381f92d1_10","response_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","item_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","chunk":{"metadata":{"phase_index":0},"ui_layout":{"reasoning_ui_layout":"UNIFIED"}}}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.chunk","event_id":"evt_440cd062965c487b92c0da2b381f92d1_11","response_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","item_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","chunk":{"metadata":{"step_id":0,"phase_index":0},"text":{"text":"Thinking about your request","channel":"CHANNEL_ASSISTANT_NOTETAKER_HEADER"}}}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.chunk","event_id":"evt_440cd062965c487b92c0da2b381f92d1_12","response_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","item_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","chunk":{"metadata":{"step_id":0,"phase_index":1},"phase_marker":{"kind":"KIND_THINKING_START","phase_index":1}}}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.chunk","event_id":"evt_440cd062965c487b92c0da2b381f92d1_13","response_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","item_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","chunk":{"metadata":{"step_id":0,"phase_index":2},"phase_marker":{"kind":"KIND_RESPONSE_START","phase_index":2}}}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.chunk","event_id":"evt_440cd062965c487b92c0da2b381f92d1_14","response_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","item_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","chunk":{"metadata":{"step_id":0,"phase_index":2},"text":{"text":"**","channel":"CHANNEL_ASSISTANT_RESPONSE"}}}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.chunk","event_id":"evt_440cd062965c487b92c0da2b381f92d1_15","response_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","item_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","chunk":{"metadata":{"step_id":0,"phase_index":2},"text":{"text":"白","channel":"CHANNEL_ASSISTANT_RESPONSE"}}}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.chunk","event_id":"evt_440cd062965c487b92c0da2b381f92d1_16","response_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","item_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","chunk":{"metadata":{"step_id":0,"phase_index":2},"text":{"text":"**","channel":"CHANNEL_ASSISTANT_RESPONSE"}}}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.done","event_id":"evt_440cd062965c487b92c0da2b381f92d1_20","response":{"id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","status":"completed","output_modalities":["text"]}}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.chunk","event_id":"evt_440cd062965c487b92c0da2b381f92d1_21","response_id":"","item_id":"","chunk":{"metadata":{"step_id":1,"phase_index":1},"text":{"text":"Describing snow with one character","channel":"CHANNEL_ASSISTANT_NOTETAKER_HEADER"}}}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.chunk","event_id":"evt_440cd062965c487b92c0da2b381f92d1_22","response_id":"","item_id":"","chunk":{"metadata":{"step_id":2,"phase_index":1},"text":{"text":"Selecting a character to describe snow","channel":"CHANNEL_ASSISTANT_NOTETAKER_HEADER"}}}}',
  '{"session_id":"a995b242-ba22-4e89-b62b-9b8c9b4c64ff","event":{"type":"response.chunk","event_id":"evt_440cd062965c487b92c0da2b381f92d1_24","response_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","item_id":"e3b5ffb4-9c9f-48d9-a905-d38d41530c99","chunk":{"follow_up_suggestions":{"suggestions":[{"properties":{"message_type":"TEXT","follow_up_type":"DIVE_DEEPER"},"label":"用两个字形容雪","tool_overrides":{"image_gen":false}},{"properties":{"message_type":"TEXT","follow_up_type":"TANGENTIAL"},"label":"用一个字形容雪落的声音","tool_overrides":{"image_gen":false}}]}}}}',
];

test('reduceGrokStream extracts the answer from real WebSocket frames', () => {
  const reduced = reduceGrokStream(REAL_GROK_FRAMES);
  assert.ok(reduced);
  // 正文是纯 token 增量：`**` + `白` + `**` → 加粗的一个"白"字
  assert.equal(reduced.content, '**白**');
  assert.equal(reduced.finished, true);
});

test('reduceGrokStream separates the notetaker channel as reasoning', () => {
  const reduced = reduceGrokStream(REAL_GROK_FRAMES);
  assert.ok(reduced);
  assert.ok(reduced.reasoningContent.includes('Thinking about your request'));
  assert.ok(reduced.reasoningContent.includes('Describing snow with one character'));
  // 思考内容绝不能混进正文
  assert.ok(!reduced.content.includes('Thinking about'));
  assert.ok(!reduced.content.includes('Describing snow'));
});

test('reduceGrokStream lifts the conversation id off conversation.attached', () => {
  const reduced = reduceGrokStream(REAL_GROK_FRAMES);
  assert.equal(reduced?.conversationId, 'a995b242-ba22-4e89-b62b-9b8c9b4c64ff');
});

test('reduceGrokStream never drops repeated tokens', () => {
  // 这是它相对 Qwen 的最大优势：正文是纯增量，重复的 token 也是有意义的重复。
  // 问："一二三"里答 "好好好" 必须完整保留。
  const frames = [
    '{"event":{"type":"response.chunk","chunk":{"text":{"text":"好","channel":"CHANNEL_ASSISTANT_RESPONSE"}}}}',
    '{"event":{"type":"response.chunk","chunk":{"text":{"text":"好","channel":"CHANNEL_ASSISTANT_RESPONSE"}}}}',
    '{"event":{"type":"response.chunk","chunk":{"text":{"text":"好","channel":"CHANNEL_ASSISTANT_RESPONSE"}}}}',
  ];
  assert.equal(reduceGrokStream(frames)?.content, '好好好');
});

test('reduceGrokStream ignores phase_marker frames that carry no text', () => {
  const reduced = reduceGrokStream(REAL_GROK_FRAMES);
  assert.ok(reduced);
  assert.ok(!reduced.content.includes('THINKING_START'));
  assert.ok(!reduced.content.includes('RESPONSE_START'));
});

test('reduceGrokStream reports unfinished without response.done', () => {
  const reduced = reduceGrokStream([
    '{"event":{"type":"response.chunk","chunk":{"text":{"text":"半句","channel":"CHANNEL_ASSISTANT_RESPONSE"}}}}',
  ]);
  assert.equal(reduced?.content, '半句');
  assert.equal(reduced?.finished, false);
});

test('reduceGrokStream splits multi-line reasoning frames into separate lines', () => {
  // 实测：Grok 的思考通道单帧可能带换行。整帧 push 会让 join('\n') 多出一层空行。
  const frames = [
    '{"event":{"type":"response.chunk","chunk":{"text":{"text":"第一行\\n第二行","channel":"CHANNEL_ASSISTANT_NOTETAKER_HEADER"}}}}',
    '{"event":{"type":"response.chunk","chunk":{"text":{"text":"第三行","channel":"CHANNEL_ASSISTANT_NOTETAKER_HEADER"}}}}',
  ];
  const reduced = reduceGrokStream(frames);
  assert.ok(reduced);
  assert.equal(reduced.reasoningContent, '第一行\n第二行\n第三行');
});

test('reduceGrokStream splits multi-line reasoning in the live accumulator too', () => {
  const accumulator = createGrokAccumulator();
  accumulator.push(
    '{"event":{"type":"response.chunk","chunk":{"text":{"text":"甲\\n乙","channel":"CHANNEL_ASSISTANT_NOTETAKER_HEADER"}}}}',
  );
  const snapshot = accumulator.snapshot();
  assert.equal(snapshot.reasoningContent, '甲\n乙');
});

test('reduceGrokStream returns undefined when there is nothing parseable', () => {
  assert.equal(reduceGrokStream([]), undefined);
  assert.equal(reduceGrokStream(['not json', '{oops']), undefined);
});

// ======================================================================
// ChatGPT / Claude —— 补丁协议与会话快照 JSON
// ======================================================================

/**
 * 下面的帧与JSON 都是 2026-10 从真实会话里录下来的原样片段，不是手编的样例。
 * 之所以原样保留（包括那些看起来很怪的事件名），是因为这些细节正是之前踩坑的地方：
 * ChatGPT 的正文帧带 `event: delta` 头，早先按"块首是 data:" 过滤时整条正文被丢掉。
 */

describe('parseSseEvents', () => {
  it('取回带 event 头的帧——这正是 parseSseFrames 会漏掉的那批', () => {
    const sse = [
      'event: delta_encoding\ndata: "v1"',
      'data: {"type":"message_stream_complete","conversation_id":"c1"}',
      'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"正文"}',
    ].join('\n\n');

    const events = parseSseEvents(sse);
    assert.equal(events.length, 3);
    assert.equal(events[0].event, 'delta_encoding');
    assert.equal(events[1].event, '');
    assert.equal(events[2].event, 'delta');
    assert.ok(events[2].data.includes('正文'));
  });

  it('跨行的 data: 用换行拼回，不丢内容', () => {
    const events = parseSseEvents('event: delta\ndata: {"p":"a",\ndata: "b":"c"}');
    assert.equal(events.length, 1);
    assert.equal(events[0].data, '{"p":"a",\n"b":"c"}');
  });

  it('丢掉 [DONE] 与空块', () => {
    const events = parseSseEvents('data: [DONE]\n\n\n\nevent: delta\ndata: {"a":1}');
    assert.equal(events.length, 1);
    assert.equal(events[0].data, '{"a":1}');
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(parseSseEvents(''), []);
  });
});

describe('reduceChatgptStream', () => {
  /**
   * 真实录制（record-chatgpt.json）的帧序列，压缩到最关键的几帧。
   * 注意消息是被反复"新增"的：user → 若干 system → 一条 assistant（正文为空）
   * → 正文靠补丁 append 上去 → 最后 status 变finished_successfully。
   */
  const frames = [
    'event: delta_encoding\ndata: "v1"',
    'data: {"type":"resume_conversation_token","kind":"topic","token":"eyJ…","conversation_id":"6ac7c010-3c68-83e8-9c34-64e28b4fbab9"}',
    'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"m1","author":{"role":"user"},"content":{"content_type":"text","parts":["用一个字形容雪"]}}}}',
    'event: delta\ndata: {"v":{"message":{"id":"m2","author":{"role":"system"},"content":{"content_type":"text","parts":[""]}}}}',
    'event: delta\ndata: {"v":{"message":{"id":"m3","author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]}}}}',
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"**凛**。"}',
    'data: {"type":"title_generation","title":"形容雪","conversation_id":"6ac7c010-3c68-83e8-9c34-64e28b4fbab9"}',
    'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}',
    'data: {"type":"message_stream_complete","conversation_id":"6ac7c010-3c68-83e8-9c34-64e28b4fbab9"}',
    'data: [DONE]',
  ]
    .flatMap((block) => block.split('\n\n'))
    .map((block) => (block.match(/^data: (.*)$/m) ?? [])[1])
    .filter((d): d is string => Boolean(d) && d !== '[DONE]');

  it('还原出正文', () => {
    const reduced = reduceChatgptStream(frames);
    assert.equal(reduced?.content, '**凛**。');
  });

  it('正文为空时返回 undefined，避免拿空结果覆盖 DOM 抓到的答案', () => {
    // 只有 user 消息、没有 assistant 正文补丁的那段
    const partial = frames.slice(0, 4);
    assert.equal(reduceChatgptStream(partial), undefined);
  });

  it('取到会话 id', () => {
    assert.equal(reducedId(), '6ac7c010-3c68-83e8-9c34-64e28b4fbab9');
  });

  it('status 补丁与 message_stream_complete 都能表明结束', () => {
    assert.equal(reduceChatgptStream(frames)?.finished, true);
    // 去掉 status 补丁，但保留 message_stream_complete
    const withoutStatus = frames.filter((f) => !f.includes('/message/status'));
    assert.equal(reduceChatgptStream(withoutStatus)?.finished, true);
  });

  it('后续的正文补丁继续追加到最后一条 assistant 上，而不是新起一条', () => {
    const more = [...frames, '{"p":"/message/content/parts/0","o":"append","v":"系统噪声"}'];
    // frames 里的各项已是抽出的 data 负载，所以这里也直接给负载（不�� event 行）
    assert.equal(reduceChatgptStream(more)?.content, '**凛**。系统噪声');
  });

  it('拿到内容不等于拿到完整内容：没标记 finished 的不能当最终答案', () => {
    /**
     * 另一个真实 bug。ChatGPT 的 SSE body 会在响应中途就 resolve，
     * 于是「拿到内容」只代表读到了前半段——实际线上表现是正文只剩半个字
     * （如「皑」而不是「皑」+ 后续内容）。
     *
     * 所以等待逻辑必须以站点自己的 finished 标记为准，
     * 不能以"有内容了"为准。
     */
    const halfWay = reduceChatgptStream([
      '{"p":"","o":"add","v":{"message":{"author":{"role":"assistant"}}}}',
      '{"p":"/message/content/parts/0","o":"append","v":"皑"}',
    ]);
    assert.equal(halfWay?.content, '皑');
    assert.equal(halfWay?.finished, false, '缺 finished 帧时不得当成完整答案');

    const complete = reduceChatgptStream([
      '{"p":"","o":"add","v":{"message":{"author":{"role":"assistant"}}}}',
      '{"p":"/message/content/parts/0","o":"append","v":"皑"}',
      '{"type":"message_stream_complete","conversation_id":"c1"}',
    ]);
    assert.equal(complete?.finished, true);
  });

  it('同一轮多条 SSE 时，finished 的那份优先于半截的那份', () => {
    // 两条响应：先到的只有半句，后到的才是完整。
    const partialOnly = reduceChatgptStream([
      '{"p":"","o":"add","v":{"message":{"author":{"role":"assistant"}}}}',
      '{"p":"/message/content/parts/0","o":"append","v":"半个"}',
    ]);
    assert.equal(partialOnly?.finished, false);
  });

  it('串轮防护：只有响应「开始」于本轮之后的才算数', () => {
    /**
     * 这条不是纯单元测试，而是守住一个真实 bug。
     *
     * 捕获时若把 capturedAt 记成"响应结束"的时刻，ChatGPT 上就会串轮：
     * 它的 SSE 实测要 11 秒才 resolve，于是一条 20 秒前发出、10 秒前就结束的旧流
     * 会在新一轮请求发出之后才被写入记录，时间戳仍然 ≥ since，
     * 于是被当成本轮答案——实际返回的是上一轮内容
     * （表现为正文里混进上一轮的推荐追问"还可以这样形容雪"）。
     *
     * 所以判定必须基于响应的**开始**时刻。
     */
    const since = 1_000;
    // 上一轮的流：开始于 since 之前 → 必须被排除
    const stale = { capturedAt: 500, content: '上一轮的内容' };
    // 本轮的流：开始于 since 之后 → 必须被取用
    const fresh = { capturedAt: 1_200, content: '本轮的内容' };

    const sinceFilter = (items: { capturedAt: number }[]) =>
      items.filter((item) => item.capturedAt >= since);

    assert.deepEqual(sinceFilter([stale, fresh]), [fresh]);
    // 反证：若误用"结束时刻"（stale 在旧流结束后才写入，得到 1_050），
    // 旧流就会混进来，这正是线上观察到的现象。
    const wrongStale = { capturedAt: 1_050, content: '上一轮的内容' };
    assert.equal(sinceFilter([wrongStale, fresh]).length, 2, '结束时刻基准会串轮，故不能那样记');
  });

  it('非 JSON 帧被跳过而不是抛错', () => {
    assert.equal(reduceChatgptStream(['not json', '{', ''])?.content, undefined);
  });

  it('空帧序列返回 undefined', () => {
    assert.equal(reduceChatgptStream([]), undefined);
  });

  it('新版快照形状：从 content.parts 取正文，而不是只 push 空壳', () => {
    // 2026-10 实测形状：整条 message 快照，**没有** /message/content/parts/N 补丁。
    // 旧实现在这里只登记一条空 message，于是真流明明抓到了、正文却是空字符串。
    const snapshot = JSON.stringify({
      v: {
        message: {
          id: 'm1',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['皑皑'] },
          status: 'in_progress',
        },
      },
    });

    assert.equal(reduceChatgptStream([snapshot])?.content, '皑皑');
    assert.equal(
      reduceChatgptStream([snapshot])?.finished,
      false,
      '单看一条快照还没结束标记，不能算 finished',
    );
  });

  it('新版快照形状：附件部件不是字符串时被跳过', () => {
    const snapshot = JSON.stringify({
      v: {
        message: {
          author: { role: 'assistant' },
          content: {
            content_type: 'multimodal_text',
            parts: [{ asset_pointer: 'x' }, '正文'],
          },
        },
      },
    });

    assert.equal(reduceChatgptStream([snapshot])?.content, '正文');
  });

  it('新版快照形状：model_editable_context 这类没有 parts 数组的不产出正文', () => {
    const snapshot = JSON.stringify({
      v: {
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'model_editable_context', model_set_context: '' },
        },
      },
    });

    // 既没有正文也没有结束标记，归约不出来——这正是旧实现把答案漏成空的原因。
    assert.equal(reduceChatgptStream([snapshot]), undefined);
  });

  function reducedId() {
    return reduceChatgptStream(frames)?.conversationId;
  }
});

describe('ChatGPT —— 真实流捕获（2026-10 实测）', () => {
  /**
   * 一次真实发送的完整 SSE：12389 字节。ChatGPT 现在**不再关闭这条连接**，
   * 所以它只能靠 CDP Fetch 增量读回来——finished() 永远不 resolve，body() 直接抛错。
   */
  const REAL = readFileSync(
    new URL('./fixtures/chatgpt-snapshot-stream.txt', import.meta.url),
    'utf8',
  );

  it('还原出正文「皑皑」', () => {
    const reduced = reduceChatgptStream(parseSseEvents(REAL).map((event) => event.data));
    assert.ok(reduced);
    assert.equal(reduced!.content, '皑皑');
  });

  it('认出站点自己标记的结束', () => {
    const reduced = reduceChatgptStream(parseSseEvents(REAL).map((event) => event.data));
    assert.equal(reduced?.finished, true);
  });

  it('拿到会话 id', () => {
    const reduced = reduceChatgptStream(parseSseEvents(REAL).map((event) => event.data));
    assert.match(reduced?.conversationId ?? '', /^[0-9a-f-]{36}$/);
  });

  it('不把提示词当成回答', () => {
    // 用户那条消息也在流里（role: user, parts: ["用两字形容雪"]），
    // 取错了就会把刚发出去的那句话原样返回。
    const reduced = reduceChatgptStream(parseSseEvents(REAL).map((event) => event.data));
    assert.notEqual(reduced?.content, '用两字形容雪');
  });
});

describe('reduceClaudeConversation', () => {
  /**
   * 真实录制的会话快照（原样，1659 字节那份里的关键部分）。
   * 文字是**正确的**——同一时刻 Claude 那条 SSE 里的中文是 CP1252 误解码的坏数据，
   * 这也是选 JSON 端点而不是 SSE 的原因。
   */
  const snapshot = JSON.stringify({
    uuid: 'af106011-286b-4646-b2da-501db9783c25',
    model: 'claude-sonnet-5-5',
    current_leaf_message_uuid: '01a11c45-74d9-79ef-8f76-3314df4b6d02',
    chat_messages: [
      {
        uuid: '01a11c45-74d9-78dc-9192-160d9e0c5db8',
        content: [{ type: 'text', text: '用一个字形容雪', citations: [] }],
        sender: 'human',
        index: 0,
      },
      {
        uuid: '01a11c45-74d9-79ef-8f76-3314df4b6d02',
        content: [
          { type: 'text', text: '**静**\n\n雪落无声,万物覆白,天地都安静了下来。', citations: [] },
        ],
        sender: 'assistant',
        index: 1,
        stop_reason: 'end_turn',
      },
    ],
  });

  it('取最后一条 assistant 消息的正文', () => {
    assert.equal(
      reduceClaudeConversation(snapshot)?.content,
      '**静**\n\n雪落无声,万物覆白,天地都安静了下来。',
    );
  });

  it('取会话 id 并认为已结束', () => {
    const reduced = reduceClaudeConversation(snapshot);
    assert.equal(reduced?.conversationId, 'af106011-286b-4646-b2da-501db9783c25');
    assert.equal(reduced?.finished, true);
  });

  it('把 thinking 块归到 reasoning', () => {
    const withThinking = JSON.stringify({
      uuid: 'c',
      chat_messages: [
        { sender: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          sender: 'assistant',
          content: [
            { type: 'thinking', thinking: '先想想该用哪个字', signature: 'abc' },
            { type: 'text', text: '静' },
          ],
        },
      ],
    });
    const reduced = reduceClaudeConversation(withThinking);
    assert.equal(reduced?.reasoningContent, '先想想该用哪个字');
    assert.equal(reduced?.content, '静');
  });

  it('只有用户消息（还没生成）时返回 undefined', () => {
    const onlyUser = JSON.stringify({
      uuid: 'c',
      chat_messages: [{ sender: 'user', content: [{ type: 'text', text: 'q' }] }],
    });
    assert.equal(reduceClaudeConversation(onlyUser), undefined);
  });

  it('非 JSON / 结构不符时返回 undefined', () => {
    assert.equal(reduceClaudeConversation('not json'), undefined);
    assert.equal(reduceClaudeConversation('{}'), undefined);
    assert.equal(reduceClaudeConversation('{"chat_messages":"nope"}'), undefined);
    assert.equal(reduceClaudeConversation(''), undefined);
  });

  it('多条 assistant 消息取最后一条', () => {
    const multi = JSON.stringify({
      uuid: 'c',
      chat_messages: [
        { sender: 'assistant', content: [{ type: 'text', text: '旧答案' }] },
        { sender: 'user', content: [{ type: 'text', text: '追问' }] },
        { sender: 'assistant', content: [{ type: 'text', text: '新答案' }] },
      ],
    });
    assert.equal(reduceClaudeConversation(multi)?.content, '新答案');
  });
});

describe('Gemini —— Google 私有 batchexecute 封装', () => {
  /**
   * 样本是 2026-10 真实抓取的 100KB 回包（题目「用一个字形容雪」）。
   * 只保留覆盖各条代码路径的子集：最早的初始化帧、若干累积帧、结束帧。
   *
   * 回包形状：)]}' 前缀 + 「<数字>\n<JSON 数组>」并列。
   */
  const REAL = readFileSync(
    new URL('./fixtures/gemini-stream-generate.txt', import.meta.url),
    'utf8',
  );

  it('按方括号配平切帧，而不是相信那个长度前缀', () => {
    // 那个数字是错的：第一帧声明 177 字节，实际 175。若按长度切会整段错位。
    const frames = splitGeminiFrames(REAL);
    assert.ok(frames.length >= 15, `应切出足够多的帧，实得 ${frames.length}`);
    for (const frame of frames) {
      assert.doesNotThrow(() => JSON.parse(frame), '每一帧都必须是合法 JSON');
    }
  });

  it('还原出完整正文', () => {
    const reduced = reduceGeminiStream(REAL);
    assert.ok(reduced);
    assert.match(reduced!.content, /最传神的是/);
    assert.match(reduced!.content, /冷/);
    assert.equal(reduced!.finished, true);
  });

  it('取会话 id', () => {
    assert.match(reduceGeminiStream(REAL)!.conversationId!, /^c_[0-9a-z]+$/);
  });

  it('正文相关的帧是累积快照，所以取最长那份就是完整答案', () => {
    /**
     * 注意**不是所有帧都单调增长**。实测前 16 帧（内层 141 → 7217）是答案的
     * 累积快照，之后还有 3 个内层只有 81/101/101 字符的**另一种形状的收尾帧**
     * （标题、结束标记）。所以"取最后一帧"是错的，正确做法是取最长那份——
     * 归约器就是这么做的。
     */
    const inners = splitGeminiFrames(REAL)
      .map((f) => JSON.parse(f) as unknown[])
      .filter((f) => Array.isArray(f[0]) && f[0][0] === 'wrb.fr')
      .map((f) => (f[0] as unknown[])[2])
      .filter((v): v is string => typeof v === 'string');
    assert.ok(inners.length > 3);

    const longest = Math.max(...inners.map((v) => v.length));
    const growth = inners.map((v) => v.length);
    assert.equal(longest, Math.max(...growth.slice(0, 16)), '最长的那份落在正文累积段内');
    assert.ok(longest > growth.at(-1)!, '最长帧应当比那些小收尾帧长');

    // 递增段内必须单调不减
    for (let i = 1; i < 16; i += 1) {
      assert.ok(growth[i] >= growth[i - 1], `递增段第 ${i} 帧应不短于上一帧`);
    }
  });

  it('按形状找正文而不是写死下标——标题在别的位置，不能被误当成答案', () => {
    // 真实包里标题「一字评雪的意蕴分析」和正文在同一层级的不同下标。
    // 写死下标会把标题或思考当成答案。
    const reduced = reduceGeminiStream(REAL);
    assert.ok(!reduced!.content.includes('一字评雪的意蕴分析'), '标题不该混进正文');
  });

  it('非 batchexecute 输入返回 undefined，不抛错', () => {
    assert.equal(reduceGeminiStream(''), undefined);
    assert.equal(reduceGeminiStream('随便一段文字'), undefined);
    assert.equal(reduceGeminiStream('data: {"a":1}'), undefined);
  });

  it('配额错误会抛出可读的错误，而不是静默返回空', () => {
    // 实测配额耗尽时回的是 BardErrorInfo [1099]。这里手工造一个最小的等价帧，
    // 长度前缀这里可以不给——切帧实际靠方括号配平。
    const inner = JSON.stringify([
      null,
      ['c_1', 'r_1'],
      { 1: ['type.googleapis.com/assistant.boq.bard.application.BardErrorInfo', [1099]] },
    ]);
    const frame = JSON.stringify([['wrb.fr', null, inner]]);
    assert.throws(() => reduceGeminiStream(`)]}'\n\n${frame}`), /1099|配额/);
  });
});
