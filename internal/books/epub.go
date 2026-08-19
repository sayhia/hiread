package books

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"

	"github.com/PuerkitoBio/goquery"

	"hiread/internal/sanitize"
)

// parseEPUB reads an EPUB 2 or 3 container: META-INF/container.xml points at the
// OPF package document, whose spine gives reading order and whose manifest
// gives every file in the book. Chapter titles come from the EPUB 3 navigation
// document when present and from the EPUB 2 NCX otherwise.
//
// The book's own CSS is deliberately dropped. hiread renders every format with
// one typography system the reader controls (font, size, measure, theme), and
// publisher stylesheets — absolute pixel sizes, hard-coded near-black on white —
// fight it. Images, which carry meaning, are kept.
func parseEPUB(data []byte) (*Book, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("epub: not a readable zip: %w", err)
	}
	files := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		files[path.Clean(f.Name)] = f
	}

	opfPath, err := epubRootfile(files)
	if err != nil {
		return nil, err
	}
	opfRaw, err := readZip(files, opfPath)
	if err != nil {
		return nil, fmt.Errorf("epub: read %s: %w", opfPath, err)
	}
	var pkg opfPackage
	if err := xml.Unmarshal(opfRaw, &pkg); err != nil {
		return nil, fmt.Errorf("epub: parse %s: %w", opfPath, err)
	}
	base := path.Dir(opfPath)

	// Manifest lookups: by id (spine references) and by resolved path (TOC and
	// chapter hrefs reference each other by path).
	byID := make(map[string]opfItem, len(pkg.Manifest.Items))
	for _, it := range pkg.Manifest.Items {
		it.resolved = resolveHref(base, it.Href)
		byID[it.ID] = it
	}

	b := &Book{Metadata: epubMetadata(&pkg)}

	// Images (and only images) travel with the book so reading survives the
	// source file moving. Keyed by resolved path — exactly what chapter HTML
	// will carry in its data-res attributes.
	haveRes := make(map[string]bool)
	for _, it := range byID {
		if !strings.HasPrefix(it.MediaType, "image/") {
			continue
		}
		raw, err := readZip(files, it.resolved)
		if err != nil || len(raw) == 0 {
			continue
		}
		b.Resources = append(b.Resources, Resource{Path: it.resolved, Mime: it.MediaType, Data: raw})
		haveRes[it.resolved] = true
	}

	titles := epubTOC(files, &pkg, byID, base)

	for _, ref := range pkg.Spine.Refs {
		// linear="no" marks front matter the reader may skip — cover pages,
		// ad pages. They stay out of the chapter list.
		if strings.EqualFold(ref.Linear, "no") {
			continue
		}
		it, ok := byID[ref.IDRef]
		if !ok || !isEPUBDocument(it.MediaType) {
			continue
		}
		raw, err := readZip(files, it.resolved)
		if err != nil {
			continue
		}
		html, heading, err := epubChapterHTML(raw, it.resolved, haveRes)
		if err != nil {
			continue
		}
		text := sanitize.HTMLToText(html)
		if strings.TrimSpace(text) == "" && !strings.Contains(html, "data-res=") {
			// An empty spine item with no image is a spacer page, not a chapter.
			continue
		}
		entry := titles[it.resolved]
		title := entry.title
		if title == "" {
			title = heading
		}
		b.Chapters = append(b.Chapters, Chapter{
			Title: title,
			HTML:  html,
			Text:  text,
			Href:  it.resolved,
			Level: entry.level,
		})
	}
	if len(b.Chapters) == 0 {
		return nil, fmt.Errorf("epub: no readable chapters in spine")
	}

	b.Cover = epubCover(files, &pkg, byID, base, b.Resources)
	return b, nil
}

// opfPackage is the subset of the OPF package document hiread reads. Go's xml
// decoder matches on local names, so the dc: and opf: prefixes need no
// namespace bookkeeping here.
type opfPackage struct {
	Metadata struct {
		Title       []string `xml:"title"`
		Creator     []string `xml:"creator"`
		Language    []string `xml:"language"`
		Publisher   []string `xml:"publisher"`
		Description []string `xml:"description"`
		Identifier  []string `xml:"identifier"`
		Date        []string `xml:"date"`
		Meta        []struct {
			Name     string `xml:"name,attr"`
			Content  string `xml:"content,attr"`
			Property string `xml:"property,attr"`
			Value    string `xml:",chardata"`
		} `xml:"meta"`
	} `xml:"metadata"`
	Manifest struct {
		Items []opfItem `xml:"item"`
	} `xml:"manifest"`
	Spine struct {
		TOC  string `xml:"toc,attr"`
		Refs []struct {
			IDRef  string `xml:"idref,attr"`
			Linear string `xml:"linear,attr"`
		} `xml:"itemref"`
	} `xml:"spine"`
	Guide struct {
		Refs []struct {
			Type string `xml:"type,attr"`
			Href string `xml:"href,attr"`
		} `xml:"reference"`
	} `xml:"guide"`
}

