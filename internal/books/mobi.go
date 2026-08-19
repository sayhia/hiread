package books

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/PuerkitoBio/goquery"

	"hiread/internal/sanitize"
)

// mbpTagRe matches Kindle's private mbp: markup (pagebreak, frameset, section).
var mbpTagRe = regexp.MustCompile(`(?i)</?mbp:[a-z]+[^>]*>`)

// MOBI is a PalmDB database: a record table, then records. Record 0 carries the
// PalmDOC and MOBI headers plus the EXTH metadata block; the records after it
// hold the book's markup, compressed with either PalmDOC's LZ77 variant or the
// HUFF/CDIC scheme, followed by the images.
//
// AZW3 (KF8) reuses the same container with different markup inside. A file may
// hold both a legacy MOBI 6 book and a KF8 one, joined at a BOUNDARY record; we
// prefer the KF8 half, whose markup is closer to real HTML.
//
// Reference: the MOBI format notes on the MobileRead wiki, and KindleUnpack,
// which is the de-facto specification for the HUFF/CDIC decoder below.

const (
	palmHeaderLen = 78
	// compression codes in the PalmDOC header.
	compNone     = 1
	compPalmDoc  = 2
	compHuffCdic = 17480
)

func parseMOBI(data []byte) (*Book, error) {
	db, err := parsePalmDB(data)
	if err != nil {
		return nil, err
	}
	// A combo file holds MOBI 6 first and KF8 after a boundary record. KF8 has
	// the better markup, so when both are present the second half wins.
	sections := []*palmDB{db}
	if bound := db.kf8Boundary(); bound > 0 && bound < len(db.records) {
		if sub, err := db.slice(bound); err == nil {
			sections = append(sections, sub)
		}
	}
	section := sections[len(sections)-1]

	head, err := section.readHeaders()
	if err != nil {
		// A KF8 half that will not parse is not fatal while the MOBI 6 half is
		// still there.
		if len(sections) == 1 {
			return nil, err
		}
		section = sections[0]
		if head, err = section.readHeaders(); err != nil {
			return nil, err
		}
	}

	// Text comes from the half chosen above; images do not. A combo file stores
	// its images once, in the MOBI 6 half, and both halves address that one
	// pool — the KF8 header's own firstImage points past the end of it, where
	// the index and end-of-file records live. Reading images from there finds
	// none, which is how an illustrated book arrives with no pictures and no
	// cover.
	imageSection, imageHead := section, head
	if len(sections) > 1 && section != sections[0] {
		if h6, err := sections[0].readHeaders(); err == nil {
			imageSection, imageHead = sections[0], h6
		}
	}

	raw, err := section.rawML(head)
	if err != nil {
		return nil, err
	}

	// Both the markup's recindex attributes and the EXTH cover pointer address
	// image records by their position in the file, counting the ones that are
	// not images at all (index records, EOF markers). So the lookup has to stay
	// aligned with the record order, and only the resources actually stored are
	// compacted out of it — indexing a compacted slice hands back a different
	// picture, or none.
	images := imageSection.images(imageHead)
	byRecord := make([]*Resource, len(images))
	b := &Book{Metadata: head.metadata()}
	for i := range images {
		if len(images[i].Data) == 0 {
			continue
		}
		images[i].Path = fmt.Sprintf("images/%d%s", i+1, mimeExt(images[i].Mime))
		byRecord[i] = &images[i]
		b.Resources = append(b.Resources, images[i])
	}
	if c := imageHead.coverIndex(); c >= 0 && c < len(byRecord) && byRecord[c] != nil {
		cover := *byRecord[c]
		b.Cover = &cover
	}

	// KF8 addresses its internal links through a fragment table; MOBI 6 writes
	// byte offsets directly. Either way what comes out is a position in this
	// markup (see anchorInternalLinks).
	b.Chapters = mobiChapters(string(raw), byRecord, section.kf8FragmentPositions(len(raw)))
	if len(b.Chapters) == 0 {
		return nil, fmt.Errorf("mobi: no readable text")
	}
	return b, nil
}

// palmDB is a parsed PalmDB container: the raw file plus the offset of every
// record in it.
type palmDB struct {
	data    []byte
	records [][]byte
}

func parsePalmDB(data []byte) (*palmDB, error) {
	if len(data) < palmHeaderLen+8 {
		return nil, fmt.Errorf("mobi: file too short")
	}
	n := int(binary.BigEndian.Uint16(data[76:78]))
	if n == 0 {
		return nil, fmt.Errorf("mobi: no records")
	}
	if len(data) < palmHeaderLen+n*8 {
		return nil, fmt.Errorf("mobi: truncated record table")
	}
	offsets := make([]int, 0, n+1)
	for i := 0; i < n; i++ {
		off := int(binary.BigEndian.Uint32(data[palmHeaderLen+i*8:]))
		if off < 0 || off > len(data) {
			off = len(data)
		}
		offsets = append(offsets, off)
	}
	offsets = append(offsets, len(data))

	db := &palmDB{data: data}
	for i := 0; i < n; i++ {
		start, end := offsets[i], offsets[i+1]
		// Record offsets are meant to ascend; a file that breaks that rule gets
		// an empty record rather than a panic.
		if end < start {
			end = start
		}
		db.records = append(db.records, data[start:end])
	}
	return db, nil
}

