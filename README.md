<p align="center">
  <img src="build/appicon.png" width="116" alt="Hiread icon" />
</p>

<h1 align="center">Hiread</h1>

<p align="center">A fast, local-first reader for the books you already own.</p>

<p align="center">
  <img src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" alt="Go 1.25" />
  <img src="https://img.shields.io/badge/Wails-v3%20alpha-d33?logo=wails&logoColor=white" alt="Wails v3" />
  <img src="https://img.shields.io/badge/Vue-3-42b883?logo=vuedotjs&logoColor=white" alt="Vue 3" />
  <img src="https://img.shields.io/badge/SQLite-FTS5-003B57?logo=sqlite&logoColor=white" alt="SQLite FTS5" />
  <img src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555" alt="macOS / Windows / Linux" />
  <a href="https://github.com/sunmking/hiread/releases/latest"><img src="https://img.shields.io/github/v/release/sunmking/hiread" alt="GitHub release" /></a>
</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

---

Hiread is a desktop ebook reader that keeps everything on your machine. Drop in
an EPUB, a MOBI, a PDF or a plain `.txt`, and it lands in one local library —
one SQLite file, no account, no cloud, no tracking. Reading needs no network at
all. And when you want to script it, a JSON-speaking CLI shares the same
library.

## Features

**Read what you own**
- **EPUB** 2 and 3 — spine order, nav or NCX table of contents, embedded images
- **MOBI / AZW3** — PalmDOC and HUFF/CDIC compression, KF8 preferred in a combo
  file (DRM-protected files are rejected with a clear message, not silently)
- **PDF** — pages rendered by a bundled pdf.js, with zoom and page memory
- **TXT** — charset-detected (GB18030 / Big5 / UTF-16 as well as UTF-8) and
  split into chapters on `第N章` / `Chapter N` headings
- **Markdown** — rendered with GFM, its own headings becoming the contents

**Read well**
- One typography system for every format: font, size, leading and measure, with
  downloadable open-source faces and careful mixed CJK/Latin typography. A
  book's own stylesheet is deliberately dropped — publisher CSS fights the
  reader's settings; its images are kept
- Contents drawer with in-book search, chapter navigation, and a position that
  is remembered per book down to the scroll offset
- Progress weighted by chapter length, so a long chapter doesn't advance the bar
  as fast as a short one
- Full-screen image viewer, focus mode, light / dark, and reduced-motion support

**Organize & find**
- Shelves, tags, and smart views (All · Reading · Favorites · Finished) —
  drag a shelf or tag to put the lists in the order you actually use
- Full-text search across every chapter of every book, powered by SQLite FTS5 —
  including real CJK substring search, down to two-character queries. A PDF has
  no text to index at import, so its pages are read once on first open and
  indexed too; searching finds the page, and opening a hit goes to it
- Highlights & reading notes: multi-color annotations saved locally, grouped by
  book and chapter, with a review panel and a Markdown export of exactly the
  highlights on screen; the reader's notes tab jumps back to any of them
- Bookmarks for the passages you want to come back to

**Translate & augment (bring your own keys)**
- Per-chapter translation — LLM, Google, DeepL, Bing — structure-preserving,
  with original / translated / bilingual views, cached so a re-read is free.
  Batches run in parallel and appear as the model writes them; with
  auto-translate on, the next chapter is translated while you read this one, so
  turning the page doesn't wait
- AI chapter summaries, and questions answered over your whole library (or one
  book) with citations back to the passage — Anthropic, OpenAI, DeepSeek, or any
  OpenAI-compatible endpoint, including local servers

**Make it yours**
- Light / dark / follow-system appearance, three dark depths, six cool accent
  palettes (azure · cyan · emerald · indigo · violet · slate) or any custom
  color, all derived in OKLCH
- Command palette (`⌘K`), a thorough keyboard map
- Localized in English, 日本語, and 简体中文

## hiread-cli

