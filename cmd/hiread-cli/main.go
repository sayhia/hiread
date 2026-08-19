// hiread-cli is the agent-facing command line for hiread: import, browse, search
// and read the same library the desktop app uses, over the same SQLite file
// (WAL + busy_timeout make concurrent use with a running GUI safe). Every
// command prints one JSON document to stdout — no prose, no progress — so LLM
// agents and scripts can consume it directly.
//
// It links only hiread/internal packages: the Wails service layer
// (hiread/services) would drag native webview dependencies into a headless
// binary. Event emits inside shared code are already no-ops without a running
// Wails app (see internal/events).
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"hiread/internal/appstate"
	"hiread/internal/books"
	"hiread/internal/db"
	"hiread/internal/models"
)

func usage() {
	fmt.Fprint(os.Stderr, `hiread-cli — agent-facing interface to the hiread library (JSON out)

Usage: hiread-cli [-data DIR] <command> [args]

Commands:
  home                        Library overview: counts + what is being read
  list [flags]                Books (most recently read first)
      -reading | -finished | -favorite | -collection ID | -tag ID
      -q TEXT | -sort recent|added|title|author|progress
      -limit N (default 20) | -offset N
  toc <bookID>                Table of contents
  read <bookID> [-chapter N]  One chapter's text (default: where reading stopped)
  search <query> [-book ID] [-limit N]   Full-text search over chapter text
  import <path>...            Import book files (epub, mobi/azw3, pdf, txt, md)
  progress <bookID> -chapter N [-ratio R]   Set the reading position
  finish <bookID> [-off]      Mark a book finished (or not)
  rm <bookID>                 Delete a book and everything attached to it
  collections                 All shelves
  tags                        All tags

  -data DIR                   Override the data directory (default: the app's)
`)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func emit(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		fail(err)
	}
}

// dataDir mirrors main.go's choice so the CLI opens the same library as the
// desktop app.
func dataDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base, _ = os.UserHomeDir()
	}
	return filepath.Join(base, "Hiread")
}

func main() {
	root := flag.NewFlagSet("hiread-cli", flag.ExitOnError)
	dir := root.String("data", "", "data directory (defaults to the desktop app's)")
	root.Usage = usage
	_ = root.Parse(os.Args[1:])
	args := root.Args()
	if len(args) == 0 {
		usage()
		os.Exit(2)
	}

	d := *dir
	if d == "" {
		d = dataDir()
	}
	if err := os.MkdirAll(d, 0o755); err != nil {
		fail(err)
	}
	state, err := appstate.New(d)
	if err != nil {
		fail(err)
	}
	defer state.Close()
	ctx := context.Background()

	cmd, rest := args[0], args[1:]
	switch cmd {
	case "home":
		cmdHome(ctx, state)
	case "list":
		cmdList(ctx, state, rest)
	case "toc":
		cmdTOC(ctx, state, rest)
	case "read":
		cmdRead(ctx, state, rest)
	case "search":
		cmdSearch(ctx, state, rest)
	case "import":
		cmdImport(ctx, state, rest)
	case "progress":
		cmdProgress(ctx, state, rest)
	case "finish":
		cmdFinish(ctx, state, rest)
	case "rm":
		cmdRemove(ctx, state, rest)
	case "collections":
		cmdCollections(ctx, state)
	case "tags":
		cmdTags(ctx, state)
	default:
		usage()
		os.Exit(2)
	}
}

func cmdHome(ctx context.Context, s *appstate.State) {
	counts, err := db.CountLibrary(ctx, s.DB.R)
	if err != nil {
		fail(err)
	}
	reading, err := db.ListBooks(ctx, s.DB.R,
		models.LibraryQuery{Kind: models.QueryReading}, models.SortRecent, 10, 0)
	if err != nil {
		fail(err)
	}
	stats, err := db.StorageStats(ctx, s.DB.R)
	if err != nil {
		fail(err)
	}
	emit(map[string]any{
		"counts":  counts,
		"reading": reading,
		"storage": stats,
	})
}

func cmdList(ctx context.Context, s *appstate.State, args []string) {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	reading := fs.Bool("reading", false, "only books in progress")
	finished := fs.Bool("finished", false, "only finished books")
	favorite := fs.Bool("favorite", false, "only favorites")
	collection := fs.Int64("collection", 0, "books on one shelf")
	tag := fs.Int64("tag", 0, "books carrying one tag")
	text := fs.String("q", "", "filter by title or author")
	sortBy := fs.String("sort", models.SortRecent, "recent|added|title|author|progress")
	limit := fs.Int64("limit", 20, "maximum books")
	offset := fs.Int64("offset", 0, "skip this many")
	_ = fs.Parse(args)

	q := models.LibraryQuery{Kind: models.QueryAll}
	switch {
	case *reading:
		q.Kind = models.QueryReading
	case *finished:
		q.Kind = models.QueryFinished
	case *favorite:
		q.Kind = models.QueryFavorite
	case *collection > 0:
		q.Kind, q.Value = models.QueryCollection, collection
	case *tag > 0:
		q.Kind, q.Value = models.QueryTag, tag
	}
	if *text != "" {
		q.Text = text
	}
	list, err := db.ListBooks(ctx, s.DB.R, q, *sortBy, *limit, *offset)
	if err != nil {
		fail(err)
	}
	emit(list)
}

