/**
 * What the page is doing, for main.log: each step is sent as it happens, so if the page ever
 * freezes the log shows what it was doing just before. Also tracks the longest stretch the page
 * was busy without a break since the last check-in. Costs nothing noticeable.
 */

const steps = new Map<string, string>()
let longestTaskMs = 0

/** Records what one part of the page is doing (`area`), e.g. ('visualizer', 'listening'). */
export function step(area: string, what: string): void {
  if (steps.get(area) === what) return
  steps.set(area, what)
  try {
    window.musicWidget.reportStep(`${area}: ${what}`)
  } catch {
    // Diagnostics must never break the page.
  }
}

/** The longest busy stretch since the last call, in ms. */
export function takeLongestTask(): number {
  const longest = Math.round(longestTaskMs)
  longestTaskMs = 0
  return longest
}

try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longestTaskMs = Math.max(longestTaskMs, entry.duration)
  }).observe({ type: 'longtask', buffered: true })
} catch {
  // Not supported: no long-task figures.
}
