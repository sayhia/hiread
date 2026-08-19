package translate

// How a chapter is cut into batches.
//
// The old rule was a fixed byte budget, inherited from an RSS reader where an
// article was one or two batches either way. Two things are wrong with bytes.
//
// A Han character is three bytes and one token, so the same budget cut a
// Chinese chapter about three times finer than an English one — for the same
// amount of work asked of the model. What the budget is really protecting is
// the output token cap, so it should be counted in tokens.
//
// And a fixed size is the wrong shape. With n batches, concurrency C and a
// model writing at R tokens a second, a chapter of T output tokens takes
// ceil(n/C) × (T/n)/R. Below the concurrency cap that falls as n rises — eight
// small batches at once beat four large ones, for the same total tokens —
// and above it, it flattens out at T/(C·R). So the batch to aim for is the one
// that puts the whole chapter in flight at once, with bounds either side: not
// so small that the per-request overhead dominates, and not so large that the
// answer risks hitting the output cap.

import (
	"unicode"
	"unicode/utf8"
)

// Batch sizing for the LLM path, in estimated source tokens.
const (
	// minBatchTokens keeps a chapter from being shredded into requests whose
	// round-trip costs more than the text in them.
	minBatchTokens = 300
	// maxBatchTokens bounds what one answer has to fit. Paired with
	// translateMaxTokens through outputRatio, with headroom to spare.
	maxBatchTokens = 2500
	// outputRatio is how much bigger a translation is than its source, in
	// tokens: the text itself plus the markup echoed around it. Chinese into
	// English lands near 1.5; the margin covers the other direction, where one
	// English token becomes several Han characters and each is a token.
	outputRatio = 3
	// minOutputTokens is the floor for a request's output cap: small batches
	// still ask for room to breathe, and a local model is never handed a cap
	// so tight it truncates a paragraph.
	minOutputTokens = 1024
)

// estimateTokens approximates the tokens a fragment costs. Han, Kana and Hangul
// are about one token per character; everything else averages a token per four
// bytes. It is a rough count on purpose — it decides batch sizes, and every
// place it is used has a bound around it.
func estimateTokens(s string) int {
	wide, rest := 0, 0
	for _, r := range s {
		if isWideScript(r) {
			wide++
			continue
		}
		rest += utf8.RuneLen(r)
	}
	return wide + (rest+3)/4
}

// isWideScript reports whether a rune is from a script whose characters are
// roughly one token each.
func isWideScript(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
}

// planBatches cuts a chapter into the batches to translate, aiming to put the
// whole chapter in flight at once without spilling into a second round: ten
// batches through a window of eight is two rounds, and slower than eight, for
// exactly the same tokens. Greedy packing of whole blocks cannot hit a batch
// count exactly, so the budget is raised until the plan fits the window (or
// until a batch would be more than one answer can hold).
//
// The machine-translation engines keep their byte budgets, and their smaller
// first batch: what bounds them is request size — Google's carries the text in
// a URL — and they do not stream, so the top of the chapter arriving early
// still means something there.
func planBatches(htmlStr, engine string, concurrency int) []string {
	if engine != "llm" {
		budget := chunkBudget(engine)
		return chunkBlocksBudgeted(htmlStr, budget, min(budget, firstChunkBudget), byteCost)
	}
	pieces := topLevelPieces(htmlStr)
	total := 0
	for _, p := range pieces {
		total += estimateTokens(p)
	}
	budget := clamp((total+concurrency-1)/concurrency, minBatchTokens, maxBatchTokens)
	for {
		batches := packPieces(pieces, budget, budget, estimateTokens)
		if len(batches) <= concurrency || budget >= maxBatchTokens {
			return batches
		}
		// Overshot: give each batch the average of what the overshoot implies,
		// plus a little, and pack again. This converges in a couple of rounds.
		budget = clamp(budget+budget/4+1, minBatchTokens, maxBatchTokens)
	}
}

// batchMaxTokens sizes one request's output cap to the batch it carries, rather
// than asking every request for the maximum. A small batch asking for a huge
// cap is what a local model with a modest limit rejects outright.
func batchMaxTokens(batch string) int {
	return clamp(estimateTokens(batch)*outputRatio, minOutputTokens, translateMaxTokens)
}

func byteCost(s string) int { return len(s) }

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
