<p align="center">
  <img src="build/appicon.png" width="116" alt="Hiread icon" />
</p>

<h1 align="center">Hiread</h1>

<p align="center">本地优先的电子书阅读器，读你自己的书。</p>

<p align="center">
  <img src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" alt="Go 1.25" />
  <img src="https://img.shields.io/badge/Wails-v3%20alpha-d33?logo=wails&logoColor=white" alt="Wails v3" />
  <img src="https://img.shields.io/badge/Vue-3-42b883?logo=vuedotjs&logoColor=white" alt="Vue 3" />
  <img src="https://img.shields.io/badge/SQLite-FTS5-003B57?logo=sqlite&logoColor=white" alt="SQLite FTS5" />
  <img src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555" alt="macOS / Windows / Linux" />
  <a href="https://github.com/sunmking/hiread/releases/latest"><img src="https://img.shields.io/github/v/release/sunmking/hiread" alt="GitHub release" /></a>
</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

---

Hiread 是一款把一切都留在本机的桌面电子书阅读器。把 EPUB、MOBI、PDF 或者一个
`.txt` 拖进来，它们就进入同一个本地书库——一个 SQLite 文件，不需要账号，不上云，
不做追踪。阅读全程不需要联网。想脚本化时，还有一个说 JSON 的命令行工具，和应用
共用同一个书库。

## 功能

**读你自己的书**
- **EPUB** 2 / 3 —— 按 spine 顺序，目录取 nav 或 NCX，内嵌插图一并导入
- **MOBI / AZW3** —— 支持 PalmDOC 与 HUFF/CDIC 两种压缩，双格式文件优先取 KF8
  那一半（带 DRM 的文件会明确报错，而不是悄悄读出乱码）
- **PDF** —— 由内置的 pdf.js 渲染，支持缩放与页码记忆
- **TXT** —— 自动识别编码（GB18030 / Big5 / UTF-16，不只是 UTF-8），按
  `第N章` / `Chapter N` 之类的标题切分章节
- **Markdown** —— 以 GFM 渲染，用文档自己的标题层级当目录

**读得舒服**
- 阅读设置直接作用于页面：字体、字号、行距、行宽、字间距、段间距、页边距、
  两端对齐，以及独立于应用主题的阅读底色（米黄 · 浅绿 · 深灰 · 纯黑）——
  暖光、对比度、灰度也都只作用于阅读页面。日间 / 护眼 / 夜间一键切换
- 自动翻页可连续读到下一章；空格翻页保留两行重叠；可选点击两侧翻页
- 所有格式共用一套排版：字体、字号、行距、行宽，支持下载开源字体，中西文混排
  经过专门处理。书自带的 CSS 会被主动丢弃——出版方的绝对字号和写死的颜色会和你
  的设置打架；书里的插图则保留
- 目录抽屉内置书内搜索，支持章节跳转；阅读位置按书记忆，精确到滚动位置
- 进度按章节字数加权，长章节不会和短章节一样快地推进进度条
- 全屏图片查看、专注模式、浅色 / 深色，以及减少动效支持

**整理与查找**
- 书架、标签，以及智能视图（全部 · 在读 · 收藏 · 读完）——书架和标签可拖拽排序
- 基于 SQLite FTS5 的全书全文检索——包含真正可用的中文子串搜索，两个字也能搜到。
  PDF 在导入时没有可索引的文本，因此首次打开时会读取其页面并一并建立索引：
  搜索能定位到具体页码，点开命中直接翻到那一页
- 高亮与读书笔记：多种颜色，全部存在本地，按书和章节分组，带回顾面板；
  Markdown 导出所见即所得（当前筛选或勾选的那些），阅读界面的批注页可一键跳回原文
- 书签，标记你想回头再看的地方

**翻译与 AI（自带 Key）**
- 逐章翻译 —— LLM、Google、DeepL、Bing，保留结构，可切换原文 / 译文 / 双语，
  结果会缓存，重读不再花钱。分批并行，边生成边上屏；开启自动翻译后，读这一章时
  会提前翻好下一章，翻页不用等
- AI 章节摘要，以及基于整个书库（或单本书）的问答，答案带可点击的原文出处 ——
  支持 Anthropic、OpenAI、DeepSeek 或任何 OpenAI 兼容端点，包括本地模型服务

**按你的喜好**
- 浅色 / 深色 / 跟随系统，三档深色浓度，六套冷色主题色（azure · cyan · emerald ·
  indigo · violet · slate）或任意自定义颜色，全部基于 OKLCH 推导
- 命令面板（`⌘K`）与完整快捷键
- 已本地化为简体中文、English、日本語

## hiread-cli

整个书库都可以脚本化。`hiread-cli` 打开与应用相同的 SQLite 数据库（应用运行时
也可安全使用），每条命令输出一份 JSON —— 为 LLM agent 和 shell 管道而设计。

```bash
task build:cli                 # → bin/hiread-cli

hiread-cli home                          # 计数 + 正在读的书
hiread-cli import ~/Books/walden.epub
hiread-cli list -reading -limit 10
hiread-cli toc 3                         # 目录
hiread-cli read 3 -chapter 2             # 某一章的正文
hiread-cli search "闻者落泪"              # 全书库全文检索
```

完整参考见 [`cmd/hiread-cli/README.md`](cmd/hiread-cli/README.md)。

## 技术栈

