// Prompt-construction logic, shared by the TUI input handler. Kept separate
// from the terminal layer so the idle-vs-steer decision stays pure and testable.

/**
 * Build the JSON-RPC `prompt` params for a user message. When a turn is in
 * progress, the message is sent as a steering nudge (`steer: true`) — injected
 * at the next tool-batch seam rather than queued as a separate turn.
 */
export function buildPromptParams(
  message: string,
  busy: boolean,
): Record<string, unknown> {
  return busy ? { message, steer: true } : { message };
}