// record returns record i, or nil when it does not exist.
func (d *palmDB) record(i int) []byte {
	if i < 0 || i >= len(d.records) {
		return nil
	}
	return d.records[i]
}

// kf8Boundary finds the record index where the KF8 half of a combo file begins,
// either from EXTH tag 121 or from the literal BOUNDARY record that precedes it.
func (d *palmDB) kf8Boundary() int {
	if h, err := d.readHeaders(); err == nil {
		if v, ok := h.exthInt(121); ok && int(v) < len(d.records) && v > 0 {
			return int(v)
		}
	}
	for i := len(d.records) - 1; i > 0; i-- {
		if bytes.Equal(d.records[i], []byte("BOUNDARY")) {
			return i + 1
		}
	}
	return -1
}

// slice reinterprets the records from start onwards as a standalone book, which
// is what the KF8 half of a combo file is.
func (d *palmDB) slice(start int) (*palmDB, error) {
	if start <= 0 || start >= len(d.records) {
		return nil, fmt.Errorf("mobi: bad boundary %d", start)
	}
	return &palmDB{data: d.data, records: d.records[start:]}, nil
}

// mobiHeader is the subset of record 0 the parser needs.
type mobiHeader struct {
	db          *palmDB
	rec0        []byte
	compression int
	textLength  int
	textRecords int
	encryption  int
	headerLen   int
	encoding    int
	version     int
	firstImage  int
	huffOffset  int
	huffCount   int
	extraFlags  int
	fullName    string
	exth        map[int][][]byte
}

func (d *palmDB) readHeaders() (*mobiHeader, error) {
	rec0 := d.record(0)
	if len(rec0) < 16 {
		return nil, fmt.Errorf("mobi: record 0 too short")
	}
	h := &mobiHeader{
		db:          d,
		rec0:        rec0,
		compression: int(binary.BigEndian.Uint16(rec0[0:2])),
		textLength:  int(binary.BigEndian.Uint32(rec0[4:8])),
		textRecords: int(binary.BigEndian.Uint16(rec0[8:10])),
		encryption:  int(binary.BigEndian.Uint16(rec0[12:14])),
		exth:        map[int][][]byte{},
		firstImage:  -1,
	}
	if h.encryption != 0 {
		return nil, fmt.Errorf("mobi: the file is DRM-protected")
	}
	if len(rec0) < 24 || !bytes.Equal(rec0[16:20], []byte("MOBI")) {
		// A plain PalmDOC ebook (TEXtREAd) has no MOBI header at all; its text
		// records still decompress, so keep going with the defaults.
		return h, nil
	}
	h.headerLen = int(binary.BigEndian.Uint32(rec0[20:24]))
	read32 := func(off int) int {
		if off+4 > len(rec0) || off+4 > 16+h.headerLen {
			return 0
		}
		return int(binary.BigEndian.Uint32(rec0[off : off+4]))
	}
	h.encoding = read32(0x1c)
	h.version = read32(0x24)
	h.firstImage = read32(0x6c)
	h.huffOffset = read32(0x70)
	h.huffCount = read32(0x74)
	if off, length := read32(0x54), read32(0x58); off > 0 && length > 0 && off+length <= len(rec0) {
		h.fullName = h.decodeString(rec0[off : off+length])
	}
	// extraFlags is a late addition; older headers stop before it.
	if 16+h.headerLen >= 0xf4 && len(rec0) >= 0xf4 {
		h.extraFlags = int(binary.BigEndian.Uint16(rec0[0xf2:0xf4]))
	}
	if flags := read32(0x80); flags&0x40 != 0 {
		h.readEXTH(16 + h.headerLen)
	}
	return h, nil
}

// readEXTH parses the extended header's type/length records, which is where
// author, publisher, description and the cover pointer live.
func (h *mobiHeader) readEXTH(off int) {
	rec0 := h.rec0
	if off+12 > len(rec0) || !bytes.Equal(rec0[off:off+4], []byte("EXTH")) {
		return
	}
	count := int(binary.BigEndian.Uint32(rec0[off+8 : off+12]))
	p := off + 12
	for i := 0; i < count; i++ {
		if p+8 > len(rec0) {
			return
		}
		typ := int(binary.BigEndian.Uint32(rec0[p : p+4]))
		length := int(binary.BigEndian.Uint32(rec0[p+4 : p+8]))
		if length < 8 || p+length > len(rec0) {
			return
		}
		h.exth[typ] = append(h.exth[typ], rec0[p+8:p+length])
		p += length
	}
}

func (h *mobiHeader) exthString(typ int) string {
	if v, ok := h.exth[typ]; ok && len(v) > 0 {
		return strings.TrimSpace(h.decodeString(v[0]))
	}
	return ""
}

func (h *mobiHeader) exthInt(typ int) (uint32, bool) {
	if v, ok := h.exth[typ]; ok && len(v) > 0 && len(v[0]) >= 4 {
		return binary.BigEndian.Uint32(v[0][:4]), true
	}
	return 0, false
}

