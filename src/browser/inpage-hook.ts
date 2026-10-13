/**
 * 页内流捕获：把站点的回答响应**逐块**从页面里递出来。
 *
 * ## 为什么需要它
 *
 * 另外两条路各有硬伤，都是实测出来的：
 *
 * 1. **CDP `Fetch.takeResponseBodyAsStream` + `IO.read`**：会阻塞到整个响应结束
 *    才一次性吐出全部字节（实测 ChatGPT 首读 +10126ms / 17293 字节一整块），
 *    拿不到首字延迟；而且响应体会被从**页面手里拿走**且不归还，页面永远转圈。
 * 2. **CDP `Network.getResponseBody`**（也就是 `response.body()`）：页面正常，
 *    数据也完整，但没有 TTFT —— body 只有响应结束后才拿得到。
 *
 * 而在页面里 `Response.body` 就是一个由网络栈直连的 `ReadableStream`，
 * `getReader()` 拿到的**是真逐块**的（实测见下表）。
 *
 * ## 三条路对照
 *
 * | 读法 | TTFT | 页面 | 数据 |
 * |---|---|---|---|
 * | CDP takeResponseBodyAsStream | +10126ms，单块 | 饿死 | 完整 |
 * | CDP response.body() | 无 | 正常 | 完整 |
 * | 本文件的页内 hook | +1~4ms | 正常 | 完整 |
 *
 * 六家实测（2026-10-12，`.sessions/hookprobe.mjs`）：
 *
 * | provider | 传输 | 块数 | 首块 | 末块 |
 * |---|---|---|---|---|
 * | claude   | fetch | 43  | +2ms  | +2942ms |
 * | chatgpt  | fetch | 24  | +4ms  | +6419ms（不收尾） |
 * | qwen     | fetch | 40  | +1ms  | +41619ms |
 * | gemini   | xhr   | 13  | ≤100ms | +6118ms |
 * | deepseek | xhr   | 163 | ≤100ms | +16803ms |
 * | grok     | websocket — 本来就拿得到真帧，不需要这里 |
 *
 * ## 三条设计红线
 *
 * 1. **只摘数据，不改行为。** fetch 用 `res.clone()`，页面拿完整副本，
 *    我们从克隆体上读流；XHR 只轮询 `responseText`，不碰它的任何回调。
 *    所以页面该转圈还是转圈（那是它自己的渲染），但**绝不会因为我们而卡住**。
 * 2. **按页装，绝不按 context 装。** 六个 provider 共用一个持久 profile，
 *    按 context 装的话 hook 里抛一个异常，六个站的登录会一起坏。
 * 3. **幂等，且要重装。** Gemini 的启动脚本会把 `XMLHttpRequest.prototype.open`
 *    还原成 native 的（实测：装完之后读回来是 `function open() { [native code] }`），
 *    所以光在文档开头装一次不够，页面就绪后还得再装一遍。
 */

/**
 * 必须**先于** {@link inPageStreamHook} 注入的空实现。
 *
 * esbuild（tsx 默认开 `keepNames`）会给每个具名函数插一句 `__name(fn, "名字")`，
 * 而 Playwright 是把 hook 函数的**源码**原样序列化之后丢进页面执行的——模块级的
 * `__name` 在页面里根本不存在，于是抛 `ReferenceError: __name is not defined`，
 * hook 装到一半就中断，`window.fetch` 和 `XMLHttpRequest.prototype.open`
 * 压根没被 patch。表现是"日志说装上了，却一个请求都拦不到"。
 *
 * 在函数体里声明同名局部变量**没用**：esbuild 会把它改名，而它自己插的调用
 * 仍然指向模块级的那个。所以只能作为独立的 init script 提前注入。
 *
 * 用 `globalThis` 而不是 `var`：Playwright 会把 init script 的内容包进函数里，
 * `var` 会变成函数局部变量，hook 里的调用照样找不到。
 */
export const IN_PAGE_HOOK_SHIM = 'globalThis.__name = globalThis.__name || ((target) => target);';

/** 页内 hook 用的绑定名。Playwright 用 `exposeBinding` 把它挂到 window 上。 */
export const STREAM_PUSH_BINDING = '__bridgeStreamPush';

/**
 * 页内注入的源码。
 *
 * **不能引用模块级变量。** Playwright 是把这个函数的源码序列化之后注入页面的，
 * 闭包里的东西（包括 import 进来的常量）在页面里全是 undefined。所以绑定名和
 * 端点正则都必须走参数传进来。
 *
 * @param options.patterns 目标端点的正则源码数组（来自 provider 配置）。
 * @param options.binding  往 Node 递数据的绑定名。
 */
