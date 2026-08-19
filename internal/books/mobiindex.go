package books

// Reading a MOBI index, for the one thing KF8 links need from it.
//
// A KF8 file's internal links look like `kindle:pos:fid:002Q:off:0000000A1B`.
// The fid is a base-32 row number in the file's *fragment index*, and each row
// of that index is stamped with the byte position in the flattened markup where
// that fragment belongs. The offset is counted from there. So resolving a link
// is: read the fragment index, take row `fid`, add `off`, and that is a
// position in the same markup this package already splits into chapters — which
// is exactly what the filepos machinery in mobi.go knows how to anchor.
//
// Indexes are stored the way every MOBI index is: a header record naming how
// many data records follow, then those data records, each holding a run of
// entries whose *names* are what we are after. Nothing here reads the tag
// values — the fragment index carries its insert position in the entry name
// itself, so the tag table can be skipped entirely.

import (
	"bytes"
	"encoding/binary"
	"strconv"
)

// indxHeader is the part of an INDX record header this file uses. Offsets are
// from the start of the record.
type indxHeader struct {
	headerLen int
	// idxtStart is where the record's IDXT block sits (data records only).
	idxtStart int
	// count is the number of entries in a data record, and the number of data
	// records in a header record.
	count int
	// total is the number of entries across the whole index (header only).
	total int
	// cncxCount is how many CNCX string records follow the data records.
	cncxCount int
}

// parseINDXHeader reads an INDX record's header, or reports that the record is
// not one.
func parseINDXHeader(rec []byte) (indxHeader, bool) {
	if len(rec) < 0x34 || !bytes.HasPrefix(rec, []byte("INDX")) {
		return indxHeader{}, false
	}
	u32 := func(at int) int { return int(binary.BigEndian.Uint32(rec[at : at+4])) }
	h := indxHeader{
		headerLen: u32(0x04),
		idxtStart: u32(0x14),
		count:     u32(0x18),
		total:     u32(0x24),
	}
	if len(rec) >= 0x38 {
		h.cncxCount = u32(0x34)
	}
	if h.headerLen < 0x30 || h.headerLen > len(rec) {
		return indxHeader{}, false
	}
	return h, true
}

// indexEntryNames reads the entry names out of one INDX *data* record, in the
// order the index holds them.
//
// The names sit in the record body; the IDXT block at the end is a table of
// their offsets. Each name is length-prefixed. Anything inconsistent — an
// offset past the end, a length that runs off the record — stops the read
// rather than guessing, since a half-read index is worse than none.
func indexEntryNames(rec []byte) []string {
	h, ok := parseINDXHeader(rec)
	if !ok || h.count == 0 {
		return nil
	}
	idxt := h.idxtStart
	if idxt+4+2*h.count > len(rec) || !bytes.HasPrefix(rec[idxt:], []byte("IDXT")) {
		return nil
	}
	out := make([]string, 0, h.count)
	for i := 0; i < h.count; i++ {
		at := int(binary.BigEndian.Uint16(rec[idxt+4+2*i : idxt+6+2*i]))
		if at <= 0 || at >= len(rec) {
			return out
		}
		n := int(rec[at])
		if at+1+n > len(rec) {
			return out
		}
		out = append(out, string(rec[at+1:at+1+n]))
	}
	return out
}

// indexNames reads a whole index: the header record at `rec` names how many
// data records follow it, and the entries are read from each in turn.
func (d *palmDB) indexNames(rec int) []string {
	head := d.record(rec)
	h, ok := parseINDXHeader(head)
	if !ok || h.count == 0 || h.count > len(d.records) {
		return nil
	}
	var out []string
	for i := 1; i <= h.count; i++ {
		names := indexEntryNames(d.record(rec + i))
		if names == nil {
			continue
		}
		out = append(out, names...)
	}
	if h.total > 0 && len(out) > h.total {
		out = out[:h.total]
	}
	return out
}

// kf8FragmentPositions returns the insert position of every fragment, in row
// order — which is what a link's fid indexes into.
//
// The index is found by what it holds rather than by a header field: the MOBI
// header's index pointers move between format versions and vendors, while the
// fragment index is unmistakable in content. Two signals together, because
// either alone picks up an impostor:
//
//   - every entry name is a byte position written as ten digits, zero-padded
//     ("0000000384"). The other numeric index in these files numbers its rows
//     plainly — "1", "2", … — which is what a looser check mistakes for
//     positions;
//   - the positions span the markup. A real fragment table's last entry lands
//     within a percent or two of the end (99.4%, 99.6%, 96.8% across the three
//     KF8 books this was built against); the impostor's covers 0.0% of it.
//
// A run that fails either check is skipped rather than half-trusted: a wrong
// position sends the reader to an arbitrary paragraph, which costs them their
// place as well as the link.
func (d *palmDB) kf8FragmentPositions(textLen int) []int {
	best := []int(nil)
	for i := 0; i < len(d.records); i++ {
		rec := d.record(i)
		if !bytes.HasPrefix(rec, []byte("INDX")) {
			continue
		}
		h, ok := parseINDXHeader(rec)
		if !ok || h.count == 0 || h.total < 2 {
			continue
		}
		// A header record is followed by its data records; a data record is
		// not itself a header, and reading one as such yields nothing usable.
		names := d.indexNames(i)
		if len(names) < 2 {
			continue
		}
		positions, ok := ascendingPositions(names, textLen)
		if !ok {
			continue
		}
		// It has to reach the end of the book to be the table of where every
		// fragment goes.
		if textLen > 0 && positions[len(positions)-1] < textLen/2 {
			continue
		}
		// Prefer the longest such index: a book with several is giving us the
		// fragment table and something smaller that happens to look like it.
		if len(positions) > len(best) {
			best = positions
		}
	}
	return best
}

// positionNameWidth is how a fragment index writes a byte position: ten
// digits, zero-padded, so every entry name is the same width.
const positionNameWidth = 10

// ascendingPositions reads entry names as byte positions, and reports whether
// they read as a fragment index at all: every name ten digits, none past the
// end of the markup, and the sequence non-decreasing.
func ascendingPositions(names []string, textLen int) ([]int, bool) {
	out := make([]int, 0, len(names))
	prev := -1
	for _, n := range names {
		if len(n) != positionNameWidth {
			return nil, false
		}
		for i := 0; i < len(n); i++ {
			if n[i] < '0' || n[i] > '9' {
				return nil, false
			}
		}
		v, err := strconv.Atoi(n)
		if err != nil || v < prev || (textLen > 0 && v > textLen) {
			return nil, false
		}
		prev = v
		out = append(out, v)
	}
	return out, true
}