// decodeString reads MOBI text in the encoding the header declares: UTF-8 when
// it says 65001, and CP1252 otherwise (which Latin-1 approximates closely
// enough for the metadata fields this is used on).
func (h *mobiHeader) decodeString(b []byte) string {
	if h.encoding == 65001 || h.encoding == 0 {
		return strings.ToValidUTF8(string(b), "")
	}
	r := make([]rune, 0, len(b))
	for _, c := range b {
		r = append(r, cp1252(c))
	}
	return string(r)
}

func (h *mobiHeader) metadata() Metadata {
	m := Metadata{
		Title:       h.exthString(503),
		Author:      h.exthString(100),
		Publisher:   h.exthString(101),
		Description: sanitize.HTMLToText(h.exthString(103)),
		Identifier:  h.exthString(104),
		Published:   h.exthString(106),
		Language:    h.exthString(524),
	}
	if m.Title == "" {
		m.Title = h.fullName
	}
	if m.Identifier == "" {
		m.Identifier = h.exthString(113)
	}
	return m
}

// coverIndex is the cover's position among the extracted images, or -1.
func (h *mobiHeader) coverIndex() int {
	if v, ok := h.exthInt(201); ok && v != 0xFFFFFFFF {
		return int(v)
	}
	if v, ok := h.exthInt(202); ok && v != 0xFFFFFFFF {
		return int(v)
	}
	return -1
}

// rawML concatenates and decompresses the text records into the book's markup.
func (d *palmDB) rawML(h *mobiHeader) ([]byte, error) {
	var dec func([]byte) ([]byte, error)
	switch h.compression {
	case compNone:
		dec = func(b []byte) ([]byte, error) { return b, nil }
	case compPalmDoc:
		dec = func(b []byte) ([]byte, error) { return palmDocUnpack(b), nil }
	case compHuffCdic:
		hc, err := d.loadHuffCdic(h)
		if err != nil {
			return nil, err
		}
		dec = hc.unpack
	default:
		return nil, fmt.Errorf("mobi: unknown compression %d", h.compression)
	}

	var out bytes.Buffer
	if h.textLength > 0 {
		out.Grow(h.textLength)
	}
	for i := 1; i <= h.textRecords; i++ {
		rec := d.record(i)
		if rec == nil {
			break
		}
		chunk, err := dec(trimTrailingEntries(rec, h.extraFlags))
		if err != nil {
			return nil, err
		}
		out.Write(chunk)
	}
	raw := out.Bytes()
	if h.textLength > 0 && h.textLength < len(raw) {
		raw = raw[:h.textLength]
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, fmt.Errorf("mobi: text records decompressed to nothing")
	}
	// Markup is UTF-8 in modern files and CP1252 in older ones.
	if h.encoding != 65001 && h.encoding != 0 {
		return []byte(h.decodeString(raw)), nil
	}
	return []byte(strings.ToValidUTF8(string(raw), "")), nil
}

// trimTrailingEntries strips the per-record trailing data (index entries and the
// multibyte-character overlap) that extraFlags announces. Left in place it
// shows up as garbage bytes spliced into the text.
func trimTrailingEntries(rec []byte, extraFlags int) []byte {
	for flags := extraFlags >> 1; flags != 0; flags >>= 1 {
		if flags&1 == 0 {
			continue
		}
		rec = rec[:len(rec)-backwardVarintSize(rec)]
	}
	if extraFlags&1 != 0 && len(rec) > 0 {
		n := int(rec[len(rec)-1]&0x3) + 1
		if n <= len(rec) {
			rec = rec[:len(rec)-n]
		}
	}
	return rec
}

// backwardVarintSize reads the size of a trailing entry, which is stored as a
// variable-length integer written backwards from the end of the record: bytes
// carry 7 bits each and the last byte of the number has the high bit set.
func backwardVarintSize(rec []byte) int {
	if len(rec) == 0 {
		return 0
	}
	v := 0
	for i := 0; i < 4 && i < len(rec); i++ {
		b := rec[len(rec)-1-i]
		v = (v << 7) | int(b&0x7f)
		if b&0x80 != 0 {
			break
		}
	}
	// The size includes the bytes that encode it.
	if v <= 0 || v > len(rec) {
		return 0
	}
	return v
}

// palmDocUnpack decompresses PalmDOC's LZ77 variant: literals, short literal
// runs, back-references, and the space-plus-letter shortcut that makes English
// text compress as well as it does.
func palmDocUnpack(in []byte) []byte {
	out := make([]byte, 0, len(in)*4)
	for i := 0; i < len(in); {
		c := in[i]
		i++
		switch {
		case c == 0:
			out = append(out, 0)
		case c <= 8:
			// The next c bytes are literal.
			n := int(c)
			if i+n > len(in) {
				n = len(in) - i
			}
			out = append(out, in[i:i+n]...)
			i += n
		case c < 0x80:
			out = append(out, c)
		case c >= 0xc0:
			out = append(out, ' ', c^0x80)
		default:
			// 0x80..0xbf: a two-byte back-reference.
			if i >= len(in) {
				return out
			}
			pair := int(c)<<8 | int(in[i])
			i++
			dist := (pair >> 3) & 0x07ff
			n := (pair & 7) + 3
			if dist == 0 || dist > len(out) {
				continue
			}
			// Copy byte by byte: runs may overlap the bytes being written.
			for k := 0; k < n; k++ {
				out = append(out, out[len(out)-dist])
			}
		}
	}
	return out
}

