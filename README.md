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
- [配置](#配置)
- [API 参考](#api-参考)
- [多轮会话管理](#多轮会话管理)
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
| 单轮问答 / 调试 | 不传（留空） | 每次请求使用独立页面，不继承历史 |
| 连续多轮对话 | 传固定值（如 `session-1`） | 复用同一网页页签，由网页自身维护上下文 |

**重要**：不同的 provider 即使传相同的 `conversationId` 也是相互独立的会话（`deepseek:session-1` ≠ `chatgpt:session-1`）。

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
├── meeting.ts              # 多 provider 会议编排
├── browser/
│   ├── browser-manager.ts  # 浏览器生命周期管理（启动、页面复用）
│   ├── provider-client.ts  # DOM 交互（定位输入框、发送、提取回复）
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

## License

[MIT](LICENSE)
