// Shared mutable state used across modules.

/**
 * Set when an approval/request notification arrives; cleared once answered.
 *
 * The callback receives the user's decision: `true` to approve, or a string
 * (redirect message) to deny with alternative instructions. When the user
 * denies without providing a message, the callback is called with `null`.
 */
export let resolveApproval:
  | ((decision: boolean | string | null) => void)
  | null = null;
export function setResolveApproval(
  fn: ((decision: boolean | string | null) => void) | null,
) {
  resolveApproval = fn;
}

/** True once rho has emitted the "ready" notification. */
export let isReady = false;
export function setReady(v: boolean) {
  isReady = v;
}

/** True while reasoning/thinking deltas are being streamed. */
export let inReasoning = false;
export function setInReasoning(v: boolean) {
  inReasoning = v;
}

/** Cached model name for display in agent/end summary and /models marker. */
export let currentModel = "";
export function setCurrentModel(v: string) {
  currentModel = v;
}

/** True while collecting multi-line paste input. */
export let inPasteMode = false;
export function setInPasteMode(v: boolean) {
  inPasteMode = v;
}

/** True while an agent turn is in progress (between `agent/start` and `agent/end`). */
export let turnInProgress = false;
export function setTurnInProgress(v: boolean) {
  turnInProgress = v;
}
