package books

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

// HUFF/CDIC is the compression the MOBI format uses when PalmDOC's LZ77 is not
// enough: a Huffman code per symbol, where each symbol expands to a phrase from
// a dictionary that may itself be compressed. It is the most intricate code in
// this package and the least likely to be exercised by whatever books happen to
// be at hand — every file tested so far was stored or PalmDOC-compressed.
//
// So the dictionary here is built by hand, with codes chosen to make the
// expected output computable: every code is 8 bits and terminal, and the tables
// are arranged so that the byte b decodes to dictionary phrase b. The decoder
// does not know any of that — it walks the same tables a real file would carry.

// huffDict1Entry encodes one dict1 slot: an 8-bit terminal code whose
// dictionary index works out to `phrase`.
//
// The decoder computes the index as (maxCode - code) >> (32 - codeLen), with
// maxCode = ((v>>8)+1)<<(32-codeLen) - 1. For an 8-bit code whose leading byte
// is b, that reduces to (v>>8) - b — so storing v>>8 = b + phrase makes the
// byte b decode to `phrase`.
func huffDict1Entry(b, phrase int) uint32 {
	const codeLen, term = 8, 0x80
	return uint32((b+phrase)<<8) | term | codeLen
}

// buildHuffRecord assembles a HUFF record: the 256-entry code table, then the
// 32 min/max pairs (unused here — every code is terminal, so the decoder never
// widens one).
func buildHuffRecord() []byte {
	var out bytes.Buffer
	out.WriteString("HUFF")
	binary.Write(&out, binary.BigEndian, uint32(0x18))       // header length
	binary.Write(&out, binary.BigEndian, uint32(0x18))       // off1: dict1
	binary.Write(&out, binary.BigEndian, uint32(0x18+256*4)) // off2: dict2
	// The header a real record carries is 24 bytes; the last two fields are
	// unused here but the tables still start where off1 says they do.
	binary.Write(&out, binary.BigEndian, uint64(0))
	for b := 0; b < 256; b++ {
		binary.Write(&out, binary.BigEndian, huffDict1Entry(b, b))
	}
	for i := 0; i < 64; i++ {
		binary.Write(&out, binary.BigEndian, uint32(0))
	}
	return out.Bytes()
}

// buildCDICRecord assembles a CDIC record holding `phrases`, each flagged as
// already decoded so the decoder emits it verbatim.
func buildCDICRecord(phrases []string) []byte {
	var body bytes.Buffer
	offsets := make([]uint16, len(phrases))
	for i, p := range phrases {
		offsets[i] = uint16(body.Len())
		binary.Write(&body, binary.BigEndian, uint16(len(p)|0x8000))
		body.WriteString(p)
	}

	var out bytes.Buffer
	out.WriteString("CDIC")
	binary.Write(&out, binary.BigEndian, uint32(0x10))
	binary.Write(&out, binary.BigEndian, uint32(len(phrases))) // total phrases
	binary.Write(&out, binary.BigEndian, uint32(8))            // 1<<8 per record
	// The offset table sits at 16, and each offset is measured from there.
	tableLen := len(phrases) * 2
	for _, off := range offsets {
		binary.Write(&out, binary.BigEndian, off+uint16(tableLen))
	}
	out.Write(body.Bytes())
	return out.Bytes()
}

// buildHuffMOBI assembles a MOBI whose text record is the given phrase indexes,
// compressed the HUFF/CDIC way.
func buildHuffMOBI(t *testing.T, phrases []string, indexes []byte, textLength int) []byte {
	t.Helper()

	const mobiHeaderLen = 0xf8
	rec0 := make([]byte, 16+mobiHeaderLen)
	binary.BigEndian.PutUint16(rec0[0:], compHuffCdic)
	binary.BigEndian.PutUint32(rec0[4:], uint32(textLength))
	binary.BigEndian.PutUint16(rec0[8:], 1) // one text record
	binary.BigEndian.PutUint16(rec0[10:], 4096)
	copy(rec0[16:], "MOBI")
	binary.BigEndian.PutUint32(rec0[20:], mobiHeaderLen)
	binary.BigEndian.PutUint32(rec0[0x1c:], 65001) // UTF-8
	binary.BigEndian.PutUint32(rec0[0x24:], 6)
	binary.BigEndian.PutUint32(rec0[0x6c:], 4) // first image record (none)
	binary.BigEndian.PutUint32(rec0[0x70:], 2) // HUFF record index
	binary.BigEndian.PutUint32(rec0[0x74:], 2) // one HUFF + one CDIC

	records := [][]byte{rec0, indexes, buildHuffRecord(), buildCDICRecord(phrases)}
	return palmDBOf(t, records)
}

func TestHuffCdicDecodesToItsDictionaryPhrases(t *testing.T) {
	phrases := []string{
		"<html><body><h1>",
		"Loomings",
		"</h1><p>",
		"Call me Ishmael.",
		"</p></body></html>",
	}
	// Byte b selects phrase b, so this spells the document out in order.
	indexes := []byte{0, 1, 2, 3, 4}

	want := strings.Join(phrases, "")
	b, err := Parse("huff.mobi", buildHuffMOBI(t, phrases, indexes, len(want)))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(b.Chapters) != 1 {
		t.Fatalf("chapters = %v", chapterTitles(b))
	}
	if b.Chapters[0].Title != "Loomings" {
		t.Errorf("title = %q", b.Chapters[0].Title)
	}
	if !strings.Contains(b.Chapters[0].Text, "Call me Ishmael.") {
		t.Errorf("text = %q", b.Chapters[0].Text)
	}
}

