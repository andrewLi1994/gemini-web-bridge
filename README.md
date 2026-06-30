# Codex Gemini Web Bridge

[![CI](https://github.com/andrewLi1994/codex-gemini-web-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/andrewLi1994/codex-gemini-web-bridge/actions/workflows/ci.yml)

> Experimental, unofficial, macOS-only Codex plugin. This project is not affiliated with or endorsed by Google or OpenAI.

Gemini Web Bridge gives Codex a local, user-controlled channel to a logged-in Gemini Web session without requiring a Gemini API key. Codex controls prompting, quality judgment, follow-up, fresh conversations, and cross-checking. The Bridge only handles reliable browser automation and returns Gemini's complete raw answer.

Typical uses include understanding the audio and visuals of one or more public YouTube videos, asking a scoped question about public URLs, or obtaining an independent auxiliary analysis when it materially helps Codex.

## Requirements

- macOS
- Codex with plugin marketplace support
- Node.js 22 or newer
- Google Chrome, Microsoft Edge, Brave, or Chromium
- A Google account that can use Gemini Web

## Install or upgrade

```sh
codex plugin marketplace add andrewLi1994/codex-gemini-web-bridge --ref main
codex plugin add gemini-web-bridge@codex-gemini-web-bridge
```

For an existing installation:

```sh
codex plugin marketplace upgrade codex-gemini-web-bridge
```

Start a new Codex thread after installation or upgrade. Ask for the outcome normally, for example:

```text
Compare the claims in these two public YouTube videos and check where their evidence differs: <URL1> <URL2>
```

Codex decides whether to use one Gemini conversation, several fresh conversations, follow-up prompts, or no Gemini call at all. A local random conversation handle is returned after each successful fresh call; videos and Codex threads do not automatically select or reuse conversations.

## First use

1. Codex asks once for permission to send only minimum necessary public URLs, scoped questions, language, and output requirements to Gemini Web.
2. If sign-in is required, the plugin opens a visible Chrome window with a dedicated profile.
3. Sign in manually and close the entire dedicated Chrome window. The plugin verifies login and Codex continues the pending request automatically.

Normal requests run in a headless background browser. The task page and browser close after success, failure, or cancellation.

## Privacy and security

- The full Codex conversation, local files, credentials, secrets, and private data must not be sent automatically.
- Google login cookies remain in the dedicated local Chrome profile.
- Local state stores only consent plus conversation handles, Gemini URLs, thread labels, and timestamps. It does not copy prompts or answers.
- Runtime data is stored under `~/Library/Application Support/Codex UI Extensions/Gemini Web Bridge/` and is excluded from Git.
- Chrome debugging uses a random port bound only to `127.0.0.1`.
- Browser and state operations use cross-process locks, restricted permissions, atomic writes, and stale-lock recovery.
- The plugin does not fill Google login forms, bypass CAPTCHA challenges, or bypass account limits.
- Gemini responses are untrusted external material. Codex—not the automation—must assess their quality and claims.

## Reliability boundary

The Bridge reports mechanical states such as login required, CAPTCHA, rate limit, browser disconnect, incomplete generation, unknown submitted outcome, or changed page structure. It never decides that a Gemini answer is semantically good or bad.

Only failures known to occur before submission can be retried automatically once. After the send action is confirmed, the Bridge never blindly resubmits; Codex decides whether to follow up or create a fresh conversation.

Gemini Web is not a stable API. A page redesign can temporarily break automation until selectors are updated, and Gemini's available capabilities can vary by account or request.

## v0.2 compatibility

The old `analyze_youtube` MCP tool remains available but is deprecated. Existing video-to-conversation mappings are migrated once into random conversation handles while the old `sessions.json` is retained as a backup. New work uses `gemini_web_ask`. The deprecated tool is scheduled for removal in v0.3.

## Diagnostic CLI

The CLI mirrors the MCP primitives for development and recovery; it is not the normal user interface.

```sh
node plugins/gemini-web-bridge/dist/gemini-web-cli.mjs status
node plugins/gemini-web-bridge/dist/gemini-web-cli.mjs authorize --confirmed
node plugins/gemini-web-bridge/dist/gemini-web-cli.mjs login --wait
printf '%s' '{"prompt":"Ask a minimal scoped question"}' | node plugins/gemini-web-bridge/dist/gemini-web-cli.mjs ask
node plugins/gemini-web-bridge/dist/gemini-web-cli.mjs conversations
```

CLI results are JSON on stdout; progress events are JSON lines on stderr. Exit code `2` means human login/verification is required, `3` means rate limited, `4` means an automation failure, and `5` means invalid input or a missing conversation.

## Uninstall

```sh
codex plugin remove gemini-web-bridge@codex-gemini-web-bridge
codex plugin marketplace remove codex-gemini-web-bridge
```

Uninstalling does not delete the dedicated Chrome profile. Remove the runtime directory manually only if you also want to sign out and delete local conversation metadata.

## Development

```sh
npm ci --prefix plugins/gemini-web-bridge
npm run verify
```

The MCP server and diagnostic CLI are committed as generated single-file bundles, so marketplace users do not install npm dependencies. After source or dependency changes, run `npm run build` and commit the updated `dist/` files.

Licensed under the [MIT License](LICENSE). Report security issues through [private vulnerability reporting](SECURITY.md).

---

## 中文说明

> 这是一个实验性、非官方、目前仅支持 macOS 的 Codex 插件。本项目与 Google 或 OpenAI 没有关联，也未获得其官方背书。

Gemini Web Bridge 为 Codex 提供一个连接用户已登录 Gemini Web 的本地通道，不需要 Gemini API Key。Codex负责提示词、回答质检、追问、新建对话和交叉验证；Bridge 只负责可靠操作浏览器并返回 Gemini 的完整原始回答。

典型用途包括理解一个或多个公开 YouTube 视频的音频和画面、针对公共 URL 提出最小范围的问题，或者在确有帮助时获得一份独立的辅助分析。

### 环境要求

- macOS
- 支持插件 Marketplace 的 Codex
- Node.js 22 或更高版本
- Google Chrome、Microsoft Edge、Brave 或 Chromium
- 可以正常使用 Gemini Web 的 Google 账号

### 安装或升级

```sh
codex plugin marketplace add andrewLi1994/codex-gemini-web-bridge --ref main
codex plugin add gemini-web-bridge@codex-gemini-web-bridge
```

已经安装时运行：

```sh
codex plugin marketplace upgrade codex-gemini-web-bridge
```

安装或升级后新建 Codex 对话。用户只需要描述目标，例如：

```text
比较这两个公开 YouTube 视频的观点，并检查它们的证据有什么不同：<URL1> <URL2>
```

Codex自行决定使用一个 Gemini 对话、多个全新对话、继续追问，或者完全不调用 Gemini。每次成功新建对话后都会返回一个本地随机句柄；视频和 Codex 线程不会自动选择或复用对话。

### 首次使用

1. Codex 只请求一次授权，允许发送最少必要的公共 URL、具体问题、语言和输出要求。
2. 如果需要登录，插件使用专用 Profile 打开可见 Chrome 窗口。
3. 用户手动登录并关闭整个专用窗口。插件验证登录后，Codex 自动继续刚才的请求。

正常请求在无界面后台浏览器中运行。成功、失败或取消后都会关闭任务页面和浏览器。

### 隐私与安全

- 不得自动发送完整 Codex 对话、本地文件、凭据、密钥或私有数据。
- Google 登录 Cookie 只保存在专用本地 Chrome Profile 中。
- 本地只保存授权状态、随机对话句柄、Gemini URL、线程标签和时间，不复制问题或回答。
- 运行数据位于 `~/Library/Application Support/Codex UI Extensions/Gemini Web Bridge/`，并被 Git 排除。
- Chrome 调试使用随机端口，并只监听 `127.0.0.1`。
- 浏览器和状态操作使用跨进程锁、受限文件权限、原子写入和过期锁恢复。
- 插件不会自动填写 Google 登录表单，不会绕过验证码或账号限额。
- Gemini 回答是不可信外部材料，其质量和事实判断由 Codex负责，而不是自动化脚本。

### 稳定性边界

Bridge 只报告机械状态，例如需要登录、验证码、额度限制、浏览器断连、生成未完成、提交结果未知或网页结构变化。它不会判断 Gemini 回答在语义上是否合格。

只有明确发生在提交前的失败才允许自动重试一次。确认点击发送后，Bridge 不会盲目重复提交；Codex决定继续追问还是新建对话。

Gemini Web 不是稳定 API。页面改版可能暂时破坏自动化，Gemini 能力也可能因账号或请求而变化。

### v0.2 兼容性

旧 `analyze_youtube` MCP 工具仍然存在，但已经弃用。旧“视频到 Gemini 对话”映射会自动迁移为随机对话句柄，同时保留原 `sessions.json` 作为备份。新任务使用 `gemini_web_ask`。旧工具计划在 v0.3 删除。

### 诊断 CLI

CLI 只用于开发和故障恢复，不是普通用户入口：

```sh
node plugins/gemini-web-bridge/dist/gemini-web-cli.mjs status
node plugins/gemini-web-bridge/dist/gemini-web-cli.mjs authorize --confirmed
node plugins/gemini-web-bridge/dist/gemini-web-cli.mjs login --wait
printf '%s' '{"prompt":"提出一个最小范围的问题"}' | node plugins/gemini-web-bridge/dist/gemini-web-cli.mjs ask
node plugins/gemini-web-bridge/dist/gemini-web-cli.mjs conversations
```

CLI 最终结果使用 stdout JSON，进度使用 stderr JSON Lines。退出码 `2` 表示需要人工登录或验证，`3` 表示额度限制，`4` 表示自动化失败，`5` 表示输入无效或对话不存在。

### 卸载

```sh
codex plugin remove gemini-web-bridge@codex-gemini-web-bridge
codex plugin marketplace remove codex-gemini-web-bridge
```

卸载不会删除专用 Chrome Profile。如果还需要退出 Google 账号并删除本地对话元数据，请手动删除运行数据目录。

### 开发验证

```sh
npm ci --prefix plugins/gemini-web-bridge
npm run verify
```

MCP Server 和诊断 CLI 都以生成后的单文件提交，因此 Marketplace 用户不需要安装 npm 依赖。修改源码或依赖后，需要运行 `npm run build` 并提交更新后的 `dist/` 文件。

项目采用 [MIT License](LICENSE)。安全问题请通过 [私密漏洞报告](SECURITY.md)提交。
