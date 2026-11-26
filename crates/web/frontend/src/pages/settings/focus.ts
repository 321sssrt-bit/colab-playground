/**
 * Scroll helper for Settings focus jumps.
 *
 * Desktop renders pages inside `.shell-main` (`overflow-y: auto`) rather than
 * scrolling `window`, so resetting both scrollable ancestors and `window` ensures
 * pinned focus cards are always brought into view.
 */

export function scrollSettingsToTop(element: HTMLElement | null): void {
  if (typeof window === "undefined") {
    return;
  }
  let node: HTMLElement | null = element?.parentElement ?? null;
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      node.scrollTo({ top: 0, behavior: "auto" });
    }
    node = node.parentElement;
  }
  window.scrollTo({ top: 0, behavior: "auto" });
  element?.scrollIntoView({ block: "nearest", behavior: "auto" });
}