// huffCdic is the HUFF/CDIC decompressor. HUFF holds the Huffman code tables,
// each CDIC record a slice of the phrase dictionary that codes expand into —
// and a phrase may itself be compressed, so expansion recurses.
type huffCdic struct {
	dict1   [256]huffCode
	minCode [33]uint64
	maxCode [33]uint64
	phrases []huffPhrase
}

type huffCode struct {
	codeLen int
	term    bool
	maxCode uint64
}

type huffPhrase struct {
	data []byte
	// decoded marks a phrase that needs no further expansion, either because
	// the CDIC flagged it so or because we already expanded it.
	decoded bool
}

func (d *palmDB) loadHuffCdic(h *mobiHeader) (*huffCdic, error) {
	if h.huffCount < 1 {
		return nil, fmt.Errorf("mobi: HUFF/CDIC compression with no dictionary records")
	}
	huff := d.record(h.huffOffset)
	if len(huff) < 16 || !bytes.Equal(huff[0:4], []byte("HUFF")) {
		return nil, fmt.Errorf("mobi: bad HUFF record")
	}
	hc := &huffCdic{}
	off1 := int(binary.BigEndian.Uint32(huff[8:12]))
	off2 := int(binary.BigEndian.Uint32(huff[12:16]))
	if off1+256*4 > len(huff) || off2+64*4 > len(huff) {
		return nil, fmt.Errorf("mobi: truncated HUFF tables")
	}
	for i := 0; i < 256; i++ {
		v := binary.BigEndian.Uint32(huff[off1+i*4:])
		codeLen := int(v & 0x1f)
		if codeLen == 0 {
			return nil, fmt.Errorf("mobi: zero-length Huffman code")
		}
		hc.dict1[i] = huffCode{
			codeLen: codeLen,
			term:    v&0x80 != 0,
			maxCode: ((uint64(v>>8) + 1) << (32 - codeLen)) - 1,
		}
	}
	for i := 0; i < 32; i++ {
		mn := uint64(binary.BigEndian.Uint32(huff[off2+i*8:]))
		mx := uint64(binary.BigEndian.Uint32(huff[off2+i*8+4:]))
		hc.minCode[i+1] = mn << (32 - (i + 1))
		hc.maxCode[i+1] = ((mx + 1) << (32 - (i + 1))) - 1
	}

	for i := 1; i < h.huffCount; i++ {
		cdic := d.record(h.huffOffset + i)
		if len(cdic) < 16 || !bytes.Equal(cdic[0:4], []byte("CDIC")) {
			continue
		}
		total := int(binary.BigEndian.Uint32(cdic[8:12]))
		bits := int(binary.BigEndian.Uint32(cdic[12:16]))
		n := 1 << bits
		if rem := total - len(hc.phrases); rem < n {
			n = rem
		}
		for j := 0; j < n; j++ {
			p := 16 + j*2
			if p+2 > len(cdic) {
				break
			}
			off := int(binary.BigEndian.Uint16(cdic[p:]))
			if 16+off+2 > len(cdic) {
				break
			}
			blen := int(binary.BigEndian.Uint16(cdic[16+off:]))
			start, end := 18+off, 18+off+(blen&0x7fff)
			if end > len(cdic) || start > end {
				break
			}
			hc.phrases = append(hc.phrases, huffPhrase{data: cdic[start:end], decoded: blen&0x8000 != 0})
		}
	}
	if len(hc.phrases) == 0 {
		return nil, fmt.Errorf("mobi: empty CDIC dictionary")
	}
	return hc, nil
}

