// The toast store is a single slot. A later info/error toast must not steal
// the Undo button from an in-flight withUndo — the 6s commit still runs, and
// the waiting pill only appears once the action toast is gone.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../api", () => ({
  setSetting: vi.fn(async () => {}),
  refreshTray: vi.fn(async () => {}),
}));
vi.mock("@wailsio/runtime", () => ({
  Events: { On: () => () => {} },
}));

import { useToasts, toast, reportError, withUndo } from "./toasts";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toast helpers", () => {
  it("show and error occupy the one slot", () => {
    const store = useToasts();
    toast.show("saved", "⌘S");
    expect(store.current?.text).toBe("saved");
    expect(store.current?.kbd).toBe("⌘S");
    expect(store.current?.tone).toBe("default");
    expect(store.current?.action).toBeUndefined();

    toast.error("failed");
    expect(store.current?.text).toBe("failed");
    expect(store.current?.tone).toBe("error");
  });

  it("reportError writes an error pill from a caught value", () => {
    const store = useToasts();
    reportError(new Error("disk full"));
    expect(store.current?.tone).toBe("error");
    expect(store.current?.text).toBe("disk full");
  });

  it("dismiss only clears the matching id", () => {
    const store = useToasts();
    const id = toast.show("a");
    store.dismiss(id + 1);
    expect(store.current?.text).toBe("a");
    store.dismiss(id);
    expect(store.current).toBeNull();
  });
});

describe("withUndo vs a later toast", () => {
  it("applies now, commits after 6s, and Undo reverts instead", () => {
    const apply = vi.fn();
    const commit = vi.fn();
    const revert = vi.fn();
    withUndo({ text: "deleted", apply, commit, revert });
    expect(apply).toHaveBeenCalledOnce();
    expect(useToasts().current?.action?.label).toBeTruthy();

    vi.advanceTimersByTime(5999);
    expect(commit).not.toHaveBeenCalled();
    useToasts().current?.action?.run();
    vi.advanceTimersByTime(2);
    expect(commit).not.toHaveBeenCalled();
    expect(revert).toHaveBeenCalledOnce();
  });

  it("does not let toast.show steal the Undo pill", () => {
    const commit = vi.fn();
    withUndo({ text: "deleted", apply: () => {}, commit, revert: () => {} });
    const undoId = useToasts().current!.id;
    toast.show("copied");
    expect(useToasts().current?.id).toBe(undoId);
    expect(useToasts().current?.text).toBe("deleted");
    expect(useToasts().current?.action).toBeTruthy();

    vi.advanceTimersByTime(6000);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("does not let reportError steal the Undo pill", () => {
    withUndo({ text: "deleted", apply: () => {}, commit: () => {}, revert: () => {} });
    const undoId = useToasts().current!.id;
    reportError("nope");
    expect(useToasts().current?.id).toBe(undoId);
    expect(useToasts().current?.action).toBeTruthy();
  });

  it("shows the waiting toast once the Undo pill is dismissed", () => {
    withUndo({ text: "deleted", apply: () => {}, commit: () => {}, revert: () => {} });
    const undoId = useToasts().current!.id;
    toast.show("copied");
    reportError("nope");
    useToasts().dismiss(undoId);
    expect(useToasts().current?.text).toBe("nope");
    expect(useToasts().current?.tone).toBe("error");
    expect(useToasts().current?.action).toBeUndefined();
  });

  it("drops a waiting toast if it is dismissed by id before it is shown", () => {
    withUndo({ text: "deleted", apply: () => {}, commit: () => {}, revert: () => {} });
    const undoId = useToasts().current!.id;
    const waiting = toast.show("copied");
    useToasts().dismiss(waiting);
    useToasts().dismiss(undoId);
    expect(useToasts().current).toBeNull();
  });

  it("lets a new Undo take the slot", () => {
    withUndo({ text: "first", apply: () => {}, commit: () => {}, revert: () => {} });
    withUndo({ text: "second", apply: () => {}, commit: () => {}, revert: () => {} });
    expect(useToasts().current?.text).toBe("second");
    expect(useToasts().current?.action).toBeTruthy();
  });
});
