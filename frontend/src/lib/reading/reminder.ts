// "You have been reading for a while."
//
// The whole difficulty is that a clock is not the thing to measure. An app
// left open over lunch has been open for an hour and read for none of it, and
// a reminder that arrives on the way back from lunch is a reminder that gets
// turned off. What counts is time the reader was there: the window in front,
// and something happening in it.
//
// So this accumulates rather than compares. Each tick adds the time since the
// last one, but only if the reader was present for it — and a tick that
// arrives after a long gap adds the gap it was asleep for, not the whole gap,
// because a laptop that was shut is not a reader who was reading.

export interface ReminderState {
  /** Reading time since the last reminder, in ms. */
  readonly read: number;
  /** When the last tick happened, or -1 before the first. */
  readonly last: number;
}

export const startReading = (): ReminderState => ({ read: 0, last: -1 });

export interface ReminderInput {
  /** Now, in ms. */
  readonly at: number;
  /** Is the window in front of the reader. */
  readonly visible: boolean;
  /** When the reader last did anything — scrolled, turned a page, pressed a
   *  key. */
  readonly lastActivity: number;
  /** After how much reading to say something. 0 means never. */
  readonly everyMs: number;
}

/** How long a reader can be still before they have stopped reading.
 *
 *  Generous on purpose: reading *is* being still. Someone on a long page with
 *  a slow eye may not touch anything for minutes and is the exact person a
 *  break reminder is for. */
export const IDLE_MS = 4 * 60_000;

/** The longest a single tick may contribute. A tick that arrives late — the
 *  machine slept, the tab was frozen — must not hand over the hours it was
 *  gone. */
export const MAX_TICK_MS = 30_000;

export interface ReminderStep {
  readonly state: ReminderState;
  /** Say something now. */
  readonly remind: boolean;
}

export function tick(state: ReminderState, input: ReminderInput): ReminderStep {
  const { at, visible, lastActivity, everyMs } = input;
  if (everyMs <= 0) return { state: { read: 0, last: at }, remind: false };
  if (state.last < 0) return { state: { read: state.read, last: at }, remind: false };

  const elapsed = Math.min(MAX_TICK_MS, Math.max(0, at - state.last));
  const present = visible && at - lastActivity <= IDLE_MS;
  const read = present ? state.read + elapsed : state.read;

  if (read >= everyMs) return { state: { read: 0, last: at }, remind: true };
  return { state: { read, last: at }, remind: false };
}
