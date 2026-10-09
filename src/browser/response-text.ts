/**
 * 回复文本的"是否算有效回答"判定。
 *
 * 单独抽成纯函数是为了能脱离 Playwright 单测——这些规则是踩坑踩出来的，
 * 每一条都应该有对应的测试用例，否则下次改 DOM 逻辑时没人敢动。
 */

/**
 * 主路径的最小实义长度门槛。
 *
 * 生成过程中回复会从短变长，低于这个长度更可能是没渲染完的碎片或占位符，
 * 而不是一句真正完整的回答。
 */
export const MIN_RESPONSE_TEXT_LENGTH = 8;

/**
 * 兜底路径的最小长度门槛：任何非空文本都算。
 *
 * 存在的理由：模型完全可能只回很短的内容（例如 `[]`、`收到`、`3`）。
 * 只用 MIN_RESPONSE_TEXT_LENGTH 一道门槛时，这些合法短答案会被整段丢掉，
 * 最终报"未提取到有效回复文本"，而实际上是提取成功了。
 */
export const MIN_FALLBACK_RESPONSE_TEXT_LENGTH = 1;

/** 把 DOM innerText 归一化成用于长度判定的形态：折叠空白后去首尾空格。 */
export function normalizeResponseTextLengthText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function hasResponseTextLength(text: string, minimum: number): boolean {
  return normalizeResponseTextLengthText(text).length >= minimum;
}

// 空标签的 Markdown 链接 / 图片，例如 `[](/)`、`[](https://x)`、`![]()`。
// 这类链接渲染出来不产生任何可见文字，通常是页面结构抓串的产物。
const EMPTY_LABEL_MARKDOWN_LINK = /!?\[\s*\]\([^)]*\)/;
// 空目标的 Markdown 链接，例如 `[文字]()`。
const EMPTY_TARGET_MARKDOWN_LINK = /!?\[[^\]]*\]\(\s*\)/;
// 任何 Unicode 字母（涵盖中英文、日文等）或数字都算实义内容
const MEANINGFUL_CHARACTER = /[\p{L}\p{N}]/u;
// 上面两种畸形结构的合并匹配，用于从文本里剥掉它们
const STRIPPABLE_MARKDOWN_LINK = new RegExp(
  `${EMPTY_LABEL_MARKDOWN_LINK.source}|${EMPTY_TARGET_MARKDOWN_LINK.source}`,
  'g',
);

/**
 * 判断一段文本是否是"页面结构残渣"而不是真正的回答。
 *
 * 背景：兜底提取（innerText）在页面没有渲染出对话区时会退化成乱抓，
 * 比如模态框挡住时从侧边栏抓到一个 Markdown 链接残渣 `[](/)`。
 * 这种东西如果当成回答返回，调用方拿到的是 HTTP 200 + finish_reason=stop
 * 的**静默错误数据**——结构完全合法，内容完全错误，下游无从察觉。
 *
 * 规则刻意保守，只有"含空目标 Markdown 链接"且"剥离该链接后不剩任何
 * 字母或数字"时才判废。因此下面这些合法短答案都不会被误杀：
 *
 * - `[]` / `{}` / `null` —— 不含 `](`，直接放行（用户问"列表里筛出某些项，
 *   结果为空"时模型确实可能回 `[]`）
 * - `-` / `*` / `...` —— 同上
 * - `收到。` / `OK` / `3 个` —— 同上
 *
 * 而 `[](/)\n\n-` 这种会被剥离成空串，判废。
 */
export function isPlaceholderArtifactText(text: string): boolean {
  const raw = text.trim();

  if (!raw) {
    return true;
  }

  // 没有畸形链接就直接放行——这是保证短答案不被误杀的关键。
  if (!EMPTY_LABEL_MARKDOWN_LINK.test(raw) && !EMPTY_TARGET_MARKDOWN_LINK.test(raw)) {
    return false;
  }

  const withoutBrokenLinks = raw.replace(STRIPPABLE_MARKDOWN_LINK, '');

  return !MEANINGFUL_CHARACTER.test(withoutBrokenLinks);
}
