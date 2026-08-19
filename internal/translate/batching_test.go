package translate

import (
	"strings"
	"testing"
)

// The byte budget cut Chinese about three times finer than English for the same
// amount of work, because a Han character is three bytes and one token.
func TestEstimateTokensCountsScriptsFairly(t *testing.T) {
	han := strings.Repeat("汉", 100)
	if got := estimateTokens(han); got != 100 {
		t.Errorf("100 Han characters = %d tokens, want 100", got)
	}
	// The same text by bytes would look three times as large.
	if len(han) != 300 {
		t.Fatalf("fixture is not 3 bytes per character: %d", len(han))
	}

	ascii := strings.Repeat("a", 400)
	if got := estimateTokens(ascii); got != 100 {
		t.Errorf("400 ASCII bytes = %d tokens, want 100", got)
	}

	for _, s := range []string{"かな", "カナ", "한글"} {
		if got := estimateTokens(s); got != len([]rune(s)) {
			t.Errorf("estimateTokens(%q) = %d, want one per character", s, got)
		}
	}
	if estimateTokens("") != 0 {
		t.Error("an empty fragment costs nothing")
	}
}

// Below the concurrency cap, wall clock falls as batches get smaller: eight in
// flight beat four, for the same total tokens. So the aim is to put the whole
// chapter in flight at once.
func TestPlanBatchesFillsTheConcurrencyWindow(t *testing.T) {
	// A chapter of 40 paragraphs, 200 Han characters each: 8000 source tokens.
	var sb strings.Builder
	for i := 0; i < 40; i++ {
		sb.WriteString("<p>" + strings.Repeat("汉", 200) + "</p>")
	}
	batches := planBatches(sb.String(), "llm", 8)

	// The whole chapter goes out at once: no batch is left for a second round,
	// which would cost another full request's worth of waiting.
	if len(batches) > 8 {
		t.Errorf("got %d batches through a window of 8: that is two rounds", len(batches))
	}
	if len(batches) < 6 {
		t.Errorf("got %d batches, want the window filled", len(batches))
	}
	for i, b := range batches {
		if got := estimateTokens(b); got > maxBatchTokens {
			t.Errorf("batch %d = %d tokens, over the %d bound", i, got, maxBatchTokens)
		}
	}
	// Nothing is lost or duplicated in the cutting.
	if joined := strings.Join(batches, ""); strings.Count(joined, "<p>") != 40 {
		t.Errorf("got %d paragraphs back, want 40", strings.Count(joined, "<p>"))
	}
}

// A chapter too big to fit the window at once is bounded by the answer size a
// single request can be asked for, not by the window.
func TestPlanBatchesBoundsAHugeChapter(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < 400; i++ {
		sb.WriteString("<p>" + strings.Repeat("汉", 200) + "</p>")
	}
	batches := planBatches(sb.String(), "llm", 8)
	if len(batches) <= 8 {
		t.Fatalf("got %d batches for an 80k-token chapter, want it split further", len(batches))
	}
	for i, b := range batches {
		if got := estimateTokens(b); got > maxBatchTokens {
			t.Errorf("batch %d = %d tokens, over the %d bound", i, got, maxBatchTokens)
		}
		if want := batchMaxTokens(b); want > translateMaxTokens {
			t.Errorf("batch %d would ask for %d output tokens, over the %d cap", i, want, translateMaxTokens)
		}
	}
}

// A short chapter is one request: splitting it would only add round-trips.
func TestPlanBatchesKeepsAShortChapterWhole(t *testing.T) {
	batches := planBatches("<p>"+strings.Repeat("汉", 120)+"</p>", "llm", 8)
	if len(batches) != 1 {
		t.Errorf("got %d batches for a 120-token chapter, want 1", len(batches))
	}
}

// The machine-translation engines are bounded by request size, not tokens —
// Google's carries the text in a URL — so they keep their byte budgets.
func TestPlanBatchesKeepsByteBudgetsForMachineTranslation(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < 40; i++ {
		sb.WriteString("<p>" + strings.Repeat("汉", 200) + "</p>")
	}
	batches := planBatches(sb.String(), "google", 2)
	for i, b := range batches {
		if len(b) > chunkBudget("google")+700 {
			t.Errorf("google batch %d is %d bytes, over its URL budget", i, len(b))
		}
	}
}