Everything in the library is scriptable. `hiread-cli` opens the same SQLite
database as the app (safe to use while it's running) and prints one JSON
document per command — built for LLM agents and shell pipelines.

```bash
task build:cli                 # → bin/hiread-cli

hiread-cli home                          # counts + what you're reading
hiread-cli import ~/Books/walden.epub
hiread-cli list -reading -limit 10
hiread-cli toc 3                         # table of contents
hiread-cli read 3 -chapter 2             # a chapter's text
hiread-cli search "deliberately"         # full-text, across every book
```

See [`cmd/hiread-cli/README.md`](cmd/hiread-cli/README.md) for the full reference.

## Tech stack

**Backend — Go**
- [Wails 3](https://v3.wails.io/) (alpha) — native window + Go↔TS bindings
- [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) — pure-Go SQLite with FTS5 (no CGO)
- [`PuerkitoBio/goquery`](https://github.com/PuerkitoBio/goquery) + [`microcosm-cc/bluemonday`](https://github.com/microcosm-cc/bluemonday) — HTML sanitization
- [`yuin/goldmark`](https://github.com/yuin/goldmark) — Markdown rendering
- [`gogs/chardet`](https://github.com/gogs/chardet) + `golang.org/x/text` — charset detection and decoding
- EPUB, MOBI/AZW3 and PDF parsing are implemented in `internal/books` with no
  third-party dependency

**Frontend — Vue 3**
- `<script setup>` + TypeScript, [Pinia](https://pinia.vuejs.org/), [TanStack Query](https://tanstack.com/query) & Virtual
- [pdfjs-dist](https://mozilla.github.io/pdf.js/) — PDF rendering, bundled locally
- [vue-i18n](https://vue-i18n.intlify.dev/), [marked](https://marked.js.org/), `@wailsio/runtime`, Vite

## Architecture

- **Services → bindings.** Each domain (`LibraryService`, `HighlightService`,
  `AIService`, …) is a Go struct in `services/`, auto-exported to typed
  TypeScript by `wails3 generate bindings`. The frontend calls them like local
  async functions.
- **Streaming over events.** Long-running work (AI tokens, translation batches)
  emits per-request Wails events; the frontend subscribes with `Events.On/Off`.
  Streams are sequence-stamped so out-of-order delivery can't scramble them, and
  errors carry a stable `{ code, detail }` shape.
- **Local data layer.** WAL-mode SQLite with a read-only connection pool, a
  `user_version` migration runner, FTS5 search, and a custom `unicode_lower`
  function for Unicode-correct matching.
- **Books are imported, not linked.** Chapters, images and covers are extracted
  into the database at import, so a book keeps reading after its source file is
  moved or deleted. Chapter HTML addresses its images as `data-res` paths into
  the book's own resources — never as URLs the webview could fetch.

```
hiread/
├── main.go            # Wails wiring: services, window, tray, file opening, single-instance
├── cmd/hiread-cli/    # Agent-facing CLI over the same library (JSON out)
├── internal/          # Backend packages
│   ├── books/         #   EPUB / MOBI / PDF / TXT / Markdown parsers
│   ├── db/            #   SQLite data layer (migrations, queries, FTS5)
│   ├── models/        #   shared structs (camelCase JSON ↔ TS contract)
│   ├── sanitize/      #   HTML sanitization & text extraction
│   ├── ai/            #   SSE streaming (Anthropic / OpenAI / DeepSeek)
│   ├── translate/     #   multi-engine translation
│   ├── fonts/         #   downloadable reader/UI font pipeline
│   ├── appstate/      #   shared state (db + http client)
│   ├── events/        #   panic-safe, sequenced event emission
│   └── apperr/        #   stable error codes
├── services/          # Wails services (auto-bound to TypeScript)
├── frontend/          # Vue 3 app (components, stores, composables, lib, locales)
└── build/             # Wails config, icons, per-platform Taskfiles
```

## Download

Installers are attached to every [GitHub Release](https://github.com/sunmking/hiread/releases/latest).

| Platform | File |
| --- | --- |
| macOS 12+ (Apple Silicon + Intel) | `Hiread-*-macOS.dmg` |
| Windows 10+ (x64) | `Hiread-*-windows-amd64-setup.exe` |
| Linux x64 / ARM64 | `.AppImage` · `.deb` · `.rpm` · `.tar.gz` |

macOS builds are ad-hoc signed. First launch: right-click the app → Open. Windows is unsigned; SmartScreen may warn.

To cut a release: `git tag v0.1.1 && git push origin v0.1.1`. GitHub Actions builds the packages and publishes the release.

## Getting started

### Prerequisites

- **Go ≥ 1.25**
- **Node.js + npm**
- **[Task](https://taskfile.dev/)** (the `task` runner)
- **Wails 3 CLI**: `go install github.com/wailsapp/wails/v3/cmd/wails3@latest`
  (run `wails3 doctor` to verify your toolchain)

### Develop

```bash
task dev        # run with hot-reload (frontend + Go)
```

### Build

```bash
task build      # compile the app binary        → bin/hiread
task package    # package the macOS app bundle  → bin/hiread.app  (icon + ad-hoc signature)
task build:cli  # build the agent-facing CLI    → bin/hiread-cli
```

> The Vue frontend is embedded into the Go binary (`go:embed`), so the packaged
> app is fully self-contained.

### Data

Your library lives in a single SQLite file:

```
~/Library/Application Support/Hiread/hiread.db   # macOS
%APPDATA%\Hiread\hiread.db                       # Windows
~/.config/Hiread/hiread.db                       # Linux
```

AI and translation are opt-in — add the relevant API keys in **Settings** to
enable them. Nothing else in Hiread touches the network.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `⌘K` / `/` | Command palette |
| `⌘O` | Add books |
| `←` / `→`, `J` / `K` | Previous / next chapter |
| `T` | Table of contents |
| `F` | Focus reading mode |
| `Esc` | Close the book |
| `⌘,` | Settings |

The full map lives in **Settings → Shortcuts**.

## Acknowledgements

- Type: **Inter Tight** by Rasmus Andersson · **Newsreader** by Production Type · **JetBrains Mono** by JetBrains
- And to everyone who keeps ebook formats open and documented — EPUB is a zip
  full of HTML because people fought for it to be.

## License

[MIT](LICENSE) — © 2026 sunmking
