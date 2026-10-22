// Timers that work in a popout window (Obsidian). Tests define `window` (see tests/setup.ts).
export function startTimer(fn: () => void, ms: number): number {
  return window.setTimeout(fn, ms);
}

export function stopTimer(handle: number): void {
  window.clearTimeout(handle);
}