type opfItem struct {
	ID         string `xml:"id,attr"`
	Href       string `xml:"href,attr"`
	MediaType  string `xml:"media-type,attr"`
	Properties string `xml:"properties,attr"`
	// resolved is Href resolved against the OPF's directory — the key every
	// other part of the parser uses.
	resolved string
}

// epubRootfile returns the OPF path named by META-INF/container.xml, falling
// back to any .opf in the archive for the (non-conforming but common) books
// that ship a broken container.
func epubRootfile(files map[string]*zip.File) (string, error) {
	if raw, err := readZip(files, "META-INF/container.xml"); err == nil {
		var c struct {
			Rootfiles []struct {
				FullPath string `xml:"full-path,attr"`
			} `xml:"rootfiles>rootfile"`
		}
		if xml.Unmarshal(raw, &c) == nil {
			for _, rf := range c.Rootfiles {
				if p := path.Clean(rf.FullPath); p != "." && files[p] != nil {
					return p, nil
				}
			}
		}
	}
	for name := range files {
		if strings.HasSuffix(strings.ToLower(name), ".opf") {
			return name, nil
		}
	}
	return "", fmt.Errorf("epub: no OPF package document")
}

func epubMetadata(pkg *opfPackage) Metadata {
	m := Metadata{
		Title:       firstNonEmpty(pkg.Metadata.Title),
		Author:      strings.Join(nonEmpty(pkg.Metadata.Creator), ", "),
		Language:    firstNonEmpty(pkg.Metadata.Language),
		Publisher:   firstNonEmpty(pkg.Metadata.Publisher),
		Description: sanitize.HTMLToText(firstNonEmpty(pkg.Metadata.Description)),
		Identifier:  firstNonEmpty(pkg.Metadata.Identifier),
		Published:   firstNonEmpty(pkg.Metadata.Date),
	}
	// EPUB 3 moves the sortable author name into a refined meta; when dc:creator
	// is missing entirely that is the only author the file carries.
	if m.Author == "" {
		for _, meta := range pkg.Metadata.Meta {
			if meta.Property == "dcterms:creator" || meta.Name == "author" {
				if v := strings.TrimSpace(meta.Value + meta.Content); v != "" {
					m.Author = v
					break
				}
			}
		}
	}
	return m
}

// tocEntry is a TOC-derived title plus its nesting depth.
type tocEntry struct {
	title string
	level int
}

// epubTOC maps a spine item's resolved path to its TOC title and depth, reading
// the EPUB 3 navigation document if the manifest declares one and the EPUB 2
// NCX otherwise. Entries pointing into the middle of a document (href#fragment)
// title that whole document if nothing else does.
func epubTOC(files map[string]*zip.File, pkg *opfPackage, byID map[string]opfItem, base string) map[string]tocEntry {
	out := map[string]tocEntry{}

	for _, it := range byID {
		if !strings.Contains(it.Properties, "nav") {
			continue
		}
		raw, err := readZip(files, it.resolved)
		if err != nil {
			continue
		}
		parseNavDoc(raw, path.Dir(it.resolved), out)
		if len(out) > 0 {
			return out
		}
	}

	ncxPath := ""
	if it, ok := byID[pkg.Spine.TOC]; ok {
		ncxPath = it.resolved
	} else {
		for _, it := range byID {
			if it.MediaType == "application/x-dtbncx+xml" {
				ncxPath = it.resolved
				break
			}
		}
	}
	if ncxPath != "" {
		if raw, err := readZip(files, ncxPath); err == nil {
			parseNCX(raw, path.Dir(ncxPath), out)
		}
	}
	return out
}

// parseNavDoc reads an EPUB 3 nav document's toc nav into out.
func parseNavDoc(raw []byte, dir string, out map[string]tocEntry) {
	doc, err := goquery.NewDocumentFromReader(bytes.NewReader(raw))
	if err != nil {
		return
	}
	var toc *goquery.Selection
	doc.Find("nav").EachWithBreak(func(_ int, s *goquery.Selection) bool {
		if t, ok := s.Attr("epub:type"); ok && strings.Contains(t, "toc") {
			toc = s
			return false
		}
		return true
	})
	if toc == nil {
		toc = doc.Find("nav").First()
	}
	toc.Find("a").Each(func(_ int, a *goquery.Selection) {
		href, ok := a.Attr("href")
		if !ok {
			return
		}
		// Depth is how many nested lists sit between the link and the nav root.
		level := a.ParentsFiltered("ol, ul").Length() - 1
		if level < 0 {
			level = 0
		}
		record(out, resolveHref(dir, href), strings.TrimSpace(a.Text()), level)
	})
}

