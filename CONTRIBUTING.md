# Contributing to browser-ai-bridge

感谢你对 browser-ai-bridge 的关注！欢迎提交 Bug 报告、Selector 修复、功能建议和代码贡献。

## 开发环境准备

```bash
# 克隆仓库
git clone https://github.com/yourusername/browser-ai-bridge.git
cd browser-ai-bridge

# 安装依赖
npm install

# 安装 Playwright 浏览器
npx playwright install chromium

# 复制并编辑环境变量
cp .env.example .env

# 启动开发服务器
npm run dev
```

## 运行测试

```bash
# 运行所有单元测试
npm test

# 运行构建（TypeScript 编译）
npm run build
```

## 代码风格

项目使用 [ESLint](https://eslint.org/) + [Prettier](https://prettier.io/) 保证代码质量与格式一致性。

```bash
# 检查 Lint 问题
npm run lint

# 自动修复可修复的 Lint 问题
npm run lint:fix

# 格式化代码
npm run format

# 检查格式（不修改文件）
npm run format:check
```

所有 PR 在合并前都需要通过 CI 检查（见 `.github/workflows/ci.yml`）。

## 更新 CSS Selector

各 AI 网站会定期更新页面结构，导致 Selector 失效。修复流程：

1. 在 `src/providers/registry.ts` 中找到对应 Provider 的配置
2. 使用浏览器开发者工具定位新的 CSS Selector
3. 更新 `inputSelectors`、`sendButtonSelectors`、`responseSelectors` 等字段
4. 也可使用 `selectors.overrides.json` 在不修改源码的情况下临时覆盖（参考 `selectors.overrides.example.json`）
5. 提交 PR 时请简要说明是哪个 Provider、哪个 Selector 发生了变化

## 添加新的 AI Provider

1. 在 `src/types.ts` 的 `ProviderId` 联合类型中添加新的 ID
2. 在 `src/providers/registry.ts` 中添加完整的 `ProviderConfig`（URL、Selector、Toggle 等）
3. 在 `tests/` 中为 Provider 相关逻辑添加单元测试
4. 更新 `README.md` 的 Provider 状态表

## 提交 Bug 报告

请在 [Issues](https://github.com/chen-squared/browser-ai-bridge/issues) 中提交，并包含：

- Node.js 版本及操作系统
- 受影响的 Provider 及浏览器版本
- 完整的错误信息（含 stack trace）
- 复现步骤（最小化示例）
- 期望行为与实际行为的描述

## 提交 PR

1. Fork 仓库并在新分支上开发：`git checkout -b fix/chatgpt-selector`
2. 针对 Bug 修复或新功能编写相应的单元测试
3. 确保 `npm test`、`npm run lint`、`npm run build` 全部通过
4. 提交信息使用中文或英文均可，保持简洁明确
5. 发起 Pull Request，描述变更目的和影响
