// Shared mutable state used across modules.

/** Set when an approval/request notification arrives; cleared once answered. */
export let resolveApproval: ((approved: boolean) => void) | null = null;
export function setResolveApproval(
  fn: ((approved: boolean) => void) | null,
) {
  resolveApproval = fn;
}

/** Resolved when rho emits the "ready" notification and the banner is shown. */
export let readyResolve!: () => void;
export const readyPromise = new Promise<void>((r) => {
  readyResolve = r;
});

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
