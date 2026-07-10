import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * vitest.config.ts does not set `test.globals: true` (every test file imports its own
 * describe/it/expect), so @testing-library/react's own auto-cleanup — which only engages when it
 * finds a global `afterEach` — never fires. Wiring it explicitly here is the documented manual
 * alternative and keeps every RTL test file from having to repeat it.
 */
afterEach(() => {
  cleanup();
});

/**
 * jsdom implements none of these browser APIs, and @astryxdesign/core's components reach for all
 * three unconditionally (not behind a feature you can opt out of). Every RTL test that renders an
 * Astryx component needs them, so they live here once instead of being copy-pasted into every
 * `*.test.tsx` — mirroring the polyfills @astryxdesign/core's own test suite installs per-file
 * (see e.g. its MultiSelector.test.tsx / SegmentedControl.test.tsx / CheckboxInput.test.tsx).
 */

/**
 * 1) ResizeObserver — `Text` (maxLines truncation), `Tooltip`/`Layer` positioning and the table's
 * sticky-column plugin all observe element size through a shared singleton
 * (`@astryxdesign/core/utils/sharedResizeObserver`) that calls `new ResizeObserver(...)`
 * unconditionally. Without a stub, mounting almost any Astryx component throws
 * `ReferenceError: ResizeObserver is not defined`.
 */
class ResizeObserverStub {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub;
}

/**
 * 2) matchMedia — `useTheme()` resolves `mode="system"` via `window.matchMedia('(prefers-color-scheme: dark)')`
 * on every render, even for consumers that never asked for system-mode theming.
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

/**
 * 3) Popover API + native <dialog> — every Astryx overlay (Tooltip, MultiSelector, DropdownMenu,
 * AlertDialog's underlying Dialog, ...) opens through `showPopover`/`hidePopover` or
 * `HTMLDialogElement.showModal`/`close`, none of which jsdom implements. These stubs mirror
 * @astryxdesign/core's own test setup so a layer's open/close state round-trips through the same
 * `popover-open` attribute / native `open` attribute our assertions read.
 */
beforeEach(() => {
  HTMLElement.prototype.showPopover = vi.fn(function (this: HTMLElement) {
    this.setAttribute("popover-open", "");
    const event = new Event("toggle", { bubbles: false });
    Object.defineProperty(event, "newState", { value: "open" });
    this.dispatchEvent(event);
  });
  HTMLElement.prototype.hidePopover = vi.fn(function (this: HTMLElement) {
    this.removeAttribute("popover-open");
    const event = new Event("toggle", { bubbles: false });
    Object.defineProperty(event, "newState", { value: "closed" });
    this.dispatchEvent(event);
  });
  const originalMatches = HTMLElement.prototype.matches;
  HTMLElement.prototype.matches = function (this: HTMLElement, selector: string) {
    if (selector === ":popover-open") {
      return this.hasAttribute("popover-open");
    }
    return originalMatches.call(this, selector);
  } as HTMLElement["matches"];

  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

/**
 * 4) Layout geometry — jsdom never runs layout, so every element's offsetWidth/offsetHeight is
 * always 0. `@tanstack/react-virtual` treats a 0-height viewport as "nothing is visible" and
 * deliberately renders zero virtual items (see calculateRange's `outerSize === 0` short-circuit
 * in @tanstack/virtual-core), which would make the operations table always render an empty
 * `<tbody>` in tests. A fixed non-zero viewport size is the standard workaround for testing
 * virtualized lists under jsdom.
 */
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 1200 });
