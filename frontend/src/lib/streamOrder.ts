// Reassembles sequence-numbered streaming events back into emit order.
//
// Wails v3 (alpha) dispatches every backend `Emit` on its own goroutine
// (application.EventProcessor.Emit), so consecutive emits to one listener race
// and can arrive out of order. For an AI token stream — where a local model
// emits many tiny deltas back-to-back with no inter-token pause — that shuffles
// the characters and the rendered text comes out scrambled. The reordering is
// inside Wails and cannot be fixed Go-side, so the backend stamps each event
// with a monotonic per-stream sequence number (internal/events.Sequencer) and
// this buffer restores the original order before anything reaches the consumer.
//
// Pure and DOM-free so it is unit-testable in node; `stream()` in api.ts owns
// the Wails subscription and feeds (seq, data) pairs in here.

/** A reorder buffer for one stream. `push` releases a contiguous run of events
 *  in sequence order as their gaps fill; `flush` drains whatever is left when
 *  the stream ends. Sequence numbers are 1-based to match events.Sequencer. */
export interface ReorderBuffer<T> {
  /** Accept an out-of-order event; delivers every event now made contiguous. */
  push(seq: number, data: T): void;
  /** Deliver any still-buffered tail in sequence order (e.g. on stream end). */
  flush(): void;
}

export function createReorderBuffer<T>(onEvent: (e: T) => void): ReorderBuffer<T> {
  // `next` is the sequence number we may deliver now; events that arrive ahead
  // of a gap wait in `pending` until the gap before them fills in.
  let next = 1;
  const pending = new Map<number, T>();

  return {
    push(seq, data) {
      if (seq < next) return; // a duplicate of something already delivered
      pending.set(seq, data);
      while (pending.has(next)) {
        onEvent(pending.get(next)!);
        pending.delete(next);
        next++;
      }
    },
    flush() {
      // A non-empty buffer here means an out-of-order tail (or, pathologically,
      // a dropped seq leaving a gap). Deliver it in seq order so nothing is
      // lost — better a rare slightly-misordered tail than a dropped token.
      for (const seq of [...pending.keys()].sort((a, b) => a - b)) onEvent(pending.get(seq)!);
      pending.clear();
    },
  };
}