// A phrase may itself be compressed — the flag bit says so, and the decoder
// recurses through the same tables to expand it.
func TestHuffCdicExpandsNestedPhrases(t *testing.T) {
	// Phrase 2 is not flagged as decoded: its bytes are another code stream,
	// selecting phrases 0 and 1.
	var body bytes.Buffer
	offsets := make([]uint16, 3)
	write := func(i int, data []byte, decoded bool) {
		offsets[i] = uint16(body.Len())
		flag := 0
		if decoded {
			flag = 0x8000
		}
		binary.Write(&body, binary.BigEndian, uint16(len(data)|flag))
		body.Write(data)
	}
	write(0, []byte("<p>deep "), true)
	write(1, []byte("work</p>"), true)
	write(2, []byte{0, 1}, false) // expands to phrase 0 then phrase 1

	var cdic bytes.Buffer
	cdic.WriteString("CDIC")
	binary.Write(&cdic, binary.BigEndian, uint32(0x10))
	binary.Write(&cdic, binary.BigEndian, uint32(3))
	binary.Write(&cdic, binary.BigEndian, uint32(8))
	for _, off := range offsets {
		binary.Write(&cdic, binary.BigEndian, off+6) // 3 offsets × 2 bytes
	}
	cdic.Write(body.Bytes())

	const mobiHeaderLen = 0xf8
	rec0 := make([]byte, 16+mobiHeaderLen)
	binary.BigEndian.PutUint16(rec0[0:], compHuffCdic)
	binary.BigEndian.PutUint32(rec0[4:], 16)
	binary.BigEndian.PutUint16(rec0[8:], 1)
	binary.BigEndian.PutUint16(rec0[10:], 4096)
	copy(rec0[16:], "MOBI")
	binary.BigEndian.PutUint32(rec0[20:], mobiHeaderLen)
	binary.BigEndian.PutUint32(rec0[0x1c:], 65001)
	binary.BigEndian.PutUint32(rec0[0x24:], 6)
	binary.BigEndian.PutUint32(rec0[0x6c:], 4)
	binary.BigEndian.PutUint32(rec0[0x70:], 2)
	binary.BigEndian.PutUint32(rec0[0x74:], 2)

	// One code selecting the nested phrase.
	data := palmDBOf(t, [][]byte{rec0, {2}, buildHuffRecord(), cdic.Bytes()})

	b, err := Parse("nested.mobi", data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got := b.Chapters[0].Text; !strings.Contains(got, "deep work") {
		t.Errorf("nested phrase not expanded: %q", got)
	}
}

// A dictionary that refers to itself must stop rather than recurse forever: a
// corrupt or hostile file is still just a file the user dropped in.
func TestHuffCdicRefusesADictionaryCycle(t *testing.T) {
	var body bytes.Buffer
	var offsets [1]uint16
	offsets[0] = 0
	binary.Write(&body, binary.BigEndian, uint16(1)) // not flagged decoded
	body.WriteByte(0)                                // phrase 0 expands to phrase 0

	var cdic bytes.Buffer
	cdic.WriteString("CDIC")
	binary.Write(&cdic, binary.BigEndian, uint32(0x10))
	binary.Write(&cdic, binary.BigEndian, uint32(1))
	binary.Write(&cdic, binary.BigEndian, uint32(8))
	binary.Write(&cdic, binary.BigEndian, offsets[0]+2)
	cdic.Write(body.Bytes())

	const mobiHeaderLen = 0xf8
	rec0 := make([]byte, 16+mobiHeaderLen)
	binary.BigEndian.PutUint16(rec0[0:], compHuffCdic)
	binary.BigEndian.PutUint32(rec0[4:], 8)
	binary.BigEndian.PutUint16(rec0[8:], 1)
	binary.BigEndian.PutUint16(rec0[10:], 4096)
	copy(rec0[16:], "MOBI")
	binary.BigEndian.PutUint32(rec0[20:], mobiHeaderLen)
	binary.BigEndian.PutUint32(rec0[0x1c:], 65001)
	binary.BigEndian.PutUint32(rec0[0x24:], 6)
	binary.BigEndian.PutUint32(rec0[0x6c:], 4)
	binary.BigEndian.PutUint32(rec0[0x70:], 2)
	binary.BigEndian.PutUint32(rec0[0x74:], 2)

	data := palmDBOf(t, [][]byte{rec0, {0}, buildHuffRecord(), cdic.Bytes()})

	// The parse fails; what matters is that it returns at all, and for the
	// reason the guard exists rather than by tripping over something earlier.
	_, err := Parse("cycle.mobi", data)
	if err == nil {
		t.Fatal("expected a cyclic dictionary to be rejected")
	}
	if !strings.Contains(err.Error(), "recursion too deep") {
		t.Errorf("error = %v, want the recursion guard", err)
	}
}
