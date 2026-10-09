import crypto from 'node:crypto';

/**
 * HTTP 访问控制：Host 白名单（防 DNS rebinding）与可选的 Bearer token。
 *
 * 为什么循环端口的服务也需要这些——单靠"只监听127.0.0.1"是不够的：
 *
 * 1. 浏览器的同源策略按"主机名"判断，不按"网络位置"判断。恶意网页可以用
 *    DNS rebinding 把 attacker.com 解析到 127.0.0.1，之后它发出的请求
 *    带的是 `Host: attacker.com`。Express 照单全收，而浏览器认为这是
 *    **同源**请求，所以连CORS 都拦不住它。这是本地 API 最经典的一类攻击，
 *    校验 Host 是唯一可靠的防线。
 *
 * 2. 浏览器里的 JS 可以直接 fetch http://127.0.0.1:3010。只要响应里带
 *    `Access-Control-Allow-Origin: *`，对方就能读走结果，甚至用你的登录态
 *    驱动浏览器发消息。所以 CORS 不能默认全开。
 *
 * 本模块只做判定，不碰 express，方便单测。
 */

/** 循环端口常见的合法 Host，以及服务自身监听的地址，都默认放行。 */
export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

/**
 * 从 Host 头里取出主机名（去掉端口）。
 *
 * 需要单独处理 IPv6：Host 形如 `[::1]:3010`，里面的冒号是地址的一部分，
 * 不能按"最后一个冒号"直接切。
 */
export function normalizeHostname(hostHeader: string | undefined | null): string {
  if (!hostHeader) {
    return '';
  }

  const value = hostHeader.trim().toLowerCase();
  if (!value) {
    return '';
  }

  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    return closingBracket === -1 ? value : value.slice(0, closingBracket + 1);
  }

  const lastColon = value.lastIndexOf(':');
  return lastColon === -1 ? value : value.slice(0, lastColon);
}

/** `::1` 与 `[::1]` 视为同一个主机，避免配置时漏写方括号。 */
function canonicalize(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname.replace(/^\[|\]$/g, '');
}

export function buildAllowedHosts(
  configured: string | undefined,
  listeningHost: string,
): Set<string> {
  const hosts = new Set<string>();

  for (const host of DEFAULT_ALLOWED_HOSTS) {
    hosts.add(canonicalize(host));
  }

  // 监听地址本身也要放行，否则显式配置 HOST=127.0.0.1 之类的用法会被自己拦掉。
  if (listeningHost && listeningHost !== '0.0.0.0' && listeningHost !== '::') {
    hosts.add(canonicalize(normalizeHostname(listeningHost)));
  }

  for (const extra of (configured ?? '').split(',')) {
    const normalized = canonicalize(normalizeHostname(extra));
    if (normalized) {
      hosts.add(normalized);
    }
  }

  return hosts;
}

export function isAllowedHost(
  hostHeader: string | undefined | null,
  allowedHosts: ReadonlySet<string>,
): boolean {
  const hostname = canonicalize(normalizeHostname(hostHeader));
  if (!hostname) {
    return false;
  }

  return allowedHosts.has(hostname);
}

/**
 * 常数时间比较 token。
 *
 * 未配置 expected 时一律放行——这样"加token"是纯 opt-in 的改动，
 * 不配置的人行为完全不变。
 */
export function isTokenValid(
  providedToken: string | undefined | null,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) {
    return true;
  }

  if (!providedToken) {
    return false;
  }

  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);

  if (provided.length !== expected.length) {
    // 长度不同也走一次比较，避免通过响应耗时区分"长度不对"和"内容不对"。
    crypto.timingSafeEqual(provided, provided);
    return false;
  }

  return crypto.timingSafeEqual(provided, expected);
}

/**
 * 从请求里取 token：优先 Authorization: Bearer，其次 x-bridge-token 头，
 * 最后是 token 查询参数（给控制台首次打开时用 `?token=xxx` 传进来）。
 */
export function extractToken(
  authorizationHeader: string | undefined,
  bridgeTokenHeader: string | undefined,
  queryToken: unknown,
): string | undefined {
  if (typeof authorizationHeader === 'string') {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
    if (bearer?.[1]) {
      return bearer[1].trim();
    }
  }

  if (typeof bridgeTokenHeader === 'string' && bridgeTokenHeader.trim()) {
    return bridgeTokenHeader.trim();
  }

  if (typeof queryToken === 'string' && queryToken.trim()) {
    return queryToken.trim();
  }

  return undefined;
}
