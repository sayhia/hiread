package books

import (
	"encoding/binary"
	"strings"
	"testing"
)

// buildINDX assembles an index record the way a MOBI writes one: a header, the
// entries, then an IDXT block of their offsets.
func buildINDX(headerCount, total, cncx int, names []string) []byte {
	const headerLen = 0xC0
	rec := make([]byte, headerLen)
	copy(rec, "INDX")
	put := func(at, v int) { binary.BigEndian.PutUint32(rec[at:at+4], uint32(v)) }
	put(0x04, headerLen)

	offsets := make([]int, 0, len(names))
	for _, n := range names {
		offsets = append(offsets, len(rec))
		rec = append(rec, byte(len(n)))
		rec = append(rec, n...)
	}
	idxt := len(rec)
	rec = append(rec, "IDXT"...)
	for _, o := range offsets {
		var b [2]byte
		binary.BigEndian.PutUint16(b[:], uint16(o))
		rec = append(rec, b[:]...)
	}
	put(0x14, idxt)
	if len(names) > 0 {
		put(0x18, len(names)) // a data record counts its entries
	} else {
		put(0x18, headerCount) // a header record counts the data records
	}
	put(0x24, total)
	put(0x34, cncx)
	return rec
}

func indexDB(recs ...[]byte) *palmDB { return &palmDB{records: recs} }

func TestIndexNamesReadsEveryDataRecord(t *testing.T) {
	d := indexDB(
		buildINDX(2, 4, 0, nil),
		buildINDX(0, 0, 0, []string{"0000000100", "0000000200"}),
		buildINDX(0, 0, 0, []string{"0000000300", "0000000400"}),
	)
	got := d.indexNames(0)
	want := []string{"0000000100", "0000000200", "0000000300", "0000000400"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("indexNames = %v, want %v", got, want)
	}
}

// The fragment index is picked out by what it holds, since the header field
// that would name it moves between versions and vendors.
func TestFragmentIndexIsPickedByItsContents(t *testing.T) {
	// The real one: ten-digit positions reaching the end of the markup.
	frag := []([]byte){
		buildINDX(1, 3, 0, nil),
		buildINDX(0, 0, 0, []string{"0000000384", "0000004096", "0000098000"}),
	}
	// The impostor that a looser check mistakes for it: plain row numbers.
	rows := []([]byte){
		buildINDX(1, 3, 0, nil),
		buildINDX(0, 0, 0, []string{"1", "2", "3"}),
	}
	// And one that is not numeric at all.
	skel := []([]byte){
		buildINDX(1, 2, 0, nil),
		buildINDX(0, 0, 0, []string{"SKEL0000000000", "SKEL0000000001"}),
	}
	d := indexDB(rows[0], rows[1], skel[0], skel[1], frag[0], frag[1])

	got := d.kf8FragmentPositions(100000)
	want := []int{384, 4096, 98000}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

// An index whose positions stop far short of the end of the book is not the
// table of where every fragment goes, however numeric it looks.
func TestFragmentIndexMustSpanTheMarkup(t *testing.T) {
	d := indexDB(
		buildINDX(1, 3, 0, nil),
		buildINDX(0, 0, 0, []string{"0000000001", "0000000002", "0000000003"}),
	)
	if got := d.kf8FragmentPositions(1000000); got != nil {
		t.Errorf("got %v, want nothing: it covers none of the markup", got)
	}
}

func TestFragmentPositionsRejectMalformedNames(t *testing.T) {
	cases := map[string][]string{
		"not ten digits":  {"384", "4096"},
		"not digits":      {"00000003x4", "0000004096"},
		"going backwards": {"0000004096", "0000000384"},
		"past the end":    {"0000000384", "9999999999"},
	}
	for name, names := range cases {
		t.Run(name, func(t *testing.T) {
			if _, ok := ascendingPositions(names, 100000); ok {
				t.Errorf("%v read as positions", names)
			}
		})
	}
}

// A record that is not an index, or is truncated mid-entry, must yield nothing
// rather than garbage.
func TestIndexReadingIsDefensive(t *testing.T) {
	if _, ok := parseINDXHeader([]byte("not an index at all")); ok {
		t.Error("a non-INDX record parsed as one")
	}
	rec := buildINDX(0, 0, 0, []string{"0000000100", "0000000200"})
	if got := indexEntryNames(rec[:len(rec)-3]); len(got) > 1 {
		t.Errorf("a truncated IDXT yielded %v", got)
	}
	if got := (&palmDB{}).indexNames(0); got != nil {
		t.Errorf("an empty file yielded %v", got)
	}
}
