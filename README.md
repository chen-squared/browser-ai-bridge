# browser-ai-bridge

[![CI](https://github.com/chen-squared/browser-ai-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/chen-squared/browser-ai-bridge/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20+-green.svg)](https://nodejs.org/)

browser-ai-bridge 是一个本地 HTTP 桥接服务，通过 Playwright 复用已登录的浏览器会话，将 ChatGPT、DeepSeek、Claude 等网页版 AI 封装成与 OpenAI API 兼容的本地接口。

> **适用场景**：适合在本机或内网环境中将网页版 AI 接入现有工具链，不依赖官方 API Key。
>
> **不适用场景**：生产环境、高并发、强 SLA 要求，或需要严格遵守官方速率限制与鉴权协议的场景。

---

## 目录

- [工作原理](#工作原理)
- [支持的 Provider](#支持的-provider)
- [快速开始](#快速开始)
- [控制台](#控制台)
- [配置](#配置)
- [API 参考](#api-参考)
- [多轮会话管理](#多轮会话管理)
- [多模型会议](#多模型会议)
- [功能开关：搜索与推理](#功能开关搜索与推理)
- [Selector 维护](#selector-维护)
- [已知限制](#已知限制)
- [开发](#开发)

---

## 工作原理

```
外部程序
  │  POST /v1/chat/completions
  ▼
browser-ai-bridge（本地 HTTP 服务）
  │  Playwright API
  ▼
Chromium（持久化浏览器上下文）
  │  DOM 操作
  ▼
网页版 AI（ChatGPT / DeepSeek / …）
```

1. 服务启动时，使用 Playwright 以持久化 profile 启动 Chromium。
2. 首次使用某个 provider 前，需手动在弹出的浏览器中完成登录。
3. 登录后，服务通过 CSS selector 定位输入框、发送消息、等待回复稳定后提取结果。
4. 结果以 OpenAI 兼容的 JSON 格式返回给调用方。

---

## 支持的 Provider

| Provider  | 状态 | 备注 |
|-----------|------|------|
| DeepSeek  | ✅ 可用 | 支持深度思考（`enableReasoning`）与智能搜索（`enableSearch`）开关 |
| ChatGPT   | ✅ 可用 | 基础发送与回复提取 |
| Gemini    | ✅ 可用 | 基础发送与回复提取 |
| Claude    | ✅ 可用 | 发送前会验证当前页签状态，避免向错误页面发送消息 |
| Grok      | ✅ 可用 | 发送前自动检测页面状态，必要时导航至入口页并创建新会话 |
| Qwen      | ✅ 可用 | `enableReasoning` 映射至"自动 / 思考 / 快速"下拉框；`enableSearch` 暂未适配 |

---

## 快速开始

### 前置要求

- Node.js 20+
- npm

### 安装

```bash
git clone https://github.com/yourusername/browser-ai-bridge.git
cd browser-ai-bridge
npm install
npx playwright install chromium
```

### 启动

```bash
# 复制环境变量模板
cp .env.example .env

# 开发模式（支持热重载）
npm run dev

# 或先编译再运行
npm run build
npm start
```

服务默认监听 `http://127.0.0.1:3010`。

### 登录

1. 打开 `http://127.0.0.1:3010`，从 Provider 下拉框选择目标平台。
2. 点击「打开当前 Provider 页面」，在弹出的 Chromium 窗口中完成登录。
3. 登录完成后，**不要关闭该浏览器窗口**，服务将持续复用此会话。

> **提示**：登录态保存在 `.sessions/chromium` 目录中。服务重启后，只要会话未过期，通常无需重新登录。

### 发送第一条消息

```bash
curl http://127.0.0.1:3010/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "deepseek",
    "model": "deepseek-web",
    "messages": [
      {"role": "user", "content": "用一句话解释 TCP 和 UDP 的区别。"}
    ]
  }'
```

成功响应示例：

```json
{
  "id": "chatcmpl-1234567890",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "deepseek-web",
  "provider": "deepseek",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "TCP 面向连接、可靠传输；UDP 无连接、开销更小。"
      },
      "finish_reason": "stop"
    }
  ]
}
```

---

## 控制台

`http://127.0.0.1:3010` 提供四个标签页。

### 并排对比

勾选多个模型 → 并行提问 → 答案并排显示。每个模型各记各的 `conversationId`，
所以下次接着聊不会串。同一模型内部会自己排队，不会互相踩。

每个模型门牌上标了答案来源：

- **真流** —— 正文来自网页自己收到的协议数据，思考与回答由协议字段区分
- **DOM** —— 正文从页面文本推断，可能受页面排版影响

这个标记来自 `GET /providers` 的 `streamCapture` 字段。五家已接真流，gemini 仍是
DOM 兜底（原因见[真流捕获](#真流捕获哪些-provider-支持)）。

### 多模型会议

两种编排方式：

| 模式 | 模板 id | 行为 |
|---|---|---|
| 顺序对话 | `meeting-round-robin-web` | 席位依次发言，**后一个能看到前面所有发言** |
| 并行作答 | `meeting-parallel-web` | 所有席位同时回答同一问题，**彼此看不见** |

两者都由一个**独立的总结者**收口成一条答复。

#### 席位与顺序

席位顺序即发言顺序，在界面上用 ↑↓ 调整。同一 provider 可以出现多次，
各自占一个独立会话，用序号区分：

```
参与者顺序 [deepseek, chatgpt, deepseek]
→ 席位 deepseek1 → chatgpt1 → deepseek2
```

**席位名同时是会话身份**——它会进 `conversationId`（`<meetingId>:<alias>`），
同名即同一会话。所以命名由服务端统一计算（`POST /meeting/plan`），
前端不自己实现，避免两边算法漂移导致静默复用错会话。

#### 总结时用哪个会话

`summarizerSeat` 控制总结走哪个会话：

- **不传** → 开新会话（`<provider>-summary`），只有本次收集到的发言
- **传某个席位名** → 复用该席位的会话，总结者能接着自己上一轮发言往下说

指定一个不存在的席位名会退回新会话，不会静默复用错的。

---

## 配置

所有配置项通过 `.env` 文件设置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3010` | 服务监听端口 |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `HEADLESS` | `false` | 是否以无头模式启动浏览器（`true` 时不弹出窗口，但无法手动登录） |
| `USER_DATA_DIR` | `.sessions/chromium` | 浏览器 profile 存储目录 |
| `DEFAULT_PROVIDER` | `chatgpt` | 未指定 provider 时使用的默认值 |
| `SELECTOR_OVERRIDES_PATH` | `selectors.overrides.json` | Selector 覆盖文件路径 |
| `BROWSER_CHANNEL` | — | 使用已安装的 Chrome 或 Edge（可选值：`chrome`、`msedge`） |
| `CHROME_EXECUTABLE_PATH` | — | 指定浏览器可执行文件路径（可选） |
| `BRIDGE_DEBUG_PROMPTS` | `false` | 开启后在日志中打印完整提示内容 |

---

## API 参考

### `GET /health`

健康检查。

**响应示例：**
```json
{ "ok": true, "defaultProvider": "chatgpt", "headless": false }
```

---

### `GET /providers`

返回所有已注册 provider 的配置列表（含当前生效的 selector）。

---

### `GET /providers/:provider`

返回指定 provider 的完整配置。

```bash
curl http://127.0.0.1:3010/providers/deepseek
```

---

### `POST /providers/reload`

从磁盘重新加载 `selectors.overrides.json`，**无需重启服务**。

```bash
curl -X POST http://127.0.0.1:3010/providers/reload
```

---

### `GET /v1/models`

返回可用 provider 列表，格式兼容 OpenAI `/v1/models`。

---

### `GET /sessions`

返回当前进程内存中的活跃会话列表。

**响应示例：**
```json
{
  "sessions": [
    {
      "key": "deepseek:my-session",
      "providerId": "deepseek",
      "conversationId": "my-session",
      "url": "https://chat.deepseek.com/a/chat/...",
      "createdAt": 1773643285846,
      "lastUsedAt": 1773643285846,
      "isClosed": false
    }
  ]
}
```

> **注意**：会话仅保存在进程内存中，服务重启后失效。

---

### `POST /meeting/plan`

只计算会议编排计划，**不碰浏览器、不发任何消息**。

存在的理由：席位名（`deepseek1` / `deepseek2`）**同时是会话身份**，让前端自己
算一遍的话，两边算法一旦漂移就会静默复用错会话——那是最难发现的一类 bug。
所以这里让服务端算、前端照抄。

| 字段 | 类型 | 说明 |
|------|------|------|
| `template` | `string` | ✅ 会议模板 id |
| `participants` | `ProviderId[]` | 顺序即发言顺序，最多 6 个 |
| `summarizer` | `ProviderId` | 总结者用哪家 |
| `summarizerSeat` | `string` | 复用哪个席位的会话；不传则开新会话 |
| `rounds` | `number` | 发言轮数 1–4 |

```bash
curl -X POST http://127.0.0.1:3010/meeting/plan \
  -H 'content-type: application/json' \
  -d '{"template":"meeting-round-robin-web","participants":["deepseek","chatgpt","deepseek"],"summarizer":"qwen"}'
```

```json
{
  "mode": "round-robin",
  "rounds": 2,
  "participants": [
    { "alias": "deepseek1", "provider": "deepseek" },
    { "alias": "chatgpt1", "provider": "chatgpt" },
    { "alias": "deepseek2", "provider": "deepseek" }
  ],
  "summarizer": { "alias": "qwen-summary", "provider": "qwen" }
}
```

---

### `POST /session/:provider/open`

打开指定 provider 的登录页，并将浏览器窗口切至前台。

```bash
curl -X POST http://127.0.0.1:3010/session/deepseek/open
```

---

### `POST /session/:provider/clear`

清除指定 `conversationId` 对应的会话映射。

```bash
curl -X POST http://127.0.0.1:3010/session/deepseek/clear \
  -H 'Content-Type: application/json' \
  -d '{"conversationId": "my-session"}'
```

---

### `POST /v1/chat/completions`

核心接口，发送消息并返回回复。

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `messages` | `ChatMessage[]` | ✅ | 消息历史，支持 `system` / `user` / `assistant` 角色 |
| `provider` | `string` | — | 指定 provider（`chatgpt`、`deepseek`、`claude` 等），默认使用 `DEFAULT_PROVIDER` |
| `model` | `string` | — | 模型标识符（当前仅作标记使用，不影响路由逻辑） |
| `conversationId` | `string` | — | 会话标识符，用于复用同一网页会话（详见[多轮会话管理](#多轮会话管理)） |
| `enableSearch` | `boolean` | — | 开启/关闭智能搜索（`true`/`false`），不传则保持网页当前状态 |
| `enableReasoning` | `boolean` | — | 开启/关闭深度思考（`true`/`false`），不传则保持网页当前状态 |
| `promptMode` | `string` | — | 提示模式：`latest-user`（默认）、`trailing-users`、`full-messages` |
| `includeTrailingUserMessages` | `boolean` | — | 将末尾连续多条 user 消息合并后一起发送 |
| `injectSystemOnFirstTurn` | `boolean` | — | 仅在首轮请求时将 system 消息作为文本前缀注入输入框 |
| `dryRun` | `boolean` | — | 仅返回将要发送的提示内容，不实际操作浏览器 |

**关于 `system` 消息的处理：**

默认情况下，`system` 消息**不会**被注入到网页输入框。这是有意为之的设计选择——将 system 消息拼入聊天框只能以普通文本形式注入，既无法等同于模型原生的 system role，也容易造成网页视觉混乱。如需在首轮传递上下文，可使用 `injectSystemOnFirstTurn: true`。

---

## 多轮会话管理

### `conversationId` 的作用

`conversationId` 是服务端用于管理网页页签复用的键，**不传给网页模型**。

| 场景 | `conversationId` | 行为 |
|------|-----------------|------|
| 开新对话 | 不传（留空） | 新建标签页，导航到该provider 的"新建对话"页 |
| 连续多轮对话 | 带上上次响应里返回的 `conversationId` | 复用同一网页页签，由网页自身维护上下文 |

**重要**：不同的 provider 即使传相同的 `conversationId` 也是相互独立的会话（`deepseek:session-1` ≠ `chatgpt:session-1`）。

### 推荐的续聊方式：回传 `conversationId`

发送成功后，服务端会从页面 URL 里抽出该provider 真实的会话 id，并放在响应的
`conversationId` 字段里。**把它带回去发下一次，就等于"继续这条对话"**：

```bash
# 第一次：不传 conversationId，服务端新建标签页与新对话
curl -s http://127.0.0.1:3010/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-web","messages":[{"role":"user","content":"记住这个词：紫貂"}]}'
# → { ..., "conversationId": "b258f46d-0b5a-405e-a177-0d904d6979f7" }

# 第二次：带上它，服务端复用同一个标签页并回到那条对话
curl -s http://127.0.0.1:3010/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-web","conversationId":"b258f46d-0b5a-405e-a177-0d904d6979f7",
       "messages":[{"role":"user","content":"我刚才让你记的词是什么？"}]}'
```

这样"是否连续"由调用方显式决定，而不需要服务端靠启发式去猜。服务端只在**标签页
已经不存在**时才会按记住的 URL 重新导航过去；标签页还在时直接复用，不做任何跳转。

各provider 的会话 URL 形态（已实测）：

| provider | 会话 URL |
|---|---|
| chatgpt | `https://chatgpt.com/c/<uuid>` |
| gemini | `https://gemini.google.com/app/<id>` |
| claude | `https://claude.ai/chat/<uuid>` |
| grok | `https://grok.com/c/<uuid>` |
| qwen | `https://chat.qwen.ai/c/<uuid>` |
| deepseek | `https://chat.deepseek.com/a/chat/s/<uuid>` |

识别规则写在 `src/providers/registry.ts` 的 `conversationUrlPattern`，可以直接改，
也可以放在 `selectors.overrides.json` 里热重载。

### 复用规则：完全由请求里的历史前缀决定

用 `u` 表示用户轮、`a` 表示助手轮。**复用一个标签页的唯一条件是：你这次带回来的
历史，正好是该标签页已有 transcript 的前缀。** 服务端不会替你猜测对话是否延续。

设某标签页当前停在 `u1a1`：

| 本次请求带的历史 | 是否复用 | 原因 |
|---|---|---|
| `u1a1u2` | ✅ 复用 | 是前缀，补发 `u2` |
| `u1a1u2a2u3`（该页停在 `u1a1u2a2`） | ✅ 复用 | 是前缀，补发 `u3` |
| 只有 `u2`（不带历史） | ❌ 不复用 | 没有前缀可比，判定为新话题 |
| `u1a1u3`（该页停在 `u1a1u2`） | ❌ 不复用 | 在第 3 位分叉（`u2` ≠ `u3`） |
| `u1a2u2`（该页停在 `u1a1`） | ❌ 不复用 | 在第 2 位分叉（`a1` ≠ `a2`） |

几个容易踩的点：

- **不带历史 = 每次新开对话。** 如果你的客户端是无状态的（每轮只发最新一句
  user 消息、不回传历史），那它每次都会拿到一条新对话。想续聊就必须把历史带回来。
- **assistant 内容只做空白层面的归一化比较**（CRLF、尾随空格、连续多余空行、
  首尾空白）。服务端存的是网页里模型**实际产出**的文本，和你客户端里那份副本
  常有排版差异；不做归一化的话，一个尾随空格就会被误判成换了话题而丢弃标签页。
  但语义内容必须一致——`a1` 和 `a2` 永远判为不同。
- 想换话题时，除了带上一份不同的历史，也可以直接换一个新的 `conversationId`，
  或 `POST /session/:provider/clear`。

`sessionTranscriptMode` 影响比对方式：`raw`（默认）要求严格前缀一致；
`context-window` 允许上下文窗口滑动，做子序列匹配。用 `dryRun: true` 可以在
`debug.syncMode`（`fresh` / `append` / `rebuild`）、`debug.syncDebug.reason`
（`strict-append` / `context-window-append` / `context-diverged` /
`no-existing-session` / `empty-cache-with-existing-session`）以及
`debug.syncDebug.divergenceIndex`（分叉发生在第几位）里看到判定结果，
不发消息就能预判这次会不会复用。

### 真流捕获（哪些 provider 支持）

内容可以有两个来源：**真流**（直接读网页自己收到的那条协议数据）或 **DOM 抓取**。
真流更准——思考与回答靠协议字段区分、不必猜 DOM 块，还能拿到真实 token 计数。
配了真流的 provider 优先走真路，失败静默退回 DOM 兜底，功能不受影响。

| provider | 传输 | 归约方式 | 真 TTFT |
|---|---|---|---|
| qwen | HTTP SSE | 累加 delta（相邻去重） | ❌ |
| deepseek | HTTP SSE | 补丁状态机 | ❌ |
| **grok** | **WebSocket** | OpenAI Responses 形状 | ✅ |
| **chatgpt** | HTTP SSE | 补丁协议（`event: delta` 成对切帧） | ❌ |
| **claude** | **HTTP JSON** | 会话快照（**不是 SSE**） | ❌ |
| gemini | `batchexecute` RPC | DOM 兜底 | — |

当前状态可用 `GET /providers/<provider>` 查看 `streamCapture` 字段确认。

**首字延迟（TTFT）只有 WebSocket 能拿到。** HTTP 只能在生成结束后一次性取到
完整 body——Playwright 的 `Response` 只有 `body()` / `text()` / `json()`，全是
"全有或全无"，没有任何部分读取的口子（1.64.0 也是如此，升级解决不了）。
WebSocket 帧则是实时事件，所以能边收边推。

因此取 HTTP 真流时**必须等它到**：实测 ChatGPT 的 `response.finished()` 要 11 秒
才resolve，而 DOM"稳定"往往更早判定。不等就会静默退回 DOM——而 ChatGPT 的 DOM 里
混着"思考 / 搜索网页"这类按钮文字，会抓出 `思考\n创建图像或贴纸…` 这种垃圾。
`awaitCapturedStream` 就是为此存在的：拿到内容就返回，最多等 18 秒。

**chatgpt 与 claude 各有一个必须注意的坑：**

- **chatgpt** —— 正文帧带 `event: delta` 头，`data:` **不在块首**。按"块首是
  `data:`"过滤会把正文整个丢掉（实测 21 个事件里只剩 8 帧、含正文 0 帧）。所以必须
  用 `parseSseEvents` 成对切分。
- **claude** —— 它的 SSE 里中文是**坏的**：`静`（UTF-8 `E9 9D 99`）取出来变成
  `é<U+009D>™`，正是 UTF-8 被按 CP1252 逐字节误解码的特征（CP1252 里 `0x99` 是 `™`）。
  而同一时刻的会话 JSON 端点文字完全正确——所以走 JSON，不走 SSE。

**gemini 仍未接入**，原因写在 `src/providers/registry.ts` 的注释里：端点已定位
（`…/BardFrontendService/StreamGenerate`），body 也能取到，但抓到的只有配额耗尽的
错误码 `BardErrorInfo [1099]`，**没有真实答案样本**，归约器无法验证。它是 Google
私有格式，没样本就只能靠猜内部结构写代码——那不如等配额重置。在那之前走 DOM。

### 标签页生命周期

- 每个 provider 最多保留 8 个标签页，闲置超过 2 小时的会被自动关闭回收。
  上限必须容得下**一次会议里同一 provider 的全部席位**（6 席位 + 1 总结者 = 7 个），
  否则并发建页时后建的会把先建的挤掉关闭，表现为"未找到回复节点"或
  "发送按钮未确认提交成功"——看着像站点问题，其实是自己回收了自己的标签页
- 复用前会校验标签页是否还在该 provider 的站点上、且仍处在预期的那个对话里。
  若你手动在那个标签页里切到了别的对话或别的站点，服务端会丢弃它并重建，
  而不是静默把消息写进错误的页面

各 provider 的"新建对话"页配在 `registry.ts` 的 `newChatUrl`；不填则退回 `url`。
**注意**：不少站点的首页会自动恢复上一次对话，只配置 `url` 的话，"第一条新消息"
可能会被追加进一个无关的旧对话——确认过的新对话页请填进 `newChatUrl`。

### 默认消息发送策略

为避免 API 历史与网页自身历史叠加导致上下文重复，默认策略为：

- 仅将最后一条 `user` 消息写入输入框。
- `system` 消息默认不注入。
- `assistant` 历史消息默认不注入。

如需调整，可使用 `includeTrailingUserMessages` 或 `injectSystemOnFirstTurn` 参数。

### 会话的生命周期

- 会话仅在服务进程内存中维护，**重启服务后失效**。
- 如果对应的网页页签被关闭，或页面状态不可用，服务会自动尝试导航回 provider 入口页后重试。
- 可通过 `POST /session/:provider/clear` 手动清除会话映射。

---

## 多模型会议

把 `model` 设成会议模板 id 即进入会议模式，走同一个 `POST /v1/chat/completions`。

| 模板 id | 模式 | 行为 |
|---|---|---|
| `meeting-round-robin-web` | 顺序对话 | 席位依次发言，**后一个能看到前面所有发言** |
| `meeting-parallel-web` | 并行作答 | 所有席位同时回答同一问题，**彼此看不见** |

两种都由一个独立的总结者收口成一条答复。

### 请求体

```json
{
  "model": "meeting-round-robin-web",
  "messages": [{ "role": "user", "content": "比较一下这三种实现" }],
  "meeting": {
    "participants": ["deepseek", "chatgpt", "deepseek"],
    "summarizer": "qwen",
    "summarizerSeat": "deepseek1",
    "rounds": 1
  },
  "stream": true
}
```

| 字段 | 说明 |
|---|---|
| `participants` | 顺序即发言顺序，最多 6 个 |
| `summarizer` | 总结者用哪家 |
| `summarizerSeat` | 复用哪个席位的会话；**不传则开新会话** |
| `rounds` | 发言轮数 1–4 |

### 席位命名

同一 provider 可以出现多次，各自占一个独立会话，用序号区分：

```
participants [deepseek, chatgpt, deepseek]
→ 席位 deepseek1 → chatgpt1 → deepseek2
```

**席位名同时是会话身份**（进 `conversationId`），所以命名统一由服务端计算，
控制台通过 `POST /meeting/plan` 取，不在前端实现。

### 流式事件

`stream: true` 时，会议除了进度事件，最后还会按 OpenAI 形状补发总结答复的
chunk——所以按 `chat/completions` 解析的客户端能用同一条 delta 逻辑读出总结：

| 事件 | 含义 |
|---|---|
| `meeting.started` | 编排计划（席位、顺序、总结者、策略） |
| `meeting.entry` | 某一句发言（`entry.speaker` 是席位名，`entry.stage` 是阶段） |
| `choices[].delta.content` | 总结者的答复正文 |
| `meeting.error` | 出错 |

界面上用 `⌘/Ctrl + Enter` 发送。

---

## 功能开关：搜索与推理

部分 provider 的网页界面提供搜索或推理模式开关，可通过 API 请求中的 `enableSearch` / `enableReasoning` 字段控制：

- `true`：尝试激活对应开关。
- `false`：尝试关闭对应开关。
- 不传：保持网页当前状态（`auto`）。

**各 provider 支持情况：**

| Provider | `enableSearch` | `enableReasoning` |
|----------|---------------|-------------------|
| DeepSeek | ✅ | ✅ |
| Qwen | ⚠️ 暂未适配 | ✅（映射至思考模式下拉框） |
| 其他 | ⚠️ 视网页结构而定 | ⚠️ 视网页结构而定 |

> **说明**：这些开关通过 DOM 操作实现，本质上依赖网页元素结构。若目标网页改版导致控件变化，对应开关可能失效，届时需更新 selector 覆盖配置。

---

## Selector 维护

网页结构变化是使用此类方案不可避免的维护成本。**推荐优先使用覆盖文件**，而非直接修改源码。

### 更新流程

**第一步**：复制覆盖文件模板（如果尚未创建）：

```bash
cp selectors.overrides.example.json selectors.overrides.json
```

**第二步**：查看当前生效的 selector：

```bash
curl http://127.0.0.1:3010/providers/deepseek
```

**第三步**：在浏览器开发者工具中定位新的 CSS selector，更新 `selectors.overrides.json`：

```json
{
  "deepseek": {
    "inputSelectors": [
      "textarea",
      "div[contenteditable=\"true\"][role=\"textbox\"]"
    ],
    "sendButtonSelectors": [
      "button[type=\"submit\"]",
      "button[aria-label*=\"发送\"]"
    ],
    "responseSelectors": [
      ".ds-markdown"
    ],
    "busySelectors": [
      "button[aria-label*=\"停止\"]"
    ]
  }
}
```

**第四步**：热重载（无需重启服务）：

```bash
curl -X POST http://127.0.0.1:3010/providers/reload
```

### Selector 字段说明

| 字段 | 说明 |
|------|------|
| `inputSelectors` | 输入框候选列表，按顺序尝试，取第一个可见的元素 |
| `sendButtonSelectors` | 发送按钮候选列表；若全部不可点击，则退化为按 Enter |
| `responseSelectors` | 回复容器候选列表，应指向完整的 assistant 回复节点 |
| `busySelectors` | 用于判断模型是否仍在生成（如"停止生成"按钮），**必须配准**，否则活跃检测失效 |
| `url` | Provider 入口地址 |
| `readyTimeoutMs` | 等待输入框出现的超时时间（毫秒），默认随全局设置 |
| `submissionSignalTimeoutMs` | **提交确认信号等待时长**（毫秒），默认 `8000`。发送按钮点击后等待"Stop 按钮出现 / 输入框清空 / 新响应出现 / URL 变化"任意一种信号，超时后视为本次点击已失效。**一旦某次点击无异常地触发过，后续方法不会再叠加尝试**，以避免重复发送耗尽 quota |
| `progressIdleTimeoutMs` | **空闲超时**：内容无变化且不处于忙碌状态持续超过此时长则放弃等待（毫秒），默认 `30000`。只要内容仍在更新或 `busySelectors` 命中，此计时器就会持续重置，因此不会因响应过慢而误截断 |
| `maxGenerationTimeoutMs` | **总时长上限**：单次生成不得超过此时长（毫秒），默认 `600000`（10 分钟），防止真正卡死时永久阻塞 |

### 编写稳定 Selector 的建议

优先使用语义化属性，避免使用编译产物类名：

```css
/* ✅ 推荐：语义稳定 */
button[aria-label*="发送"]
textarea
div[contenteditable="true"][role="textbox"]

/* ❌ 避免：编译产物类名，随版本变化 */
.c3f91a._ab12.xYz9
```

优先级建议：`aria-label` / `data-testid` / `role` > `placeholder` / `name` / `type` > `class`。

---

## 已知限制

| 限制 | 说明 |
|------|------|
| 串行处理 | 同一 provider 的请求排队串行执行，不支持并发 |
| 无流式响应 | `/v1/chat/completions` 返回完整结果，暂不支持 SSE 流式输出 |
| System 消息 | 默认不注入网页，无法等同于官方 API 的原生 system role |
| Selector 脆弱性 | 网页结构改版后需手动更新 selector，这是此类方案的固有成本 |
| 登录状态 | 账号过期、人机验证、风控等情况需要手动介入 |
| 会话非持久化 | 会话映射仅保存在内存中，服务重启后失效 |
| Qwen `enableSearch` | 当前未适配到稳定的网页控件 |

---

## 开发

### 目录结构

```
src/
├── server.ts               # HTTP 服务入口（路由、会话同步、SSE）
├── config.ts               # 环境变量配置（Zod 校验）
├── types.ts                # TypeScript 类型定义
├── prompt.ts               # 消息规范化逻辑
├── meeting.ts              # 多 provider 会议编排（席位、顺序、总结）
├── stream-capture.ts       # 真流归约器（每家一套协议，不能互相套用）
├── session-sync.ts         # 复用还是续写：由历史前缀决定，不靠猜
├── conversation-identity.ts # 会话 id 抽取、同站点判定、标签页回收
├── http-access.ts          # Host 白名单（防 DNS rebinding）、可选 token
├── sse-chunks.ts           # 把答复切成 SSE chunk（按码点，不劈代理对）
├── console/
│   └── index.html          # 控制台入口页（构建时拷进 dist）
├── browser/
│   ├── browser-manager.ts  # 浏览器生命周期管理（启动、页面复用）
│   ├── provider-client.ts  # DOM 交互（定位输入框、发送、提取回复）
│   ├── response-text.ts    # 占位残渣过滤与长度门槛
│   └── markdown-restoration.ts  # Markdown token 还原
└── providers/
    └── registry.ts         # 各 provider 的 selector 配置与覆盖逻辑
```

### 常用命令

```bash
npm run dev          # 开发模式（tsx watch 热重载）
npm run build        # TypeScript 编译
npm start            # 运行编译产物
npm test             # 运行单元测试
npm run lint         # ESLint 检查
npm run lint:fix     # ESLint 自动修复
npm run format       # Prettier 格式化
npm run format:check # 检查格式（不修改文件）
```

### 运行测试

```bash
npm test
```

当前测试覆盖：`src/prompt.ts`（消息规范化）和 `src/browser/markdown-restoration.ts`（Markdown token 还原）。

### 贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 远程部署注意事项

当服务运行在远程机器上时，Playwright 启动的浏览器窗口会显示在**服务器的本地桌面**，而非当前终端。

- 控制台页面（`http://<server-ip>:3010`）可以触发服务端打开浏览器、显示当前页面 URL、确认操作结果。
- 无法将服务端的 GUI 浏览器画面嵌入控制台页面。
- 如需查看和操作远程浏览器，需配合 VNC、屏幕共享或其他远程桌面方案。

---

## 访问控制

这个服务能**用你已登录的浏览器发消息**，所以暴露它等于交出账号。反过来说，
即使只监听 `127.0.0.1` 也不能自保——浏览器的同源策略按主机名判断，不按网络位置判断。
恶意网页可以用 DNS rebinding 把域名解析到 `127.0.0.1`，之后它发出的请求在浏览器看来
就是**同源**请求，连 CORS 都拦不住。

因此默认开启三层防护（全部可在 `.env` 调整，见 `.env.example`）：

| 层 | 默认行为 | 环境变量 |
| --- | --- | --- |
| Host 白名单 | 只放行 `localhost` / `127.0.0.1` / `::1`，其余返回 421 | `ALLOWED_HOSTS` |
| CORS | **关闭**（仅同源） | `CORS_ORIGIN` |
| Token | 不校验（纯 opt-in） | `BRIDGE_TOKEN` |

配置 token：

```bash
# .env
BRIDGE_TOKEN=<openssl rand -hex 24 的输出>
```

生效后 `/health` 和控制台页面仍然开放（否则健康检查和首次打开页面会直接不可用），
其余接口都需要携带 token，三种方式任选：

```bash
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://127.0.0.1:3010/v1/chat/completions
curl -H "x-bridge-token: $BRIDGE_TOKEN"      http://127.0.0.1:3010/v1/chat/completions
# 控制台首次打开时用 ?token=xxx，token 会存进 sessionStorage，后续请求自动带上
open "http://127.0.0.1:3010/?token=$BRIDGE_TOKEN"
```

**把服务暴露到 `127.0.0.1` 以外时，`BRIDGE_TOKEN` 必须设置**，
并用 `ALLOWED_HOSTS` 显式列出允许的主机名。

---

## License

[MIT](LICENSE)