// parseNCX reads an EPUB 2 NCX navMap into out, recursing through nested
// navPoints so a nested TOC keeps its shape.
func parseNCX(raw []byte, dir string, out map[string]tocEntry) {
	var ncx struct {
		NavPoints []ncxPoint `xml:"navMap>navPoint"`
	}
	if err := xml.Unmarshal(raw, &ncx); err != nil {
		return
	}
	var walk func(points []ncxPoint, level int)
	walk = func(points []ncxPoint, level int) {
		for _, p := range points {
			record(out, resolveHref(dir, p.Content.Src), strings.TrimSpace(p.NavLabel.Text), level)
			walk(p.Children, level+1)
		}
	}
	walk(ncx.NavPoints, 0)
}

type ncxPoint struct {
	NavLabel struct {
		Text string `xml:"text"`
	} `xml:"navLabel"`
	Content struct {
		Src string `xml:"src,attr"`
	} `xml:"content"`
	Children []ncxPoint `xml:"navPoint"`
}

// record keeps the first title seen for a document: a TOC that links several
// fragments inside one file should title it after the first of them.
func record(out map[string]tocEntry, href, title string, level int) {
	if title == "" {
		return
	}
	key := stripFragment(href)
	if key == "" {
		return
	}
	if _, seen := out[key]; !seen {
		out[key] = tocEntry{title: title, level: level}
	}
}

// epubChapterHTML extracts a spine document's body, drops presentation the
// reader supplies itself, and rewrites resource references to the data-res
// contract the frontend resolves against stored book resources. It also returns
// the body's first heading (h1..h3 or a stray <title>), so a chapter whose TOC
// entry is silent still gets a name without parsing the HTML a second time.
func epubChapterHTML(raw []byte, selfPath string, haveRes map[string]bool) (html string, heading string, err error) {
	doc, err := goquery.NewDocumentFromReader(bytes.NewReader(raw))
	if err != nil {
		return "", "", err
	}
	dir := path.Dir(selfPath)

	doc.Find("script, style, link").Remove()

	doc.Find("img").Each(func(_ int, s *goquery.Selection) {
		src, _ := s.Attr("src")
		s.RemoveAttr("srcset")
		s.RemoveAttr("style")
		target := resolveHref(dir, src)
		if src == "" || !haveRes[target] {
			s.Remove()
			return
		}
		s.RemoveAttr("src")
		s.SetAttr("data-res", target)
	})
	// Covers and full-page illustrations are usually an <image> inside an SVG
	// viewport rather than an <img>; without this they vanish from the reader.
	doc.Find("image").Each(func(_ int, s *goquery.Selection) {
		href, ok := s.Attr("xlink:href")
		if !ok {
			href, _ = s.Attr("href")
		}
		target := resolveHref(dir, href)
		if !haveRes[target] {
			return
		}
		img := fmt.Sprintf(`<img data-res="%s" alt="">`, sanitize.EscapeHTML(target))
		s.ReplaceWithHtml(img)
	})
	// Intra-book links must not navigate the webview off the reader. They become
	// data-link, which the reader turns into a jump to the target chapter;
	// external links keep their href and open in the browser.
	doc.Find("a[href]").Each(func(_ int, s *goquery.Selection) {
		href, _ := s.Attr("href")
		if strings.HasPrefix(href, "http://") || strings.HasPrefix(href, "https://") || strings.HasPrefix(href, "mailto:") {
			return
		}
		s.RemoveAttr("href")
		if t := resolveLink(dir, href); t != "" {
			s.SetAttr("data-link", t)
		}
	})

	body := doc.Find("body")
	if body.Length() == 0 {
		body = doc.Selection
	}
	// The heading comes from the live body selection, matching what
	// epubHeadingTitle used to extract from the serialized body. With a real
	// <body> a <title> sitting in the <head> cannot shadow the body's own
	// headings; only the body-less fallback below (whole document) could see
	// one, exactly as before.
	heading = collapseSpaces(strings.TrimSpace(body.Find("h1, h2, h3, title").First().Text()))
	out, err := body.Html()
	if err != nil {
		return "", "", err
	}
	return strings.TrimSpace(out), heading, nil
}