export function inPageStreamHook(options: { patterns: string[]; binding: string }): void {
  const windowRef = window as unknown as Record<string, unknown>;
  // 重复装会套娃：patchedFetch 会再包一层 patchedFetch，数据就被记两遍。
  if (windowRef['__bridgeHookInstalled']) {
    return;
  }
  windowRef['__bridgeHookInstalled'] = true;

  const patterns = options.patterns.map((source) => new RegExp(source));
  const matches = (url: string): boolean => patterns.some((pattern) => pattern.test(url));

  const push = (payload: string): void => {
    const binding = windowRef[options.binding];
    if (typeof binding !== 'function') {
      return;
    }
    // hook 绝不能把页面的异常带崩。
    try {
      const result = binding(payload);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      /* 忽略 */
    }
  };

  // ---- fetch ----------------------------------------------------------
  const nativeFetch = window.fetch.bind(window);

  const patchFetch = (): void => {
    const current = window.fetch;
    if (current && String(current).includes('bridgePatchedFetch')) {
      return;
    }
    const bridgePatchedFetch = function bridgePatchedFetch(
      ...args: Parameters<typeof nativeFetch>
    ): Promise<Response> {
      const url = String(args[0] instanceof Request ? args[0].url : (args[0] ?? ''));
      if (!matches(url)) {
        return nativeFetch(...args);
      }
      return nativeFetch(...args).then((response) => {
        if (!response.body) {
          return response;
        }
        // clone() 才是关键：页面继续消费它原本那份响应，我们旁观克隆体。
        // 不 clone 就等于把 body 从页面手里抢走——那正是 CDP 那条路的毛病。
        const reader = response.clone().body!.getReader();
        // 用流式 TextDecoder 而不是逐块 toString('utf8')：一个中文字符可能被拆到
        // 两块里，逐块解码会把它变成乱码（UTF-8 续字节单独解码就是垃圾）。
        const decoder = new TextDecoder('utf-8');
        const token = String(Date.now()) + '-' + String(Math.random()).slice(2, 8);
        push(JSON.stringify({ url, kind: 'open', at: Date.now(), token }));
        void (async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              // eof 时流式解码器可能还扣着最后几个字节没吐（不完整的字符）。
              push(
                JSON.stringify({
                  url,
                  kind: 'close',
                  at: Date.now(),
                  token,
                  tail: decoder.decode(),
                }),
              );
              return;
            }
            push(
              JSON.stringify({
                url,
                kind: 'data',
                at: Date.now(),
                token,
                text: decoder.decode(value, { stream: true }),
              }),
            );
          }
        })().catch(() => {
          push(JSON.stringify({ url, kind: 'error', at: Date.now() }));
        });
        return response;
      });
    };
    window.fetch = bridgePatchedFetch;
  };

  // ---- XHR ------------------------------------------------------------
  // 实测 gemini 的 responseType 是 ''、deepseek 是 'text'，两种都能在
  // LOADING 期间读 responseText。真要是 arraybuffer 就只能等 DONE，
  // 那时已经没有增量可言了——那种情况推一条 skip 让上层知道。
  const nativeOpen = XMLHttpRequest.prototype.open;
  const XHR_PATCH_MARK = 'bridgePatchedOpen';

  const patchXhr = (): void => {
    const current = XMLHttpRequest.prototype.open;
    if (current && String(current).includes(XHR_PATCH_MARK)) {
      return;
    }
    // 每次都重新包一层 native：站点如果在我们之后又包了别的，恢复时应当回到
    // "站点那层"，而不是回到我们这层，免得两层互相套。
    const base = current ?? nativeOpen;
    const bridgePatchedOpen = function bridgePatchedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      asyncFlag?: boolean,
      user?: string | null,
      password?: string | null,
    ): void {
      base.call(this, method, url, asyncFlag ?? true, user ?? null, password ?? null);
      const absolute = String(url);
      if (!matches(absolute)) {
        return;
      }

      // 每个 XHR 领一个 token。**必须有**：同一个端点会被并发开多条（Gemini 实测
      // 首条中途失败后紧接着又开一条），每条都有自己的轮询器。没有 token 的话，
      // 老那条的轮询器会把数据继续推进来，和新那条的增量混在一起——
      // 归约出来的正文里会凭空多出一截（实测"…空气分子（瑞。 秋天空气干燥洁净…"）。
      const token = String(Date.now()) + '-' + String(Math.random()).slice(2, 8);
      let seen = '';
      push(JSON.stringify({ url: absolute, kind: 'open', at: Date.now(), token }));

      const timer = window.setInterval(() => {
        const readyState = this.readyState;
        if (readyState < 3) {
          if (readyState === 4) {
            window.clearInterval(timer);
            push(JSON.stringify({ url: absolute, kind: 'close', at: Date.now(), token }));
          }
          return;
        }

        let text: string;
        try {
          text = this.responseText || '';
        } catch {
          push(JSON.stringify({ url: absolute, kind: 'skip', at: Date.now(), token }));
          window.clearInterval(timer);
          return;
        }

        // 推**整份** responseText，标 full:true，让 Node 侧整体替换而不是追加。
        //
        // 曾经试过只推增量（text.slice(seen.length)），但那条路不可靠：
        // 归约出来的正文里会凭空多出一截（实测 Gemini 开头多一个「秋」、
        // DeepSeek 把整段重复了一遍）。XHR 的 responseText 在并发请求、
        // 浏览器缓冲这些情况下并不严格只增不减，按长度切迟早切错位置。
        // 整份替换没有这个问题——多传一点，换来绝对正确。
        if (text.length !== seen.length || text !== seen) {
          push(
            JSON.stringify({
              url: absolute,
              kind: 'data',
              at: Date.now(),
              token,
              full: true,
              text,
            }),
          );
          seen = text;
        }

        if (readyState === 4) {
          window.clearInterval(timer);
          push(JSON.stringify({ url: absolute, kind: 'close', at: Date.now(), token }));
        }
      }, 100);
    };
    XMLHttpRequest.prototype.open = bridgePatchedOpen;
  };

  const install = (): void => {
    patchFetch();
    patchXhr();
  };
  install();

  // 站点的启动脚本可能把原生函数装回去（Gemini 实测会把 XHR 的 open 还原），
  // 所以文档就绪后再补几次。幂等，已经是我们自己的就不动。
  if (typeof document === 'object') {
    document.addEventListener('DOMContentLoaded', install);
    window.addEventListener('load', install);
  }
  window.setTimeout(install, 250);
  window.setTimeout(install, 1500);
}
