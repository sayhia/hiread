# hiread-cli

Agent-facing command line for the hiread library. Every command prints one JSON
document to stdout, so LLM agents and scripts can consume the output directly.
It opens the same SQLite database as the desktop app (WAL journaling and a busy
timeout make concurrent use safe), so a book imported here shows up in the app
without a restart.

Build: `task build:cli` (or `go build -o bin/hiread-cli ./cmd/hiread-cli`).

```
hiread-cli [-data DIR] <command> [args]

home                        Library overview: counts + what is being read
list [flags]                Books (most recently read first)
    -reading | -finished | -favorite | -collection ID | -tag ID
    -q TEXT | -sort recent|added|title|author|progress
    -limit N (default 20) | -offset N
toc <bookID>                Table of contents, with the saved position
read <bookID> [-chapter N]  One chapter's text (default: where reading stopped)
search <query> [-book ID] [-limit N]   Full-text search over chapter text
import <path>...            Import books (epub, mobi/azw3, pdf, txt, md)
progress <bookID> -chapter N [-ratio R] [-page N]   Set the reading position
finish <bookID> [-off]      Mark a book finished (or not)
rm <bookID>                 Delete a book and everything attached to it
collections                 All shelves
tags                        All tags
```

`-data DIR` overrides the data directory (useful for tests and sandboxes); the
default is the desktop app's own (`~/Library/Application Support/Hiread` on
macOS).

Search understands CJK: the index separates Han characters, so a two-character
query finds passages a whole-word tokenizer would miss, and snippets come back
with the book's original spacing.

Importing the same file twice is a no-op — the result reports `duplicate: true`
along with the id of the copy already in the library.
