/**
 * Returns the current date as a human-readable string, e.g. "Monday, March 1, 2026".
 * Used to inject temporal context into all AI prompts.
 */
export function getCurrentDateString(): string {
  return new Date().toLocaleDateString('en', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
