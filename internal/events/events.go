// Package events is a thin, panic-safe wrapper over the Wails application event
// bus. Backend code emits frontend events through Emit; when no Wails
// application is running (unit tests, headless tools) it is a no-op, so service
// logic stays testable without a live window.
//
// This is hiread's replacement for Tauri's app.emit / ipc::Channel: a streaming
// backend operation emits a uniquely-named event per request and the frontend
// subscribes/unsubscribes with Events.On / Events.Off.
package events

import (
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Emit publishes a named event with an optional data payload to all frontend
// listeners. It recovers from any panic raised when no application singleton is
// initialized, so callers never need to guard the call site.
func Emit(name string, data ...any) {
	defer func() { _ = recover() }()
	app := application.Get()
	if app == nil {
		return
	}
	app.Event.Emit(name, data...)
}

// Sequencer stamps every event on one named stream with a monotonically
// increasing sequence number, wrapped around the payload as a Seq envelope.
//
// Why this exists: Wails v3 (alpha) dispatches each Emit on its own goroutine
// (application.EventProcessor.Emit spawns `go dispatchEventToWindows`), so two
// emits to the same listener race and can reach the frontend out of order. A
// token stream is the worst case — a local model emits many tiny deltas
// back-to-back with no inter-token pause, so a burst of delivery goroutines run
// in scheduler order, not emit order, and the rendered text comes out with its
// characters shuffled. The reordering happens inside Wails after Emit returns,
// so it can't be fixed by serializing the Go call site; instead each per-request
// stream emits through a Sequencer and the frontend (stream() in api.ts) buffers
// by Seq.N and releases a contiguous prefix, restoring emit order.
//
// Use one Sequencer per stream (its counter is per-instance). Broadcast events
// with no ordering requirement (e.g. "feeds-updated") keep using Emit directly.
type Sequencer struct {
	name string
	seq  atomic.Uint64
}

// NewSequencer returns a Sequencer that publishes on the given event name.
func NewSequencer(name string) *Sequencer {
	return &Sequencer{name: name}
}

// Emit wraps data with the next sequence number and publishes it. Safe for
// concurrent use, though in practice a stream emits from a single goroutine.
func (s *Sequencer) Emit(data any) {
	Emit(s.name, Seq{N: s.seq.Add(1), Data: data})
}

// Seq is the envelope a Sequencer publishes: a per-stream sequence number plus
// the original event payload. The frontend reorders on N before delivering Data.
type Seq struct {
	N    uint64 `json:"seq"`
	Data any    `json:"data"`
}