**后端 — Go**
- [Wails 3](https://v3.wails.io/)（alpha）—— 原生窗口 + Go↔TS 绑定
- [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) —— 纯 Go SQLite，带 FTS5，无需 CGO
- [`PuerkitoBio/goquery`](https://github.com/PuerkitoBio/goquery) + [`microcosm-cc/bluemonday`](https://github.com/microcosm-cc/bluemonday) —— HTML 消毒
- [`yuin/goldmark`](https://github.com/yuin/goldmark) —— Markdown 渲染
- [`gogs/chardet`](https://github.com/gogs/chardet) + `golang.org/x/text` —— 编码识别与解码
- EPUB、MOBI/AZW3、PDF 的解析都在 `internal/books` 里自行实现，不依赖第三方库

**前端 — Vue 3**
- `<script setup>` + TypeScript、[Pinia](https://pinia.vuejs.org/)、[TanStack Query](https://tanstack.com/query) 与 Virtual
- [pdfjs-dist](https://mozilla.github.io/pdf.js/) —— PDF 渲染，本地打包
- [vue-i18n](https://vue-i18n.intlify.dev/)、[marked](https://marked.js.org/)、`@wailsio/runtime`、Vite

## 架构

- **服务 → 绑定。** 每个领域（`LibraryService`、`HighlightService`、`AIService`
  等）都是 `services/` 下的一个 Go 结构体，由 `wails3 generate bindings` 自动导出
  为带类型的 TypeScript，前端像调本地异步函数一样调用。
- **流式走事件。** 耗时任务（AI token、翻译分批）通过按请求命名的 Wails 事件推送，
  前端用 `Events.On/Off` 订阅。事件带单调序号，乱序投递也不会打乱内容；错误统一为
  `{ code, detail }`。
- **本地数据层。** WAL 模式 SQLite，只读连接池，基于 `user_version` 的迁移执行器，
  FTS5 检索，以及一个自定义的 `unicode_lower` 函数保证 Unicode 大小写正确。
- **书是导入的，不是引用的。** 章节、插图、封面在导入时就抽取进数据库，所以源文件
  被移动或删除后，书照样能读。章节 HTML 用 `data-res` 指向书自己的资源，而不是
  webview 能去请求的 URL。

```
hiread/
├── main.go            # Wails 装配：服务、窗口、托盘、打开文件、单实例
├── cmd/hiread-cli/    # 面向 agent 的命令行（JSON 输出），与应用共库
├── internal/          # 后端包
│   ├── books/         #   EPUB / MOBI / PDF / TXT / Markdown 解析
│   ├── db/            #   SQLite 数据层（迁移、查询、FTS5）
│   ├── models/        #   共享结构体（camelCase JSON ↔ TS 契约）
│   ├── sanitize/      #   HTML 消毒与纯文本抽取
│   ├── ai/            #   SSE 流式（Anthropic / OpenAI / DeepSeek）
│   ├── translate/     #   多引擎翻译
│   ├── fonts/         #   可下载的阅读 / 界面字体管线
│   ├── appstate/      #   共享状态（数据库 + HTTP 客户端）
│   ├── events/        #   带序号、防 panic 的事件发送
│   └── apperr/        #   稳定错误码
├── services/          # Wails 服务（自动绑定到 TypeScript）
├── frontend/          # Vue 3 应用（组件、store、composable、lib、locales）
└── build/             # Wails 配置、图标、各平台 Taskfile
```

## 下载

安装包在每次 [GitHub Release](https://github.com/sunmking/hiread/releases/latest) 中提供。

| 平台 | 文件 |
| --- | --- |
| macOS 12+（Apple Silicon + Intel） | `Hiread-*-macOS.dmg` |
| Windows 10+（x64） | `Hiread-*-windows-amd64-setup.exe` |
| Linux x64 / ARM64 | `.AppImage` · `.deb` · `.rpm` · `.tar.gz` |

macOS 为 ad-hoc 签名。第一次打开：右键应用 → 打开。Windows 未签名，SmartScreen 可能会提示。

发布新版本：`git tag v0.1.1 && git push origin v0.1.1`。GitHub Actions 会构建各平台安装包并发布 Release。

## 开始使用

### 前置条件

- **Go ≥ 1.25**
- **Node.js + npm**
- **[Task](https://taskfile.dev/)**（`task` 命令）
- **Wails 3 CLI**：`go install github.com/wailsapp/wails/v3/cmd/wails3@latest`
  （可用 `wails3 doctor` 检查工具链）

### 开发

```bash
task dev        # 热重载运行（前端 + Go）
```

### 构建

```bash
task build      # 编译应用二进制         → bin/hiread
task package    # 打包 macOS 应用        → bin/hiread.app（图标 + ad-hoc 签名）
task build:cli  # 构建 agent 命令行      → bin/hiread-cli
```

> Vue 前端通过 `go:embed` 打进 Go 二进制，打包出来的应用是自包含的。

### 数据

你的书库就是一个 SQLite 文件：

```
~/Library/Application Support/Hiread/hiread.db   # macOS
%APPDATA%\Hiread\hiread.db                       # Windows
~/.config/Hiread/hiread.db                       # Linux
```

AI 与翻译是可选功能——在**设置**里填入相应的 API Key 才会启用。除此之外，Hiread
不碰网络。

## 快捷键

| 按键 | 操作 |
| --- | --- |
| `⌘K` / `/` | 命令面板 |
| `⌘O` | 添加书籍 |
| `←` / `→`、`J` / `K` | 上一章 / 下一章 |
| `T` | 目录 |
| `F` | 专注阅读模式 |
| `Esc` | 关闭当前书 |
| `⌘,` | 设置 |

完整列表见**设置 → 快捷键**。

## 致谢

- 字体：**Inter Tight**（Rasmus Andersson）· **Newsreader**（Production Type）· **JetBrains Mono**（JetBrains）
- 也感谢所有让电子书格式保持开放和有文档的人 —— EPUB 之所以只是一个装着 HTML 的
  zip，是有人为此争取过。

## 许可

[MIT](LICENSE) —— © 2026 sunmking
