// A braille "dots" spinner for the working indicator, plus the frame-selection
// math. Pure so the cycling is unit-testable; the TUI drives it from the
// render tick (or wall-clock ms) while a turn is in progress.

/** Default spin cadence — matches pi's working-indicator default. */
export const SPINNER_INTERVAL_MS = 120;

/** Classic braille "dots" frames. */
export const SPINNER_FRAMES = [
  "\u280B",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283C",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280F",
] as const;

/**
 * The spinner frame for a given time `ms` (e.g. `Date.now()`). Cycles through
 * {@link SPINNER_FRAMES} every `intervalMs`, wrapping at the frame count.
 */
export function spinnerFrame(
  ms: number,
  intervalMs: number = SPINNER_INTERVAL_MS,
): string {
  if (intervalMs <= 0) return SPINNER_FRAMES[0]!;
  const idx = Math.floor(ms / intervalMs) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[(idx + SPINNER_FRAMES.length) % SPINNER_FRAMES.length]!;
}