func cmdTOC(ctx context.Context, s *appstate.State, args []string) {
	id := mustID(args, "toc <bookID>")
	book, err := db.GetBook(ctx, s.DB.R, id)
	if err != nil {
		fail(err)
	}
	emit(map[string]any{
		"book":     book.Book,
		"chapters": book.Chapters,
		"progress": book.Progress,
	})
}

func cmdRead(ctx context.Context, s *appstate.State, args []string) {
	id := mustID(args, "read <bookID> [-chapter N]")
	fs := flag.NewFlagSet("read", flag.ExitOnError)
	chapter := fs.Int64("chapter", -1, "chapter index (default: where reading stopped)")
	_ = fs.Parse(args[1:])

	index := *chapter
	if index < 0 {
		p, err := db.GetProgress(ctx, s.DB.R, id)
		if err != nil {
			fail(err)
		}
		index = p.ChapterIndex
	}
	content, err := db.GetChapter(ctx, s.DB.R, id, index)
	if err != nil {
		fail(err)
	}
	text, err := db.ChapterText(ctx, s.DB.R, id, index)
	if err != nil {
		fail(err)
	}
	emit(map[string]any{
		"bookId":    id,
		"index":     content.Index,
		"title":     content.Title,
		"charCount": content.CharCount,
		"aiSummary": content.AiSummary,
		"text":      text,
	})
}

func cmdSearch(ctx context.Context, s *appstate.State, args []string) {
	if len(args) == 0 {
		fail(fmt.Errorf("usage: search <query> [-book ID] [-limit N]"))
	}
	fs := flag.NewFlagSet("search", flag.ExitOnError)
	book := fs.Int64("book", 0, "restrict to one book")
	limit := fs.Int64("limit", 20, "maximum hits")
	_ = fs.Parse(args[1:])

	var bookID *int64
	if *book > 0 {
		bookID = book
	}
	hits, err := db.SearchLibrary(ctx, s.DB.R, args[0], bookID, *limit)
	if err != nil {
		fail(err)
	}
	emit(hits)
}

func cmdImport(ctx context.Context, s *appstate.State, args []string) {
	if len(args) == 0 {
		fail(fmt.Errorf("usage: import <path>..."))
	}
	out := make([]models.ImportResult, 0, len(args))
	for _, path := range args {
		r := models.ImportResult{FileName: filepath.Base(path)}
		data, err := os.ReadFile(path)
		if err != nil {
			r.Error = "fileUnreadable"
			out = append(out, r)
			continue
		}
		book, err := books.Parse(path, data)
		if err != nil {
			r.Error = err.Error()
			out = append(out, r)
			continue
		}
		sum := sha256.Sum256(data)
		var source []byte
		if book.Format == books.FormatPDF {
			source = data
		}
		id, dup, err := db.ImportBook(ctx, s.DB, book, filepath.Base(path),
			hex.EncodeToString(sum[:]), int64(len(data)), source)
		if err != nil {
			r.Error = err.Error()
			out = append(out, r)
			continue
		}
		r.BookID, r.Duplicate, r.Title = id, dup, book.Metadata.Title
		out = append(out, r)
	}
	emit(out)
}

func cmdProgress(ctx context.Context, s *appstate.State, args []string) {
	id := mustID(args, "progress <bookID> -chapter N [-ratio R]")
	fs := flag.NewFlagSet("progress", flag.ExitOnError)
	chapter := fs.Int64("chapter", 0, "chapter index")
	ratio := fs.Float64("ratio", 0, "position within the chapter, 0..1")
	page := fs.Int64("page", 1, "PDF page")
	_ = fs.Parse(args[1:])

	if err := db.SetProgress(ctx, s.DB.W, id, *chapter, *ratio, *page); err != nil {
		fail(err)
	}
	p, err := db.GetProgress(ctx, s.DB.R, id)
	if err != nil {
		fail(err)
	}
	emit(p)
}

func cmdFinish(ctx context.Context, s *appstate.State, args []string) {
	id := mustID(args, "finish <bookID> [-off]")
	fs := flag.NewFlagSet("finish", flag.ExitOnError)
	off := fs.Bool("off", false, "mark as not finished")
	_ = fs.Parse(args[1:])

	if err := db.SetBookFlag(ctx, s.DB.W, id, "finished", !*off); err != nil {
		fail(err)
	}
	emit(map[string]any{"bookId": id, "finished": !*off})
}

func cmdRemove(ctx context.Context, s *appstate.State, args []string) {
	id := mustID(args, "rm <bookID>")
	if err := db.DeleteBook(ctx, s.DB.W, id); err != nil {
		fail(err)
	}
	emit(map[string]any{"bookId": id, "deleted": true})
}

func cmdCollections(ctx context.Context, s *appstate.State) {
	list, err := db.ListCollections(ctx, s.DB.R)
	if err != nil {
		fail(err)
	}
	emit(list)
}

func cmdTags(ctx context.Context, s *appstate.State) {
	list, err := db.ListTags(ctx, s.DB.R)
	if err != nil {
		fail(err)
	}
	emit(list)
}

// mustID parses the leading positional book id, exiting with the command's
// usage line when it is missing or not a number.
func mustID(args []string, usageLine string) int64 {
	if len(args) == 0 {
		fail(fmt.Errorf("usage: %s", usageLine))
	}
	id, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		fail(fmt.Errorf("usage: %s", usageLine))
	}
	return id
}