// epubCover finds the cover image, trying in order: the EPUB 3 cover-image
// manifest property, the EPUB 2 <meta name="cover"> id reference, the guide's
// cover page (whose image is the cover), and finally a manifest image whose
// name says "cover".
func epubCover(files map[string]*zip.File, pkg *opfPackage, byID map[string]opfItem, base string, res []Resource) *Resource {
	find := func(p string) *Resource {
		for i := range res {
			if res[i].Path == p {
				return &res[i]
			}
		}
		return nil
	}

	for _, it := range byID {
		if strings.Contains(it.Properties, "cover-image") {
			if r := find(it.resolved); r != nil {
				return r
			}
		}
	}
	for _, meta := range pkg.Metadata.Meta {
		if strings.EqualFold(meta.Name, "cover") && meta.Content != "" {
			if it, ok := byID[meta.Content]; ok {
				if r := find(it.resolved); r != nil {
					return r
				}
			}
		}
	}
	for _, ref := range pkg.Guide.Refs {
		if !strings.EqualFold(ref.Type, "cover") {
			continue
		}
		p := resolveHref(base, ref.Href)
		if r := find(p); r != nil {
			return r
		}
		// The guide usually points at an XHTML wrapper; the cover is its image.
		if raw, err := readZip(files, p); err == nil {
			if doc, err := goquery.NewDocumentFromReader(bytes.NewReader(raw)); err == nil {
				src, ok := doc.Find("img").First().Attr("src")
				if !ok {
					src, _ = doc.Find("image").First().Attr("xlink:href")
				}
				if r := find(resolveHref(path.Dir(p), src)); r != nil {
					return r
				}
			}
		}
	}
	for i := range res {
		if strings.Contains(strings.ToLower(res[i].Path), "cover") {
			return &res[i]
		}
	}
	return nil
}

func isEPUBDocument(mime string) bool {
	switch mime {
	case "application/xhtml+xml", "text/html", "application/x-dtbook+xml", "text/x-oeb1-document":
		return true
	}
	return false
}

// readZip reads one archive member whole. EPUB hrefs are URL-escaped, so a
// literal miss retries against the unescaped name (and vice versa) before
// giving up.
func readZip(files map[string]*zip.File, name string) ([]byte, error) {
	f := files[path.Clean(name)]
	if f == nil {
		if un, err := url.PathUnescape(name); err == nil {
			f = files[path.Clean(un)]
		}
	}
	if f == nil {
		// Some producers escape the archive entry rather than the href.
		esc := (&url.URL{Path: name}).EscapedPath()
		f = files[path.Clean(esc)]
	}
	if f == nil {
		return nil, fmt.Errorf("not found in archive: %s", name)
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// resolveHref resolves a possibly-escaped, possibly-relative href against dir
// and returns a clean archive path with any fragment removed.
func resolveHref(dir, href string) string {
	href = strings.TrimSpace(href)
	if href == "" {
		return ""
	}
	href = stripFragment(href)
	if href == "" {
		return ""
	}
	if un, err := url.PathUnescape(href); err == nil {
		href = un
	}
	if strings.HasPrefix(href, "/") {
		return path.Clean(strings.TrimPrefix(href, "/"))
	}
	if dir == "" || dir == "." {
		return path.Clean(href)
	}
	return path.Clean(path.Join(dir, href))
}

// resolveLink is resolveHref for a link rather than a resource: it keeps the
// fragment, because in a book the fragment is usually the whole point of the
// link. Footnote markers are the common case, and they come in both shapes —
// "#fn1" inside the same file, and "notes.xhtml#fn1" across files. Dropping
// the fragment turned the first into a link to nothing (which is why footnote
// markers read as dead text) and the second into a jump to the top of a
// chapter the reader then had to search.
//
// The result is "<path>", "<path>#<fragment>" or "#<fragment>"; the reader
// splits it back apart.
func resolveLink(dir, href string) string {
	href = strings.TrimSpace(href)
	if href == "" {
		return ""
	}
	frag := ""
	if i := strings.IndexByte(href, '#'); i >= 0 {
		frag, href = href[i:], href[:i]
	}
	// A bare fragment points inside the file it is written in.
	if href == "" {
		return frag
	}
	target := resolveHref(dir, href)
	if target == "" {
		return frag
	}
	return target + frag
}

func stripFragment(s string) string {
	if i := strings.IndexByte(s, '#'); i >= 0 {
		return s[:i]
	}
	return s
}

func firstNonEmpty(vals []string) string {
	for _, v := range vals {
		if t := strings.TrimSpace(v); t != "" {
			return t
		}
	}
	return ""
}

func nonEmpty(vals []string) []string {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		if t := strings.TrimSpace(v); t != "" {
			out = append(out, t)
		}
	}
	return out
}