// What a request asks for has to leave room for the answer, and has to stay
// inside a cap a modest endpoint will accept.
func TestBatchMaxTokensTracksTheBatch(t *testing.T) {
	small := "<p>" + strings.Repeat("汉", 10) + "</p>"
	if got := batchMaxTokens(small); got != minOutputTokens {
		t.Errorf("a tiny batch asks for %d, want the %d floor", got, minOutputTokens)
	}

	mid := "<p>" + strings.Repeat("汉", 1000) + "</p>"
	if got := batchMaxTokens(mid); got <= minOutputTokens || got >= translateMaxTokens {
		t.Errorf("a mid batch asks for %d, want it sized between the floor and the cap", got)
	}
	if got, src := batchMaxTokens(mid), estimateTokens(mid); got < src*2 {
		t.Errorf("asked for %d output tokens for %d source tokens: too little room to translate", got, src)
	}

	huge := "<p>" + strings.Repeat("汉", maxBatchTokens*2) + "</p>"
	if got := batchMaxTokens(huge); got != translateMaxTokens {
		t.Errorf("a batch over the bound asks for %d, want the %d cap", got, translateMaxTokens)
	}
}

// The bound on a batch and the cap on its answer have to agree: the largest
// batch the planner will produce must still fit under the output cap.
func TestTheLargestBatchFitsUnderTheOutputCap(t *testing.T) {
	if maxBatchTokens*outputRatio > translateMaxTokens {
		t.Fatalf("a full %d-token batch asks for %d output tokens, over the %d cap",
			maxBatchTokens, maxBatchTokens*outputRatio, translateMaxTokens)
	}
}

// The greedy packer cannot hit a batch count exactly, so the planner raises the
// budget until the plan fits the window. Whatever the shape of the chapter —
// many small blocks, a few big ones, one enormous one — it must never come back
// with more batches than the window unless a batch would exceed what one answer
// can hold.
func TestPlanBatchesNeverOverflowsTheWindowItCanFit(t *testing.T) {
	shapes := map[string]string{
		"many tiny blocks":      strings.Repeat("<p>"+strings.Repeat("汉", 40)+"</p>", 60),
		"uneven blocks":         strings.Repeat("<p>"+strings.Repeat("汉", 40)+"</p><p>"+strings.Repeat("汉", 700)+"</p>", 8),
		"a handful of big ones": strings.Repeat("<p>"+strings.Repeat("汉", 1200)+"</p>", 6),
		"english prose":         strings.Repeat("<p>"+strings.Repeat("word ", 300)+"</p>", 30),
	}
	for name, html := range shapes {
		t.Run(name, func(t *testing.T) {
			batches := planBatches(html, "llm", 8)
			fits := true
			for _, b := range batches {
				if estimateTokens(b) >= maxBatchTokens {
					fits = false // a batch is at the bound; more of them is correct
				}
			}
			if fits && len(batches) > 8 {
				t.Errorf("got %d batches through a window of 8, none of them at the size bound", len(batches))
			}
			if joined := strings.Join(batches, ""); len(joined) != len(html) {
				t.Errorf("the plan is %d bytes, the chapter is %d: blocks were lost or duplicated",
					len(joined), len(html))
			}
		})
	}
}

// One block too large for any batch is its own batch rather than being cut in
// half — a block is the unit the model is asked to translate.
func TestPlanBatchesKeepsAnOversizedBlockWhole(t *testing.T) {
	huge := "<p>" + strings.Repeat("汉", maxBatchTokens*3) + "</p>"
	batches := planBatches(huge, "llm", 8)
	if len(batches) != 1 || batches[0] != huge {
		t.Errorf("got %d batches, want the one block intact", len(batches))
	}
	// And its request asks for everything it can.
	if got := batchMaxTokens(batches[0]); got != translateMaxTokens {
		t.Errorf("asks for %d output tokens, want the %d cap", got, translateMaxTokens)
	}
}
