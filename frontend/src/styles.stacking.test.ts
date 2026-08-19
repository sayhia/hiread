// The reading overlay stacks two things that are not in the same component: the
// reader itself, and the overlay's own close button sitting in the reader's
// toolbar band. Nothing in jsdom can catch one painting over the other — there
// is no layout, so no hit testing — and the bug it caused was invisible in
// every render test: the close button was present, enabled, and wired, and
// clicking it in the running app did nothing because the toolbar was on top.
//
// What is checkable is the invariant that keeps them apart: the reader forms a
// stacking context of its own, so that whatever it stacks internally (its
// toolbar over the warm wash, its panels over both) can never compete with the
// chrome around it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Read straight off disk, so the test checks exactly the stylesheet the app
// ships rather than a copy of the numbers.
const css = readFileSync(new URL("./styles.css", import.meta.url).pathname, "utf8");

/** The declarations of the first rule whose selector list is exactly `sel`. */
function rule(sel: string): string {
  const re = new RegExp(`(^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const m = css.match(re);
  expect(m, `no rule for ${sel}`).toBeTruthy();
  return m![2];
}

describe("reading overlay stacking", () => {
  const z = (sel: string) => {
    const m = rule(sel).match(/z-index:\s*(-?\d+)/);
    expect(m, `${sel} has no z-index`).toBeTruthy();
    return Number(m![1]);
  };

  // The reader stacks in a narrow band, and the overlay's close button sits
  // *inside* the toolbar's corner. Anything in the reader that climbs above
  // the toolbar climbs above that button too, and the button silently stops
  // taking clicks — which is exactly what a warm wash placed over the toolbar
  // did.
  it("stacks the page's wash under the chrome, and the chrome under the close", () => {
    expect(z(".reader-warm")).toBeLessThan(z(".reader-toolbar"));
    expect(z(".reader-toolbar")).toBeLessThan(z(".reader-overlay-close"));
  });

  // Naming the layers one at a time only guards the layers that existed when
  // the test was written: a second toolbar arrived under a new class, sat at
  // z-index 10, and put the close button back underneath it — the same bug,
  // past the same test. So state the invariant over every layer instead.
  //
  // A layer *may* sit above the close. What it may not do is sit above the
  // close and take the pointer: the reading-progress rule is 2.5px at the very
  // top of the band and is fine there precisely because it is untouchable.
  it("lets nothing in the reader take a click that belongs to the close", () => {
    const close = z(".reader-overlay-close");
    const offenders: string[] = [];

    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selectors = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
      const body = m[2];
      const zi = body.match(/z-index:\s*(-?\d+)/);
      if (!zi || Number(zi[1]) < close) continue;
      // The overlay is the close button's own container, and the close is
      // itself; neither is competing with it.
      const subjects = selectors.split(",").map((s) => s.trim().split(/\s+/).pop() ?? "");
      const inReader = subjects.some(
        (s) =>
          /^\.reader[-\b]/.test(s) &&
          !s.startsWith(".reader-overlay-close") &&
          !/^\.reader-overlay\b/.test(s),
      );
      if (!inReader) continue;
      if (!/pointer-events:\s*none/.test(body)) offenders.push(`${selectors} (z-index ${zi[1]})`);
    }

    expect(offenders).toEqual([]);
  });

  // The drawers are the deliberate exception: they cover the whole window,
  // close button included.
  it("keeps the drawers above all of it", () => {
    expect(z(".toc-backdrop")).toBeGreaterThan(z(".reader-overlay-close"));
  });

  // And the reader must not become a stacking context of its own, or those
  // drawers would be trapped underneath the chrome they are meant to cover.
  it("does not trap the reader's drawers inside it", () => {
    expect(rule(".reader")).not.toMatch(/z-index:\s*-?\d+/);
  });
});

describe("sidebar search stays in the panel", () => {
  it("does not use width 100% on top of side margins", () => {
    const body = rule(".sidebar-search");
    expect(body).toMatch(/width:\s*auto/);
    expect(body).toMatch(/align-self:\s*stretch/);
    expect(body).not.toMatch(/width:\s*100%/);
  });
});

describe("paged chapters can turn left and right", () => {
  it("gives the paged scroller a definite page height", () => {
    // Shrink-wrapping to the chapter left columns unfragmented, so
    // ArrowLeft / ArrowRight jumped chapters.
    const body = rule(".reader-scroll.paged");
    expect(body).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/align-self:\s*stretch/);
    expect(body).toMatch(/width:\s*100%/);
    expect(body).toMatch(/padding:\s*0/);
  });

  it("does not paint a column-rule on the page edge", () => {
    const body = rule(
      ':root:not([data-reader-orientation="vertical"]) .reader-scroll.paged .article',
    );
    expect(body).toMatch(/column-rule:\s*none/);
  });

  it("pages the whole article so later pages are not indented by the head", () => {
    const page = rule(
      ':root:not([data-reader-orientation="vertical"]) .reader-scroll.paged .article',
    );
    expect(page).toMatch(/column-count:\s*var\(--reader-columns/);
    const body = rule(
      ':root:not([data-reader-orientation="vertical"]) .reader-scroll.paged .article-body',
    );
    expect(body).toMatch(/height:\s*auto/);
    expect(body).toMatch(/column-count:\s*auto/);
  });

  it("insets the 版心 with padding, not a shrink-wrapped max-width", () => {
    const body = rule(
      ':root:not([data-reader-orientation="vertical"]) .reader-scroll.paged .article-head,\n:root:not([data-reader-orientation="vertical"]) .reader-scroll.paged .article-body > *,\n:root:not([data-reader-orientation="vertical"]) .reader-scroll.paged .chapter-summary,\n:root:not([data-reader-orientation="vertical"]) .reader-scroll.paged .tr-toggle,\n:root:not([data-reader-orientation="vertical"]) .reader-scroll.paged .link-back,\n:root:not([data-reader-orientation="vertical"]) .reader-scroll.paged .chapter-nav',
    );
    expect(body).toMatch(/padding-inline:\s*max\(/);
    expect(body).toMatch(/max-width:\s*none/);
  });
});

describe("vertical (古籍) columns stay native wrap", () => {
  it("does not put CSS column-count back on a 古籍 chapter", () => {
    // A later un-gated `.reader-scroll .article-body { column-count }` used
    // to win on specificity and make 古籍 crawl again.
    expect(css).not.toMatch(
      /(?:^|\})\s*\.reader-scroll \.article-body\s*\{[^}]*column-count/,
    );
    expect(css).toMatch(
      /:root:not\(\[data-reader-orientation="vertical"\]\) \.reader-scroll \.article-body/,
    );
  });
});

// The chrome and the chapter dock get out of the way as the reader reads. Out
// of the way meant faded and moved off — which is out of *sight* and nothing
// more: an opacity-0 button still answers Tab. A reader who scrolled the bar
// away and pressed Tab put the focus ring somewhere off-screen, and Enter then
// fired a control they could not see.
describe("what the reader hides", () => {
  it("takes the focus-mode bar out of the focus order, not just out of sight", () => {
    const body = rule(':root[data-focus="true"] .reader-chrome');
    expect(body).toMatch(/visibility:\s*hidden/);
    expect(body).toMatch(/transition:[^;]*visibility\s+0s\s+linear\s+\.?\d/);
  });

  for (const sel of [".reader-chrome.hidden"]) {
    it(`takes ${sel.split(".")[1]} out of the focus order, not just out of sight`, () => {
      const body = rule(sel);
      expect(body).toMatch(/visibility:\s*hidden/);
      // Held until the fade is over, so hiding still animates. Showing must not
      // be delayed in turn — that is the base rule's job, checked below.
      expect(body).toMatch(/transition:[^;]*visibility\s+0s\s+linear\s+\.?\d/);
    });

    it(`brings ${sel.split(".")[1]} straight back`, () => {
      const shown = rule(sel.replace(".hidden", ""));
      expect(shown).toMatch(/visibility:\s*visible/);
      // No delay on the way in, or the bar would still be untouchable for a
      // fifth of a second after the reader asked for it.
      expect(shown).toMatch(/transition:[^;]*visibility\s+0s\s*(,|;|$)/);
    });
  }
});

// The reading chrome belongs to the window. Following --reader-width made
// the clusters walk in and out as the user dragged the measure slider.
describe("the reading toolbar stays put", () => {
  /** The declarations of every rule whose selector list mentions `sel`. */
  const rulesFor = (sel: string) =>
    [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((m) => m[1].includes(sel))
      .map((m) => m[2]);

  const bar = rulesFor(".reader-toolbar-v2");

  it("does not follow the reading column", () => {
    for (const b of bar) {
      expect(b, "toolbar padding still tracks the measure").not.toMatch(/--reader-width/);
      expect(b, "toolbar padding still tracks the side margin").not.toMatch(/--reader-pad-x/);
    }
  });

  it("still clears what is overlaid in the corners", () => {
    const hasPx = (px: number) =>
      bar.some((b) => new RegExp(`${px}px`).test(b));
    expect(hasPx(16), "no default window padding").toBe(true);
    expect(hasPx(40), "the overlay's close button is no longer cleared").toBe(true);
    expect(hasPx(100), "the macOS traffic lights are no longer cleared").toBe(true);
  });
});
