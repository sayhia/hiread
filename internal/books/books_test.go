package books

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

// --- EPUB ---------------------------------------------------------------

// tinyPNG is a 1×1 transparent PNG, enough to be recognized as an image.
var tinyPNG = []byte{
	0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n',
	0, 0, 0, 13, 'I', 'H', 'D', 'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
	0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 10, 'I', 'D', 'A', 'T',
	0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4,
	0, 0, 0, 0, 'I', 'E', 'N', 'D', 0xae, 0x42, 0x60, 0x82,
}

func buildEPUB(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	// The mimetype entry must come first and be stored, not deflated.
	mh := &zip.FileHeader{Name: "mimetype", Method: zip.Store}
	w, err := zw.CreateHeader(mh)
	if err != nil {
		t.Fatalf("mimetype: %v", err)
	}
	if _, err := w.Write([]byte("application/epub+zip")); err != nil {
		t.Fatalf("mimetype write: %v", err)
	}
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		if _, err := w.Write(body); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

// sampleEPUB is an EPUB 3 with a nav document, two chapters, an image and a
// cover, plus a linear="no" front-matter page that must not become a chapter.
func sampleEPUB(t *testing.T) []byte {
	t.Helper()
	return buildEPUB(t, map[string][]byte{
		"META-INF/container.xml": []byte(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
		"OEBPS/content.opf": []byte(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>山月记</dc:title>
    <dc:creator>中岛敦</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>青空文库</dc:publisher>
    <dc:identifier id="pub-id">urn:uuid:1234</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="pic" href="images/pic.png" media-type="image/png"/>
    <item id="front" href="front.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="front" linear="no"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`),
		"OEBPS/nav.xhtml": []byte(`<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">第一章 陇西李征</a>
    <ol><li><a href="text/ch2.xhtml#s1">第二章 月下长啸</a></li></ol>
  </li>
</ol></nav></body></html>`),
		"OEBPS/front.xhtml": []byte(`<html><body><p>版权页</p></body></html>`),
		"OEBPS/ch1.xhtml": []byte(`<html><head><style>p{color:red}</style></head>
<body><h1>第一章 陇西李征</h1><p>李征博学才颖。</p>
<img src="images/pic.png" alt="插图"/>
<a href="text/ch2.xhtml">下一章</a>
<a href="https://example.com/x">站外</a>
<script>alert(1)</script></body></html>`),
		"OEBPS/text/ch2.xhtml":   []byte(`<html><body><h2 id="s1">第二章 月下长啸</h2><p>其声悲怆。</p></body></html>`),
		"OEBPS/images/cover.png": tinyPNG,
		"OEBPS/images/pic.png":   tinyPNG,
	})
}

func TestParseEPUBMetadataAndSpine(t *testing.T) {
	b, err := Parse("book.epub", sampleEPUB(t))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if b.Format != FormatEPUB {
		t.Errorf("format = %q, want epub", b.Format)
	}
	if b.Metadata.Title != "山月记" || b.Metadata.Author != "中岛敦" {
		t.Errorf("metadata = %+v", b.Metadata)
	}
	if b.Metadata.Language != "zh-CN" || b.Metadata.Publisher != "青空文库" {
		t.Errorf("metadata = %+v", b.Metadata)
	}
	// front.xhtml is linear="no" and must be skipped.
	if len(b.Chapters) != 2 {
		t.Fatalf("got %d chapters, want 2: %+v", len(b.Chapters), chapterTitles(b))
	}
	if b.Chapters[0].Title != "第一章 陇西李征" || b.Chapters[1].Title != "第二章 月下长啸" {
		t.Errorf("titles = %v", chapterTitles(b))
	}
	if b.Chapters[1].Level != 1 {
		t.Errorf("nested TOC entry level = %d, want 1", b.Chapters[1].Level)
	}
	if !strings.Contains(b.Chapters[0].Text, "李征博学才颖") {
		t.Errorf("chapter text = %q", b.Chapters[0].Text)
	}
}

func TestParseEPUBRewritesResourcesAndLinks(t *testing.T) {
	b, err := Parse("book.epub", sampleEPUB(t))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	html := b.Chapters[0].HTML
	if !strings.Contains(html, `data-res="OEBPS/images/pic.png"`) {
		t.Errorf("image not rewritten to data-res: %s", html)
	}
	if strings.Contains(html, "<script") || strings.Contains(html, "<style") {
		t.Errorf("script/style survived: %s", html)
	}
	// Internal links become data-link; external ones keep their href.
	if !strings.Contains(html, `data-link="OEBPS/text/ch2.xhtml"`) {
		t.Errorf("internal link not rewritten: %s", html)
	}
	if !strings.Contains(html, `href="https://example.com/x"`) {
		t.Errorf("external link should be preserved: %s", html)
	}
	if b.Cover == nil || b.Cover.Path != "OEBPS/images/cover.png" {
		t.Fatalf("cover = %+v", b.Cover)
	}
	if !bytes.Equal(b.Cover.Data, tinyPNG) {
		t.Errorf("cover bytes do not round-trip")
	}
	if len(b.Resources) != 2 {
		t.Errorf("got %d resources, want 2", len(b.Resources))
	}
}

func TestParseEPUBFallsBackToNCX(t *testing.T) {
	data := buildEPUB(t, map[string][]byte{
		"META-INF/container.xml": []byte(`<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`),
		"content.opf": []byte(`<package>
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Old Book</dc:title></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="a.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/></spine>
</package>`),
		"toc.ncx": []byte(`<ncx><navMap>
  <navPoint playOrder="1"><navLabel><text>Opening</text></navLabel><content src="a.html"/></navPoint>
</navMap></ncx>`),
		"a.html": []byte(`<html><body><p>Once upon a time.</p></body></html>`),
	})
	b, err := Parse("old.epub", data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(b.Chapters) != 1 || b.Chapters[0].Title != "Opening" {
		t.Fatalf("chapters = %v", chapterTitles(b))
	}
}

// --- plain text ---------------------------------------------------------

func TestParseTextSplitsChineseChapters(t *testing.T) {
	src := "书名：测试之书\n作者：某人\n\n" +
		"第一章 开始\n他走进了雨里。\n雨很大。\n\n" +
		"第二章 结束\n他回到了家。\n"
	b, err := Parse("test.txt", []byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if b.Metadata.Title != "测试之书" || b.Metadata.Author != "某人" {
		t.Errorf("metadata = %+v", b.Metadata)
	}
	titles := chapterTitles(b)
	// The 书名/作者 header is lifted into the metadata, so it must not also
	// survive as a junk first chapter.
	if len(b.Chapters) != 2 {
		t.Fatalf("chapters = %v", titles)
	}
	if titles[0] != "第一章 开始" || titles[1] != "第二章 结束" {
		t.Errorf("titles = %v", titles)
	}
	if !strings.Contains(b.Chapters[0].HTML, "<h2>第一章 开始</h2>") {
		t.Errorf("heading not marked up: %q", b.Chapters[0].HTML)
	}
	if !strings.Contains(b.Chapters[0].Text, "他走进了雨里") {
		t.Errorf("body text = %q", b.Chapters[0].Text)
	}
}

func TestParseTextDecodesGBK(t *testing.T) {
	utf8Src := "第一章 天气\n今天下雪了，很冷。\n"
	gbk, _, err := transform.Bytes(simplifiedchinese.GB18030.NewEncoder(), []byte(utf8Src))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if bytes.Contains(gbk, []byte("今天")) {
		t.Fatal("fixture is not actually GBK-encoded")
	}
	b, err := Parse("gbk.txt", gbk)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	joined := strings.Join(chapterTexts(b), "\n")
	if !strings.Contains(joined, "今天下雪了") {
		t.Errorf("GBK text not decoded: %q", joined)
	}
}

func TestParseTextWithoutHeadingsSplitsBySize(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < 400; i++ {
		sb.WriteString("这是一个没有章节标题的长段落，用来测试固定长度切分。\n\n")
	}
	b, err := Parse("flat.txt", []byte(sb.String()))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(b.Chapters) < 2 {
		t.Fatalf("expected the text to be split, got %d chapter(s)", len(b.Chapters))
	}
	for i, c := range b.Chapters {
		if strings.TrimSpace(c.Title) == "" {
			t.Errorf("chapter %d has no fallback title", i)
		}
	}
}

func TestParseMarkdown(t *testing.T) {
	src := "# 我的笔记\n\n开场白。\n\n## 第一节\n\n正文 **加粗**。\n\n```go\n// ## not a heading\n```\n\n## 第二节\n\n收尾。\n"
	b, err := Parse("notes.md", []byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if b.Format != FormatMD {
		t.Errorf("format = %q", b.Format)
	}
	titles := chapterTitles(b)
	if len(titles) != 3 || titles[1] != "第一节" || titles[2] != "第二节" {
		t.Fatalf("titles = %v", titles)
	}
	if !strings.Contains(b.Chapters[1].HTML, "<strong>加粗</strong>") {
		t.Errorf("markdown not rendered: %q", b.Chapters[1].HTML)
	}
}

// --- PDF ----------------------------------------------------------------

func TestParsePDFMetadata(t *testing.T) {
	pdf := []byte("%PDF-1.4\n" +
		"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
		"2 0 obj << /Type /Pages /Count 2 >> endobj\n" +
		"3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n" +
		"4 0 obj << /Type /Page /Parent 2 0 R >> endobj\n" +
		"5 0 obj << /Title (Deep Work) /Author (Cal Newport) >> endobj\n" +
		"trailer << /Info 5 0 R >>\n%%EOF")
	b, err := Parse("dw.pdf", pdf)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if b.Format != FormatPDF {
		t.Errorf("format = %q", b.Format)
	}
	if b.Metadata.Title != "Deep Work" || b.Metadata.Author != "Cal Newport" {
		t.Errorf("metadata = %+v", b.Metadata)
	}
	if b.PageCount != 2 {
		t.Errorf("pageCount = %d, want 2", b.PageCount)
	}
}

func TestDecodePDFStringUTF16(t *testing.T) {
	// <FEFF 4E2D 6587> is "中文" in UTF-16BE with a byte-order mark.
	if got := decodePDFString([]byte("<FEFF4E2D6587>")); got != "中文" {
		t.Errorf("hex UTF-16 = %q, want 中文", got)
	}
	if got := decodePDFString([]byte(`(a\(b\)c)`)); got != "a(b)c" {
		t.Errorf("escaped literal = %q", got)
	}
}

// --- MOBI ---------------------------------------------------------------

// buildMOBI assembles a minimal uncompressed MOBI: a PalmDB with record 0
// holding the PalmDOC + MOBI headers and an EXTH block, one text record, and
// one image record.
// mobiOpts describes one MOBI section to synthesize.
type mobiOpts struct {
	markup string
	// withImage appends tinyPNG as an image record after the text.
	withImage bool
	// firstImage is the record index the header points at for images; 0 means
	// "right after the text record", which is where buildMOBI puts it.
	firstImage int
	// exthUint adds extra EXTH tags carrying a uint32 (121 = the KF8 boundary).
	exthUint map[int]uint32
}

// mobiRecords builds the PalmDB records of one MOBI section: record 0 (the
// PalmDOC + MOBI headers and EXTH), the text, and optionally an image.
func mobiRecords(t *testing.T, o mobiOpts) [][]byte {
	t.Helper()

	exth := func() []byte {
		var recs bytes.Buffer
		count := 0
		add := func(typ int, val []byte) {
			binary.Write(&recs, binary.BigEndian, uint32(typ))
			binary.Write(&recs, binary.BigEndian, uint32(len(val)+8))
			recs.Write(val)
			count++
		}
		addUint := func(typ int, v uint32) {
			var b [4]byte
			binary.BigEndian.PutUint32(b[:], v)
			add(typ, b[:])
		}
		add(100, []byte("Herman Melville"))
		add(503, []byte("Moby-Dick"))
		add(101, []byte("Harper"))
		if o.withImage {
			addUint(201, 0) // the cover is the first image record
		}
		for typ, v := range o.exthUint {
			addUint(typ, v)
		}
		var out bytes.Buffer
		out.WriteString("EXTH")
		binary.Write(&out, binary.BigEndian, uint32(12+recs.Len()))
		binary.Write(&out, binary.BigEndian, uint32(count))
		out.Write(recs.Bytes())
		for out.Len()%4 != 0 {
			out.WriteByte(0)
		}
		return out.Bytes()
	}()

	firstImage := o.firstImage
	if firstImage == 0 {
		firstImage = 2
	}

	const mobiHeaderLen = 0xf8
	rec0 := make([]byte, 16+mobiHeaderLen)
	binary.BigEndian.PutUint16(rec0[0:], compNone)
	binary.BigEndian.PutUint32(rec0[4:], uint32(len(o.markup)))
	binary.BigEndian.PutUint16(rec0[8:], 1) // one text record
	binary.BigEndian.PutUint16(rec0[10:], 4096)
	copy(rec0[16:], "MOBI")
	binary.BigEndian.PutUint32(rec0[20:], mobiHeaderLen)
	binary.BigEndian.PutUint32(rec0[0x1c:], 65001) // UTF-8
	binary.BigEndian.PutUint32(rec0[0x24:], 6)     // file version
	binary.BigEndian.PutUint32(rec0[0x6c:], uint32(firstImage))
	binary.BigEndian.PutUint32(rec0[0x80:], 0x40) // EXTH present
	rec0 = append(rec0, exth...)
	// Full name lives after the EXTH block.
	nameOff := len(rec0)
	rec0 = append(rec0, []byte("Moby-Dick")...)
	binary.BigEndian.PutUint32(rec0[0x54:], uint32(nameOff))
	binary.BigEndian.PutUint32(rec0[0x58:], 9)

	records := [][]byte{rec0, []byte(o.markup)}
	if o.withImage {
		records = append(records, tinyPNG)
	}
	return records
}

// palmDBOf wraps records in the PalmDB container: the 78-byte header, the
// record offset table, then the records themselves.
func palmDBOf(t *testing.T, records [][]byte) []byte {
	t.Helper()
	var out bytes.Buffer
	header := make([]byte, palmHeaderLen)
	copy(header[0:], "MobyDick")
	copy(header[60:], "BOOKMOBI")
	binary.BigEndian.PutUint16(header[76:], uint16(len(records)))
	out.Write(header)

	offset := palmHeaderLen + len(records)*8
	for i, r := range records {
		var entry [8]byte
		binary.BigEndian.PutUint32(entry[0:], uint32(offset))
		entry[5], entry[6], entry[7] = 0, 0, byte(i)
		out.Write(entry[:])
		offset += len(r)
	}
	for _, r := range records {
		out.Write(r)
	}
	return out.Bytes()
}

// buildMOBI assembles a minimal uncompressed MOBI: a PalmDB with record 0
// holding the PalmDOC + MOBI headers and an EXTH block, one text record, and
// optionally one image record.
func buildMOBI(t *testing.T, markup string, withImage bool) []byte {
	t.Helper()
	return palmDBOf(t, mobiRecords(t, mobiOpts{markup: markup, withImage: withImage}))
}

func TestParseMOBI(t *testing.T) {
	markup := `<html><body>` +
		`<h1>Loomings</h1><p>Call me Ishmael.</p><img recindex="00001"/>` +
		`<mbp:pagebreak/>` +
		`<h1>The Carpet-Bag</h1><p>I stuffed a shirt or two into my old carpet-bag.</p>` +
		`</body></html>`
	b, err := Parse("moby.mobi", buildMOBI(t, markup, true))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if b.Format != FormatMOBI {
		t.Errorf("format = %q", b.Format)
	}
	if b.Metadata.Title != "Moby-Dick" || b.Metadata.Author != "Herman Melville" {
		t.Errorf("metadata = %+v", b.Metadata)
	}
	if b.Metadata.Publisher != "Harper" {
		t.Errorf("publisher = %q", b.Metadata.Publisher)
	}
	titles := chapterTitles(b)
	if len(titles) != 2 || titles[0] != "Loomings" || titles[1] != "The Carpet-Bag" {
		t.Fatalf("titles = %v", titles)
	}
	if !strings.Contains(b.Chapters[0].Text, "Call me Ishmael") {
		t.Errorf("text = %q", b.Chapters[0].Text)
	}
	if !strings.Contains(b.Chapters[0].HTML, `data-res="images/1.png"`) {
		t.Errorf("recindex image not rewritten: %s", b.Chapters[0].HTML)
	}
	if b.Cover == nil || !bytes.Equal(b.Cover.Data, tinyPNG) {
		t.Errorf("cover = %+v", b.Cover)
	}
}

// buildComboMOBI assembles the shape a Kindle "combo" file has: a MOBI 6 book,
// a BOUNDARY marker, then a KF8 book — with the images stored once, in the
// MOBI 6 half. The KF8 header's own firstImage points past the end of that
// pool, exactly as it does in a real file, so a parser that reads images from
// the half it took the text from finds none.
func buildComboMOBI(t *testing.T) []byte {
	t.Helper()

	// The MOBI 6 half is records 0..2 (header, text, image) and the BOUNDARY
	// marker is record 3, so the KF8 half starts at record 4.
	const boundary = 4
	mobi6 := mobiRecords(t, mobiOpts{
		markup:    "<html><body><p>legacy</p></body></html>",
		withImage: true,
		exthUint:  map[int]uint32{121: boundary},
	})
	// The KF8 half: better markup, and a firstImage that only makes sense once
	// the file has been split in two — well past the end of its own records.
	kf8 := mobiRecords(t, mobiOpts{
		markup:     `<html><body><h1>Ch</h1><p>modern</p><img src="kindle:embed:0001"/></body></html>`,
		firstImage: 40,
	})

	records := append(mobi6, []byte("BOUNDARY"))
	if len(records) != boundary {
		t.Fatalf("boundary is at %d, not %d", len(records), boundary)
	}
	return palmDBOf(t, append(records, kf8...))
}

func TestParseComboMOBITakesTextFromKF8AndImagesFromMOBI6(t *testing.T) {
	b, err := Parse("combo.azw3", buildComboMOBI(t))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	// The text is the KF8 half's.
	joined := strings.Join(chapterTexts(b), " ")
	if !strings.Contains(joined, "modern") || strings.Contains(joined, "legacy") {
		t.Errorf("text came from the wrong half: %q", joined)
	}
	// The images are the MOBI 6 half's, and they are found at all.
	if b.Cover == nil || !bytes.Equal(b.Cover.Data, tinyPNG) {
		t.Fatalf("cover = %+v, want the image stored with the MOBI 6 half", b.Cover)
	}
	if len(b.Resources) != 1 {
		t.Fatalf("resources = %d, want 1", len(b.Resources))
	}
	// And a KF8 kindle:embed reference resolves into that same pool.
	if !strings.Contains(b.Chapters[0].HTML, `data-res="`+b.Resources[0].Path+`"`) {
		t.Errorf("kindle:embed image not resolved: %s", b.Chapters[0].HTML)
	}
}

// KF8 markup is one flat document split on headings, so a book that opens its
// chapters with two headings in a row leaves a "chapter" holding nothing but
// the number. A real 277-entry table of contents was 36% these.
func TestParseMOBIMergesNumberOnlyChapters(t *testing.T) {
	markup := `<html><body>` +
		`<h1>第一章</h1>` +
		`<h1>雕版印刷术</h1><p>雕版印刷始于隋唐之际，盛于两宋，是活字之前最通行的复制手段。</p>` +
		`<h1>目录</h1>` +
		`<h1>后记</h1><p>本书所收各篇，均曾在报刊上发表，此次结集略有增删。</p>` +
		`</body></html>`
	b, err := Parse("kf8.azw3", buildMOBI(t, markup, false))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	titles := chapterTitles(b)
	if len(titles) != 2 {
		t.Fatalf("chapters = %v, want the two real ones", titles)
	}
	// A bare number is the missing half of the heading that follows it.
	if titles[0] != "第一章 雕版印刷术" {
		t.Errorf("title = %q, want the number joined to the title", titles[0])
	}
	// Anything else text-less merges its content without renaming the chapter.
	if titles[1] != "后记" {
		t.Errorf("title = %q, want the following chapter's own title", titles[1])
	}
	// Nothing is dropped: the stub's own words are still in the book.
	joined := strings.Join(chapterTexts(b), "\n")
	for _, want := range []string{"第一章", "雕版印刷始于隋唐", "目录", "本书所收各篇"} {
		if !strings.Contains(joined, want) {
			t.Errorf("merging lost %q:\n%s", want, joined)
		}
	}
}

// A chapter that is only a picture is a plate page, not a stub — merging it
// away would lose the illustration.
func TestParseMOBIKeepsImageOnlyChapters(t *testing.T) {
	markup := `<html><body>` +
		`<h1>Plate</h1><img recindex="00001"/>` +
		`<h1>Text</h1><p>` + strings.Repeat("word ", 20) + `</p>` +
		`</body></html>`
	b, err := Parse("plates.mobi", buildMOBI(t, markup, true))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(b.Chapters) != 2 {
		t.Fatalf("chapters = %v, want the plate kept", chapterTitles(b))
	}
	if !strings.Contains(b.Chapters[0].HTML, "data-res=") {
		t.Errorf("the plate lost its image: %s", b.Chapters[0].HTML)
	}
}

func TestParseMOBIRejectsDRM(t *testing.T) {
	data := buildMOBI(t, "<html><body><p>x</p></body></html>", false)
	binary.BigEndian.PutUint16(data[palmHeaderLen+2*8+12:], 1) // encryption = 1
	if _, err := Parse("drm.mobi", data); err == nil {
		t.Fatal("expected DRM-protected file to be rejected")
	} else if !strings.Contains(err.Error(), "DRM") {
		t.Errorf("error = %v, want it to mention DRM", err)
	}
}

func TestPalmDocUnpack(t *testing.T) {
	tests := []struct {
		name string
		in   []byte
		want string
	}{
		{"literals", []byte("abc"), "abc"},
		{"literal run", append([]byte{3}, 'x', 'y', 'z'), "xyz"},
		{"space shortcut", []byte{0xC0 | 'a'}, " a"},
		// "ab" then a back-reference of length 3 at distance 2 → "ababa".
		{"back reference", []byte{'a', 'b', 0x80 | (2 << 3 >> 8), byte((2 << 3) & 0xff)}, "ababa"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(palmDocUnpack(tc.in)); got != tc.want {
				t.Errorf("palmDocUnpack = %q, want %q", got, tc.want)
			}
		})
	}
}

// --- detection ----------------------------------------------------------

func TestDetectFormat(t *testing.T) {
	tests := []struct {
		name string
		head []byte
		want Format
	}{
		{"a.pdf", []byte("%PDF-1.7"), FormatPDF},
		{"a.epub", []byte("PK\x03\x04\x14\x00\x00\x00\x00\x00mimetype"), FormatEPUB},
		{"a.txt", []byte("just text"), FormatTXT},
		{"a.md", []byte("# hi"), FormatMD},
		{"NOEXT", append(make([]byte, 60), []byte("BOOKMOBI")...), FormatMOBI},
	}
	for _, tc := range tests {
		got, ok := DetectFormat(tc.name, tc.head)
		if !ok || got != tc.want {
			t.Errorf("DetectFormat(%q) = %q,%v want %q", tc.name, got, ok, tc.want)
		}
	}
	if _, ok := DetectFormat("a.docx", []byte("PK\x03\x04word/")); ok {
		t.Error("a non-EPUB zip should not be accepted")
	}
	if _, ok := DetectFormat("mystery", []byte("????")); ok {
		t.Error("unknown bytes should not be accepted")
	}
}

func TestParseFallsBackToFilenameTitle(t *testing.T) {
	b, err := Parse("/books/The_Pragmatic_Programmer.txt", []byte("第一章 起\n正文。\n"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if b.Metadata.Title != "The Pragmatic Programmer" {
		t.Errorf("title = %q", b.Metadata.Title)
	}
}

func chapterTitles(b *Book) []string {
	out := make([]string, len(b.Chapters))
	for i, c := range b.Chapters {
		out[i] = c.Title
	}
	return out
}

func chapterTexts(b *Book) []string {
	out := make([]string, len(b.Chapters))
	for i, c := range b.Chapters {
		out[i] = c.Text
	}
	return out
}

// A book's links are mostly footnote markers, and a footnote marker is nothing
// without its fragment: "#fn1" is the note, not the file. Dropping it made the
// marker a link to nowhere, and a cross-file note a jump to the top of a
// chapter the reader then had to search by eye.
func TestResolveLinkKeepsTheFragment(t *testing.T) {
	cases := []struct{ dir, href, want string }{
		{"OEBPS/text", "#fn1", "#fn1"},
		{"OEBPS/text", "notes.xhtml#fn1", "OEBPS/text/notes.xhtml#fn1"},
		{"OEBPS/text", "../notes.xhtml#fn1", "OEBPS/notes.xhtml#fn1"},
		{"OEBPS/text", "ch2.xhtml", "OEBPS/text/ch2.xhtml"},
		{"", "notes.xhtml#a", "notes.xhtml#a"},
		{"OEBPS/text", "/abs/notes.xhtml#a", "abs/notes.xhtml#a"},
		// A percent-escaped path still resolves; the fragment rides along.
		{"OEBPS", "text%20one.xhtml#a", "OEBPS/text one.xhtml#a"},
		{"OEBPS", "   ", ""},
		{"OEBPS", "", ""},
		// A fragment with nothing before it and nothing after is not a link.
		{"OEBPS", "#", "#"},
	}
	for _, tc := range cases {
		if got := resolveLink(tc.dir, tc.href); got != tc.want {
			t.Errorf("resolveLink(%q, %q) = %q, want %q", tc.dir, tc.href, got, tc.want)
		}
	}
}

// The resource path resolver must keep dropping fragments: an image or a
// chapter file is addressed by path alone.
func TestResolveHrefStillDropsTheFragment(t *testing.T) {
	if got := resolveHref("OEBPS", "ch1.xhtml#part2"); got != "OEBPS/ch1.xhtml" {
		t.Errorf("resolveHref = %q, want the bare path", got)
	}
}

// A MOBI is one flat document whose internal links — the book's own contents,
// its footnote markers — address their targets by byte offset. Split the
// document and the offsets mean nothing, which is why they used to be dropped
// and every such link read as plain text.
func TestMobiFileposLinksSurviveTheSplit(t *testing.T) {
	// Two chapters: a contents page pointing at the second and at a note inside
	// itself. Both parts carry enough prose to stand as chapters of their own
	// (a text-less fragment is folded into its neighbour — see mergeStubChapters).
	head := `<html><body><h1>目录</h1><p><a filepos=%010d>第一章</a> <a filepos=%010d>注一</a></p>` +
		`<p>本书目录如上，以下为注释与正文，注释置于目录之后以便查阅。</p>`
	rest := `<p id="note">注一：此处为注文，注文亦须足够长方能自成一章。</p>` +
		`<mbp:pagebreak/><h1>第一章</h1><p>正文正文正文正文正文正文正文正文正文正文，` +
		`此段须长过 stubChapterRunes，否则会被并入上一章。</p>`

	// The offsets have to be measured against the document as it will finally
	// read, since the numbers themselves change its length.
	raw := fmt.Sprintf(head, 0, 0) + rest
	noteAt := strings.Index(raw, `<p id="note">`)
	chapAt := strings.Index(raw, "<mbp:pagebreak/>")
	raw = fmt.Sprintf(head, chapAt, noteAt) + rest
	if strings.Index(raw, "<mbp:pagebreak/>") != chapAt || strings.Index(raw, `<p id="note">`) != noteAt {
		t.Fatalf("fixture offsets moved; the %%010d padding must keep the length fixed")
	}

	chapters := mobiChapters(raw, nil, nil)
	if len(chapters) < 2 {
		t.Fatalf("got %d chapters, want the contents and the chapter", len(chapters))
	}
	// Every chapter is addressable, since a flat document has no filenames.
	for i, c := range chapters {
		if c.Href != mobiChapterHref(i) {
			t.Errorf("chapter %d href = %q, want %q", i, c.Href, mobiChapterHref(i))
		}
	}

	toc := chapters[0].HTML
	if strings.Contains(toc, "filepos") {
		t.Errorf("a raw filepos survived into the chapter: %s", toc)
	}
	// The link into the next chapter names that chapter and the anchor in it.
	wantChapterLink := `data-link="` + mobiChapterHref(1) + "#" + fileposID(chapAt) + `"`
	if !strings.Contains(toc, wantChapterLink) {
		t.Errorf("contents link = %s\nwant %s", toc, wantChapterLink)
	}
	if !strings.Contains(chapters[1].HTML, `id="`+fileposID(chapAt)+`"`) {
		t.Errorf("the anchor was not planted in the target chapter: %s", chapters[1].HTML)
	}
	// And the link to a note in this same chapter resolves to it.
	wantNoteLink := `data-link="` + mobiChapterHref(0) + "#" + fileposID(noteAt) + `"`
	if !strings.Contains(toc, wantNoteLink) {
		t.Errorf("note link = %s\nwant %s", toc, wantNoteLink)
	}
}

// An offset that lands inside a tag cannot be marked without corrupting it, and
// one that points past the end is simply wrong. Neither may leave a link that
// goes nowhere, or worse, broken markup.
func TestMobiFileposThatCannotBeAnchored(t *testing.T) {
	raw := `<html><body><p><a filepos=0000000009>x</a><a filepos=0000999999>y</a></p>` +
		`<p>正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文。</p></body></html>`
	chapters := mobiChapters(raw, nil, nil)
	if len(chapters) == 0 {
		t.Fatal("no chapters")
	}
	html := chapters[0].HTML
	if strings.Contains(html, "filepos") || strings.Contains(html, "data-dead") {
		t.Errorf("an unresolvable link left something behind: %s", html)
	}
	// The markup is still well formed and the text is intact.
	if !strings.Contains(html, "正文正文") || strings.Contains(html, "<a id=\"fp999999\"") {
		t.Errorf("markup damaged: %s", html)
	}
}

// Planting must not move an offset that has not been used yet: inserting at
// the first one would shift every later one along by the length of what was
// inserted.
func TestAnchoringKeepsLaterOffsetsValid(t *testing.T) {
	body := `<p>a</p><p>b</p><p>c</p>`
	// Offsets are into the whole document, so build the head first and measure
	// against the result.
	head := fmt.Sprintf(`<a filepos=%010d>1</a><a filepos=%010d>2</a>`, 0, 0)
	doc := head + body
	first := strings.Index(doc, "<p>b")
	second := strings.Index(doc, "<p>c")
	doc = fmt.Sprintf(`<a filepos=%010d>1</a><a filepos=%010d>2</a>`, first, second) + body

	out := anchorInternalLinks(doc, nil)
	// Each anchor sits *inside* the element its offset names, so that when the
	// document is cut up it travels with that element rather than being left at
	// the tail of the piece before it.
	for _, want := range []string{
		`<p><a id="` + fileposID(first) + `"></a>b</p>`,
		`<p><a id="` + fileposID(second) + `"></a>c</p>`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("planted markup missing %q:\n%s", want, out)
		}
	}
}

// A KF8 link names a row in the fragment table and an offset from where that
// fragment goes, both base 32.
func TestKindlePosLinksResolveThroughTheFragmentTable(t *testing.T) {
	raw := `<p>见<a href="kindle:pos:fid:0002:off:0000000000">下一章</a>。</p>` +
		`<p>此段须足够长，方能自成一章而不被并入邻章之中，故多写几句凑足字数。</p>` +
		`<mbp:pagebreak/><h1>第一章</h1>` +
		`<p>正文正文正文正文正文正文正文正文正文正文，此段亦须足够长以自成一章。</p>`
	// Row 2 of the table is where the second chapter begins; rows 0 and 1 are
	// earlier positions, as a real table would hold.
	frag := []int{0, 1, strings.Index(raw, "<mbp:pagebreak/>")}

	chapters := mobiChapters(raw, nil, frag)
	if len(chapters) < 2 {
		t.Fatalf("got %d chapters, want two", len(chapters))
	}
	if strings.Contains(chapters[0].HTML, "kindle:pos") {
		t.Errorf("a raw kindle:pos link survived: %s", chapters[0].HTML)
	}
	want := `data-link="` + mobiChapterHref(1) + "#" + fileposID(frag[2]) + `"`
	if !strings.Contains(chapters[0].HTML, want) {
		t.Errorf("link = %s\nwant %s", chapters[0].HTML, want)
	}
	if !strings.Contains(chapters[1].HTML, `id="`+fileposID(frag[2])+`"`) {
		t.Errorf("anchor not planted in the target chapter: %s", chapters[1].HTML)
	}
}

// A link into the middle of a fragment lands where it points: an empty anchor
// in the run of text, which reads identically and needs no guessing about
// which element was meant.
func TestKindlePosOffsetLandsInsideTheText(t *testing.T) {
	doc := `<p><a href="kindle:pos:fid:0000:off:0000000000">见</a>此，另有正文若干以充篇幅。</p>` +
		`<p id="target">乙丙丁戊己庚辛壬癸，此段须足够长以自成一章而不被合并。</p>`
	target := strings.Index(doc, `<p id="target">`)
	// The table's row points three bytes into that paragraph's text.
	frag := []int{target + len(`<p id="target">`) + 3}

	chapters := mobiChapters(doc, nil, frag)
	if len(chapters) == 0 {
		t.Fatal("no chapters")
	}
	all := strings.Join([]string{chapters[0].HTML}, "")
	// The anchor sits within the paragraph the offset points into, at the
	// character it points at — not at the paragraph's edge.
	para := all[strings.Index(all, `<p id="target">`):]
	para = para[:strings.Index(para, "</p>")]
	if !strings.Contains(para, "<a id=") {
		t.Errorf("anchor did not land in the paragraph the offset points into:\n%s", all)
	}
	if strings.HasPrefix(para, `<p id="target"><a id=`) {
		t.Errorf("anchor snapped to the paragraph's edge instead of the offset:\n%s", para)
	}
	if !strings.Contains(all, `data-link="`) {
		t.Errorf("the link was not resolved:\n%s", all)
	}
}

// Without a fragment table — a MOBI 6 file, or one whose index could not be
// read — a KF8-style link resolves to nothing and leaves plain text behind.
func TestKindlePosWithoutAFragmentTableIsLeftAlone(t *testing.T) {
	raw := `<p><a href="kindle:pos:fid:0002:off:0000000000">下一章</a>正文正文正文正文正文正文正文。</p>`
	chapters := mobiChapters(raw, nil, nil)
	if len(chapters) == 0 {
		t.Fatal("no chapters")
	}
	if strings.Contains(chapters[0].HTML, "data-link") || strings.Contains(chapters[0].HTML, "kindle:pos") {
		t.Errorf("unresolvable link left something behind: %s", chapters[0].HTML)
	}
	if !strings.Contains(chapters[0].HTML, "下一章") {
		t.Errorf("the link's text was lost: %s", chapters[0].HTML)
	}
}

// A fragment position is a byte offset, and Chinese text is three bytes a
// character: an anchor planted where the offset happens to land can fall inside
// a character and split it. The damage does not show until the text is read
// back — SQLite rejected the column — so it is pinned here.
func TestAnchorNeverSplitsACharacter(t *testing.T) {
	prose := "乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥，此段须足够长以自成一章。"
	doc := `<p><a href="kindle:pos:fid:0000:off:0000000000">见</a>此。</p><p id="t">` + prose + `</p>`
	base := strings.Index(doc, `<p id="t">`) + len(`<p id="t">`)

	// Every byte of the paragraph's text, including the middle of characters.
	for off := 0; off < len(prose); off++ {
		chapters := mobiChapters(doc, nil, []int{base + off})
		if len(chapters) == 0 {
			t.Fatalf("off=%d: no chapters", off)
		}
		for _, c := range chapters {
			if !utf8.ValidString(c.HTML) {
				t.Fatalf("off=%d: anchoring split a character: %q", off, c.HTML)
			}
			if !utf8.ValidString(c.Text) {
				t.Fatalf("off=%d: text is no longer valid UTF-8", off)
			}
		}
		// And the prose still reads as itself once the anchor is taken out.
		joined := strings.Join([]string{chapters[0].HTML}, "")
		stripped := regexp.MustCompile(`<a id="fp\d+"></a>`).ReplaceAllString(joined, "")
		if !strings.Contains(stripped, prose) {
			t.Fatalf("off=%d: the text was altered:\n%s", off, stripped)
		}
	}
}