// unpack expands one compressed text record.
func (hc *huffCdic) unpack(data []byte) ([]byte, error) {
	var out bytes.Buffer
	if err := hc.unpackInto(&out, data, 0); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// maxPhraseDepth bounds dictionary recursion. A well-formed file nests one
// level; anything deeper is a corrupt or hostile dictionary cycling on itself.
const maxPhraseDepth = 8

func (hc *huffCdic) unpackInto(out *bytes.Buffer, data []byte, depth int) error {
	if depth > maxPhraseDepth {
		return fmt.Errorf("mobi: dictionary recursion too deep")
	}
	bitsLeft := len(data) * 8
	padded := make([]byte, len(data)+8)
	copy(padded, data)

	pos := 0
	x := binary.BigEndian.Uint64(padded[pos:])
	n := 32
	for {
		if n <= 0 {
			pos += 4
			if pos+8 > len(padded) {
				return nil
			}
			x = binary.BigEndian.Uint64(padded[pos:])
			n += 32
		}
		code := (x >> uint(n)) & 0xffffffff
		entry := hc.dict1[code>>24]
		codeLen, maxCode := entry.codeLen, entry.maxCode
		if !entry.term {
			for codeLen < 32 && code < hc.minCode[codeLen] {
				codeLen++
			}
			if codeLen > 32 {
				return fmt.Errorf("mobi: invalid Huffman code")
			}
			maxCode = hc.maxCode[codeLen]
		}
		n -= codeLen
		bitsLeft -= codeLen
		if bitsLeft < 0 {
			return nil
		}
		r := int((maxCode - code) >> uint(32-codeLen))
		if r < 0 || r >= len(hc.phrases) {
			return fmt.Errorf("mobi: dictionary index %d out of range", r)
		}
		p := hc.phrases[r]
		if p.decoded {
			out.Write(p.data)
			continue
		}
		if err := hc.unpackInto(out, p.data, depth+1); err != nil {
			return err
		}
	}
}

// images returns the image records that follow the text, in file order, so an
// index in the markup maps to a position in this slice.
func (d *palmDB) images(h *mobiHeader) []Resource {
	start := h.firstImage
	if start <= 0 {
		// Without a pointer, images still start after the text records.
		start = h.textRecords + 1
	}
	var out []Resource
	for i := start; i < len(d.records); i++ {
		rec := d.record(i)
		mime := sniffImage(rec)
		if mime == "" {
			// Index and end-of-file records are interleaved with images; a
			// non-image keeps its slot so indexes stay aligned.
			out = append(out, Resource{})
			continue
		}
		out = append(out, Resource{Mime: mime, Data: rec})
	}
	return out
}

func sniffImage(b []byte) string {
	switch {
	case len(b) > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte("GIF8")):
		return "image/gif"
	case len(b) > 12 && bytes.Equal(b[0:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return "image/webp"
	case bytes.HasPrefix(b, []byte("BM")):
		return "image/bmp"
	}
	return ""
}

func mimeExt(mime string) string {
	switch mime {
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/bmp":
		return ".bmp"
	default:
		return ".jpg"
	}
}

// mobiChapters splits the book's markup into chapters and rewrites its image
// references onto the data-res contract the reader resolves. byRecord is
// indexed by image-record position, with a nil for every record that held
// something other than an image.
func mobiChapters(raw string, byRecord []*Resource, frag []int) []Chapter {
	// Plant an anchor at every position the book links to, before the markup is
	// cut up and the positions stop meaning anything.
	raw = anchorInternalLinks(raw, frag)

	parts := splitMobiMarkup(raw)
	out := make([]Chapter, 0, len(parts))
	for _, part := range parts {
		html, text, title := cleanMobiFragment(part, byRecord)
		if strings.TrimSpace(text) == "" && !strings.Contains(html, "data-res=") {
			continue
		}
		out = append(out, Chapter{Title: title, HTML: html, Text: text})
	}
	return resolveFileposLinks(mergeStubChapters(out))
}

// ── filepos links ──────────────────────────────────────────────────────────
//
// A MOBI is one flat document, and its internal links — the book's own table of
// contents, its footnote markers — address their targets as a byte offset into
// it: `<a filepos=0000012345>`. Split that document into chapters and the
// offsets mean nothing, so they used to be dropped, which left every one of
// those links as plain text. In this library that is a hundred and fifty-five
// dead destinations across two books, including their tables of contents.
//
// They survive by being turned into anchors before the split: an offset that
// lands on the start of a tag gets an `<a id="fp12345">` planted there, and
// afterwards each link is rewritten to point at the chapter that anchor ended
// up in. Planting runs from the last offset backwards so that inserting text
// never moves an offset that has not been used yet.

// A MOBI 6 link carries the byte position itself.
var fileposRe = regexp.MustCompile(`(?i)\bfilepos\s*=\s*["']?0*(\d+)`)

// A KF8 link carries a row in the fragment table and an offset from where that
// fragment goes: `kindle:pos:fid:002Q:off:0000000A1B`, both base 32.
var kindlePosRe = regexp.MustCompile(`(?i)href\s*=\s*["']kindle:pos:fid:([0-9A-Za-z]+):off:([0-9A-Za-z]+)["']`)

// fileposID is the anchor id planted for a position.
func fileposID(pos int) string { return "fp" + strconv.Itoa(pos) }

// rawEdit is one change to the markup: `del` bytes at `at` replaced by `text`.
type rawEdit struct {
	at   int
	del  int
	text string
}

// anchorInternalLinks turns every internal link into an anchor-and-link pair
// the reader can follow, in a single pass over the markup.
//
// Both link forms name a byte position; the position is snapped to the element
// that owns it, an anchor is planted inside that element, and the link is
// rewritten to carry the position it now points at. Doing both together
// matters: every position indexes the markup as it arrived, so the edits are
// applied from the end backwards and no edit ever moves one still to come.
func anchorInternalLinks(raw string, frag []int) string {
	var edits []rawEdit
	planted := map[int]bool{}

	// Where each link's target lands, and the span of the attribute that will
	// be rewritten to point at it.
	type link struct {
		at, end, target int
	}
	var links []link

	for _, m := range fileposRe.FindAllStringSubmatchIndex(raw, -1) {
		n, err := strconv.Atoi(raw[m[2]:m[3]])
		if err != nil {
			continue
		}
		links = append(links, link{at: m[0], end: m[1], target: n})
	}
	for _, m := range kindlePosRe.FindAllStringSubmatchIndex(raw, -1) {
		row, err1 := strconv.ParseInt(raw[m[2]:m[3]], 32, 64)
		off, err2 := strconv.ParseInt(raw[m[4]:m[5]], 32, 64)
		if err1 != nil || err2 != nil || int(row) >= len(frag) || row < 0 {
			continue
		}
		links = append(links, link{at: m[0], end: m[1], target: frag[row] + int(off)})
	}

	for _, l := range links {
		key, insertAt := anchorPoint(raw, l.target)
		if key < 0 {
			continue // nothing to anchor: the link is left to unwrap to text
		}
		if !planted[key] {
			planted[key] = true
			edits = append(edits, rawEdit{at: insertAt, text: `<a id="` + fileposID(key) + `"></a>`})
		}
		edits = append(edits, rawEdit{at: l.at, del: l.end - l.at, text: `data-filepos="` + strconv.Itoa(key) + `"`})
	}
	return applyRawEdits(raw, edits)
}

// applyRawEdits rewrites the markup from the end backwards, so that no edit
// disturbs the position of one not yet applied.
func applyRawEdits(raw string, edits []rawEdit) string {
	if len(edits) == 0 {
		return raw
	}
	sort.SliceStable(edits, func(i, j int) bool { return edits[i].at > edits[j].at })
	var b strings.Builder
	b.Grow(len(raw) + len(edits)*24)
	// Collected back to front, then written out in order.
	pieces := make([]string, 0, len(edits)*2+1)
	prev := len(raw)
	for _, e := range edits {
		if e.at < 0 || e.at+e.del > prev {
			continue // overlaps an edit already made, or runs off the end
		}
		pieces = append(pieces, raw[e.at+e.del:prev])
		pieces = append(pieces, e.text)
		prev = e.at
	}
	b.WriteString(raw[:prev])
	for i := len(pieces) - 1; i >= 0; i-- {
		b.WriteString(pieces[i])
	}
	return b.String()
}

// afterTag returns the index just past the tag that starts at i, or -1 if it
// is unterminated. An anchor goes *inside* what a position names rather than in
// front of it: a chapter is addressed by the pagebreak or heading that begins
// it, and the split keeps that tag at the head of the new chapter — so an
// anchor planted in front of it would land at the end of the chapter before,
// and the book's own contents would send the reader to the wrong page.
func afterTag(raw string, i int) int {
	j := strings.IndexByte(raw[i:], '>')
	if j < 0 {
		return -1
	}
	return i + j + 1
}

// anchorPoint works out where to plant the anchor for a target position, and
// what to key it by so that several links to the same place share one.
//
// A position lands one of three ways:
//
//   - in the middle of text, which is the ordinary case for a link into a
//     paragraph. An empty anchor goes right there; it reads identically;
//   - inside an opening tag — a link that names an element — so the anchor
//     goes just inside that element;
//   - at a boundary between files, where the position points at a run of
//     closing tags before the element the link actually means:
//     `…</body></html><h1 aid="31">目录</h1>`. Stepping over those closings is
//     the difference between landing on the chapter and landing on the last
//     byte of the one before it.
//
// Returns (-1, -1) when there is nothing to anchor.
func anchorPoint(raw string, pos int) (key, insertAt int) {
	if pos < 0 || pos >= len(raw) {
		return -1, -1
	}
	// Inside a tag? Find the '<' that opened whatever we are standing in, and
	// check that its '>' is still ahead of us.
	inTag := -1
	if lt := strings.LastIndexByte(raw[:pos+1], '<'); lt >= 0 {
		if gt := strings.IndexByte(raw[lt:], '>'); gt >= 0 && lt+gt >= pos {
			inTag = lt
		}
	}
	if inTag < 0 {
		// In text: the anchor goes here — but a position is a *byte* offset,
		// and one that lands in the middle of a multi-byte character would
		// split it, corrupting the text either side. Back up to where the
		// character starts.
		for pos > 0 && !utf8.RuneStart(raw[pos]) {
			pos--
		}
		return pos, pos
	}
	for at := inTag; at >= 0 && at < len(raw); {
		if at+1 < len(raw) && raw[at+1] != '/' && raw[at+1] != '!' && raw[at+1] != '?' {
			end := afterTag(raw, at)
			if end < 0 {
				return -1, -1
			}
			return at, end
		}
		end := afterTag(raw, at)
		if end < 0 {
			return -1, -1
		}
		j := strings.IndexByte(raw[end:], '<')
		if j < 0 {
			return -1, -1
		}
		at = end + j
	}
	return -1, -1
}

// resolveFileposLinks gives every chapter a name of its own and turns the
// carried offsets into links to them. An offset whose anchor cannot be found —
// it did not land on a tag boundary, or its chapter held no text and was
// dropped — leaves a link to nothing, so the marker is unwrapped back to the
// plain text it was.
func resolveFileposLinks(chapters []Chapter) []Chapter {
	for i := range chapters {
		chapters[i].Href = mobiChapterHref(i)
	}
	// Where each planted anchor ended up.
	home := map[string]int{}
	idRe := regexp.MustCompile(`id="(fp\d+)"`)
	for i, c := range chapters {
		for _, g := range idRe.FindAllStringSubmatch(c.HTML, -1) {
			if _, ok := home[g[1]]; !ok {
				home[g[1]] = i
			}
		}
	}
	linkRe := regexp.MustCompile(`data-filepos="(\d+)"`)
	for i, c := range chapters {
		if !strings.Contains(c.HTML, "data-filepos=") {
			continue
		}
		chapters[i].HTML = linkRe.ReplaceAllStringFunc(c.HTML, func(match string) string {
			g := linkRe.FindStringSubmatch(match)
			n, _ := strconv.Atoi(g[1])
			id := fileposID(n)
			if idx, ok := home[id]; ok {
				return `data-link="` + mobiChapterHref(idx) + "#" + id + `"`
			}
			// No anchor: fall back to the chapter the offset sits in, if it can
			// still be told. Otherwise the attribute is dropped and the anchor
			// unwraps to text, exactly as before.
			return `data-dead="1"`
		})
		chapters[i].HTML = strings.ReplaceAll(chapters[i].HTML, ` data-dead="1"`, "")
	}
	return chapters
}

// mobiChapterHref names a chapter of a flat document. EPUB chapters are named
// by their file; a MOBI has no files, so the index is the name — and links need
// something to point at.
func mobiChapterHref(i int) string { return fmt.Sprintf("mobi/%04d", i) }

// stubChapterRunes is how little text a fragment can hold before it stops being
// a chapter in its own right. A real chapter always carries prose; anything
// this short is the heading and nothing else.
const stubChapterRunes = 30

// numberedHeading matches a heading that names a chapter's number without
// naming the chapter — "第一章", "Chapter 4", "卷二".
var numberedHeading = regexp.MustCompile(`(?i)^\s*(第\s*[0-9０-９一二三四五六七八九十百千万零两]{1,12}\s*[章节節回卷篇部集话話幕]|chapter\s+[0-9ivxlcdm]{1,8}|part\s+[0-9ivxlcdm]{1,8})\s*$`)

// mergeStubChapters folds text-less fragments into the chapter beside them.
//
// KF8 markup is one flat document, so it has to be split on headings — and a
// book that writes its chapter openings as two headings in a row
// ("<h1>第一章</h1><h1>雕版印刷术</h1>") splits between them, leaving a chapter
// that is nothing but the number. In one real 277-"chapter" book, 36% of the
// table of contents was exactly this. A fragment's content is never dropped,
// only joined to its neighbour; its title survives only when it is the missing
// number for the heading that follows.
func mergeStubChapters(in []Chapter) []Chapter {
	if len(in) < 2 {
		return in
	}
	out := make([]Chapter, 0, len(in))
	for i := 0; i < len(in); i++ {
		c := in[i]
		isStub := len([]rune(strings.TrimSpace(c.Text))) < stubChapterRunes &&
			!strings.Contains(c.HTML, "data-res=")
		switch {
		case !isStub:
			out = append(out, c)
		case i+1 < len(in):
			// Fold forward: a bare number belongs to the title that follows it.
			next := in[i+1]
			if numberedHeading.MatchString(c.Title) && next.Title != "" {
				next.Title = c.Title + " " + next.Title
			}
			next.HTML = strings.TrimSpace(c.HTML + "\n" + next.HTML)
			next.Text = strings.TrimSpace(c.Text + "\n" + next.Text)
			in[i+1] = next
		case len(out) > 0:
			// Nothing follows, so fold back into what came before.
			prev := &out[len(out)-1]
			prev.HTML = strings.TrimSpace(prev.HTML + "\n" + c.HTML)
			prev.Text = strings.TrimSpace(prev.Text + "\n" + c.Text)
		default:
			out = append(out, c)
		}
	}
	return out
}

// splitMobiMarkup cuts the flattened markup into chapter-sized pieces: at
// explicit page breaks when the book has them, at top-level headings otherwise,
// and by size as a last resort.
func splitMobiMarkup(raw string) []string {
	if parts := splitKeepingDelimiter(raw, "<mbp:pagebreak"); len(parts) > 1 {
		return parts
	}
	for _, tag := range []string{"<h1", "<h2", "<h3"} {
		if parts := splitKeepingDelimiter(raw, tag); len(parts) > 2 {
			return parts
		}
	}
	return splitBySize(raw, 40000)
}

// splitKeepingDelimiter splits on a tag opening, keeping it at the head of each
// piece so headings survive into the chapter they title.
func splitKeepingDelimiter(raw, tag string) []string {
	idx := indexAllTags(raw, tag)
	if len(idx) == 0 {
		return []string{raw}
	}
	var out []string
	prev := 0
	for _, i := range idx {
		if i > prev {
			out = append(out, raw[prev:i])
		}
		prev = i
	}
	out = append(out, raw[prev:])
	return out
}

// indexAllTags finds every occurrence of a tag opening that is a real tag —
// "<h1 " or "<h1>", never "<h10".
func indexAllTags(raw, tag string) []int {
	var out []int
	for i := 0; ; {
		j := strings.Index(raw[i:], tag)
		if j < 0 {
			return out
		}
		at := i + j
		after := at + len(tag)
		if after < len(raw) {
			c := raw[after]
			if c == '>' || c == ' ' || c == '/' || c == '\n' || c == '\r' || c == '\t' {
				out = append(out, at)
			}
		}
		i = at + len(tag)
	}
}

// splitBySize chunks markup at tag boundaries near the target size, for books
// that carry neither page breaks nor headings.
func splitBySize(raw string, size int) []string {
	if len(raw) <= size {
		return []string{raw}
	}
	var out []string
	for len(raw) > size {
		cut := strings.Index(raw[size:], "<p")
		if cut < 0 {
			break
		}
		cut += size
		out = append(out, raw[:cut])
		raw = raw[cut:]
	}
	return append(out, raw)
}

// cleanMobiFragment turns one raw fragment into reader HTML, its text, and its
// first heading (h1..h4) — the heading comes from the same parsed document, so
// a chapter never has its HTML parsed a second time just to be named.
func cleanMobiFragment(frag string, byRecord []*Resource) (html, text, title string) {
	// Kindle's mbp: elements are stripped as text before parsing, not as DOM
	// nodes after it. <mbp:pagebreak/> is not a void element as far as the HTML
	// parser is concerned, so it stays open and swallows the rest of the
	// fragment as its children — removing the node would take the chapter with
	// it.
	frag = mbpTagRe.ReplaceAllString(frag, "")

	doc, err := goquery.NewDocumentFromReader(strings.NewReader(frag))
	if err != nil {
		return "", "", ""
	}
	doc.Find("script, style, link").Remove()

	resolve := func(idx int) string {
		// Image references are 1-based indexes into the image records.
		i := idx - 1
		if i < 0 || i >= len(byRecord) || byRecord[i] == nil {
			return ""
		}
		return byRecord[i].Path
	}
	doc.Find("img").Each(func(_ int, s *goquery.Selection) {
		s.RemoveAttr("srcset")
		s.RemoveAttr("style")
		path := ""
		if v, ok := s.Attr("recindex"); ok {
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
				path = resolve(n)
			}
		}
		if path == "" {
			if src, ok := s.Attr("src"); ok {
				if n, ok := kindleEmbedIndex(src); ok {
					path = resolve(n)
				}
			}
		}
		s.RemoveAttr("recindex")
		s.RemoveAttr("src")
		if path == "" {
			s.Remove()
			return
		}
		s.SetAttr("data-res", path)
	})
	// A filepos link points at a byte offset in the flattened markup. The
	// offset survives the split — mobiChapters plants an anchor at each one
	// before splitting and rewrites these into ordinary links afterwards — so
	// it is carried through here rather than dropped. Anything left unresolved
	// is cleaned up at the end of that pass.
	doc.Find("a").Each(func(_ int, s *goquery.Selection) {
		if v, ok := s.Attr("filepos"); ok {
			// "0000012345" — Atoi reads the leading zeros without help.
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n >= 0 {
				s.SetAttr("data-filepos", strconv.Itoa(n))
			}
			s.RemoveAttr("filepos")
		}
		href, _ := s.Attr("href")
		if !strings.HasPrefix(href, "http://") && !strings.HasPrefix(href, "https://") {
			s.RemoveAttr("href")
		}
	})

	body := doc.Find("body")
	if body.Length() == 0 {
		body = doc.Selection
	}
	html, err = body.Html()
	if err != nil {
		return "", "", ""
	}
	html = strings.TrimSpace(html)
	title = collapseSpaces(strings.TrimSpace(body.Find("h1, h2, h3, h4").First().Text()))
	return html, sanitize.HTMLToText(html), title
}

// kindleEmbedIndex reads the record index out of a KF8 "kindle:embed:0001"
// URL, whose digits are base 32.
func kindleEmbedIndex(src string) (int, bool) {
	const prefix = "kindle:embed:"
	i := strings.Index(src, prefix)
	if i < 0 {
		return 0, false
	}
	v := src[i+len(prefix):]
	if j := strings.IndexAny(v, "?&#"); j >= 0 {
		v = v[:j]
	}
	n, err := strconv.ParseInt(strings.TrimSpace(v), 32, 64)
	if err != nil {
		return 0, false
	}
	return int(n), true
}

// cp1252 maps a CP1252 byte to its rune. Only 0x80..0x9f differ from Latin-1,
// and those are exactly the curly quotes and dashes publishers use constantly.
func cp1252(b byte) rune {
	if b < 0x80 || b > 0x9f {
		return rune(b)
	}
	return [32]rune{
		'€', 0x81, '‚', 'ƒ', '„', '…', '†', '‡',
		'ˆ', '‰', 'Š', '‹', 'Œ', 0x8d, 'Ž', 0x8f,
		0x90, '‘', '’', '“', '”', '•', '–', '—',
		'˜', '™', 'š', '›', 'œ', 0x9d, 'ž', 'Ÿ',
	}[b-0x80]
}
