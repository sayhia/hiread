// Ids whose delete sits inside a 6s undo window (backend untouched until the
// window closes). The list fetchers in api.ts post-filter these out of every
// refetch, so a mid-window invalidation — a library-changed event, a window
// focus refetch — can never resurrect an optimistically removed row (the
// "vanish → reappear → vanish" flicker). Same pattern as the highlights pane's
// pendingDeleteIds.
//
// Module-scoped on purpose: the undo timers live in the global toast store
// and keep running if the owning component unmounts.

export const pendingBookDeletes = new Set<number>();
export const pendingCollectionDeletes = new Set<number>();
export const pendingTagDeletes = new Set<number>();
