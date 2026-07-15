// Slash command implementations. Each takes optional args and uses the RPC
// transport to communicate with rho.

import { bold, cyan, dim, gray, green, red, reset, yellow } from "./ansi.ts";
import { requestResponse, sendRequest } from "./rpc.ts";
import { resetMarkdown } from "./markdown.ts";
import { currentModel, setCurrentModel, setInPasteMode } from "./state.ts";

// ── Command registry ────────────────────────────────────────────────────────
// Single source of truth for slash commands: each entry drives both `/help`
// (via printHelp) and dispatch (via dispatchCommand), so the two cannot drift.
// `/quit` and `/abort` are intentionally NOT here — they are handled early in
// the read loop (`/quit` terminates; `/abort` must work during an approval
// prompt) and are listed manually in the help output.

/** A dispatchable slash command. */
export type Command = {
  /** Exact dispatch token, e.g. `"/model"`. */
  name: string;
  /** Display form with arg hint, e.g. `"/model [id]"`. Defaults to `name`. */
  usage?: string;
  /** One-line description shown in `/help`. */
  help: string;
  /** Handler invoked with the raw arg string (possibly empty). */
  run: (args: string) => void | Promise<void>;
};

/** Request a context compaction (fire-and-forget RPC). */
function compactRequest() {
  sendRequest("compact");
  console.log(`${gray}compaction requested${reset}`);
}

export const commands: Command[] = [
  {
    name: "/model",
    usage: "/model [id]",
    help: "Show or switch the active model",
    run: cmdModel,
  },
  { name: "/models", help: "List models from all providers", run: cmdModels },
  { name: "/providers", help: "List configured providers", run: cmdProviders },
  {
    name: "/stats",
    help: "Show session stats (context, tokens, cost)",
    run: cmdStats,
  },
  {
    name: "/tools",
    help: "List registered tools with risk levels",
    run: cmdTools,
  },
  {
    name: "/extensions",
    help: "List loaded extensions and their tools",
    run: cmdExtensions,
  },
  { name: "/sessions", help: "List previous sessions", run: cmdSessions },
  { name: "/messages", help: "Show conversation messages", run: cmdMessages },
  { name: "/clear", help: "Clear conversation history", run: cmdClear },
  { name: "/new", help: "Start a fresh session", run: cmdNewSession },
  {
    name: "/resume",
    usage: "/resume <path>",
    help: "Resume a previous session",
    run: cmdResume,
  },
  {
    name: "/compact",
    help: "Compact conversation context",
    run: compactRequest,
  },
  { name: "/reload", help: "Reload extensions", run: cmdReload },
  {
    name: "/paste",
    help: "Enter multi-line text (end with a lone .)",
    run: cmdPaste,
  },
  { name: "/help", help: "Show this help", run: printHelp },
];

const commandMap = new Map(commands.map((c) => [c.name, c]));

/** Run a slash command by name. Returns `false` if no command matches. */
export async function dispatchCommand(
  cmd: string,
  args: string,
): Promise<boolean> {
  const command = commandMap.get(cmd);
  if (!command) return false;
  await command.run(args);
  return true;
}

/** Print the command list, generated from the registry so it can't drift. */
export function printHelp() {
  const W = 14; // display column width (longest: "/resume <path>")
  console.log(`\n${bold}Commands${reset}`);
  for (const c of commands) {
    console.log(`  ${cyan}${(c.usage ?? c.name).padEnd(W)}${reset} ${c.help}`);
  }
  console.log(`  ${cyan}${"/quit".padEnd(W)}${reset} Exit rho-code`);
  console.log(
    `  ${cyan}${"/abort".padEnd(W)}${reset} Cancel the current agent turn`,
  );
  console.log("");
}

export async function cmdModel(args: string) {
  if (!args) {
    const state = await requestResponse("getState") as {
      model: string;
      provider: string;
    };
    console.log(
      `${cyan}${state.model}${reset} ${gray}(provider: ${
        state.provider || "default"
      })${reset}`,
    );
    return;
  }

  // Switch model. The backend rejects unknown models/providers with a
  // JSON-RPC error (see `App::set_model`); surface that as a failed switch
  // instead of falsely reporting success.
  try {
    const result = await requestResponse("setModel", { model: args }) as {
      model: string;
      provider: string;
    };
    setCurrentModel(result.model);
    console.log(
      `${green}switched${reset} to ${cyan}${result.model}${reset} ${gray}(provider: ${
        result.provider || "default"
      })${reset}`,
    );
  } catch (e) {
    const message = (e as { message?: string })?.message ?? JSON.stringify(e);
    console.log(`${red}not switched${reset}: ${message}`);
    console.log(`${gray}(model left unchanged)${reset}`);
  }
}

export async function cmdModels() {
  const result = await requestResponse("listModels") as {
    models: Array<{ id: string; provider: string }>;
  };
  if (result.models.length === 0) {
    console.log(
      `${gray}no models discovered (providers may not support /v1/models)${reset}`,
    );
    return;
  }
  const byProvider = new Map<string, string[]>();
  for (const m of result.models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m.id);
    byProvider.set(m.provider, list);
  }
  for (const [provider, models] of byProvider) {
    console.log(`\n${bold}${provider}${reset}`);
    for (const id of models) {
      const marker = id === currentModel ? `${green}●${reset} ` : "  ";
      console.log(`  ${marker}${id}`);
    }
  }
  console.log("");
}

export async function cmdProviders() {
  const result = await requestResponse("listProviders") as {
    providers: Array<
      { name: string; isExternal: boolean; reachable: boolean; active: boolean }
    >;
  };
  if (result.providers.length === 0) {
    console.log(`${gray}no providers configured${reset}`);
    return;
  }
  for (const p of result.providers) {
    const active = p.active ? `${green}●${reset} ` : "  ";
    const external = p.isExternal
      ? `${yellow}external${reset}`
      : `${dim}local${reset}`;
    const reachable = p.reachable
      ? `${green}reachable${reset}`
      : `${red}unreachable${reset}`;
    console.log(
      `  ${active}${bold}${p.name}${reset} ${gray}${external} · ${reachable}${reset}`,
    );
  }
  console.log("");
}

export async function cmdReload() {
  const result = await requestResponse("reloadExtensions") as {
    added: number;
    reloaded: number;
    removed: number;
    failed: number;
  };
  console.log(
    `${green}extensions reloaded${reset} ${gray}(+${result.added} ~${result.reloaded} -${result.removed} !${result.failed})${reset}`,
  );
}

export function cmdPaste() {
  setInPasteMode(true);
  console.log(
    `${dim}enter your text; type a lone . on a line to finish${reset}`,
  );
}

export function cmdClear() {
  sendRequest("clear");
  console.log(`${gray}conversation cleared${reset}`);
}

/** Start a fresh session (new JSONL) via the `newSession` RPC. Keeps the
 * active model/provider; the old session is flushed and left on disk. */
export async function cmdNewSession() {
  resetMarkdown();
  try {
    const result = await requestResponse("newSession") as {
      sessionId: string;
      path: string;
    };
    console.log(`${green}new session${reset} ${result.path}`);
  } catch (e) {
    const message = (e as { message?: string })?.message ?? JSON.stringify(e);
    console.log(`${red}failed${reset}: ${message}`);
  }
}

export async function cmdMessages() {
  const result = await requestResponse("getMessages") as {
    messages: Array<Record<string, unknown>>;
  };
  if (result.messages.length === 0) {
    console.log(`${gray}no messages${reset}`);
    return;
  }
  for (const msg of result.messages) {
    const role = msg.role as string;
    const roleColor = role === "user"
      ? cyan
      : role === "assistant"
      ? green
      : role === "system"
      ? yellow
      : gray;
    const content = typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
    const preview = content.length > 120
      ? content.slice(0, 117) + "..."
      : content;
    console.log(`  ${roleColor}${role}${reset} ${dim}${preview}${reset}`);
  }
}

export async function cmdSessions() {
  const result = await requestResponse("listSessions") as {
    sessions: Array<
      { path: string; mtimeSecs: number; sizeKb: number; entryCount: number }
    >;
  };
  if (result.sessions.length === 0) {
    console.log(`${gray}no previous sessions${reset}`);
    return;
  }
  for (const s of result.sessions) {
    const date = new Date(s.mtimeSecs * 1000).toLocaleString();
    console.log(
      `  ${bold}${s.path}${reset} ${gray}${s.entryCount} entries · ${s.sizeKb}KB · ${date}${reset}`,
    );
  }
}

export async function cmdExtensions() {
  const result = await requestResponse("listExtensions") as {
    extensions: Array<{ name: string; tools: string[] }>;
  };
  if (result.extensions.length === 0) {
    console.log(`${gray}no extensions loaded${reset}`);
    return;
  }
  for (const ext of result.extensions) {
    console.log(
      `  ${bold}${ext.name}${reset} ${gray}(${ext.tools.length} tool${
        ext.tools.length !== 1 ? "s" : ""
      }${ext.tools.length > 0 ? ": " + ext.tools.join(", ") : ""})${reset}`,
    );
  }
}

export async function cmdTools() {
  const result = await requestResponse("listTools") as {
    tools: Array<{ name: string; description: string; risk: string }>;
  };
  if (result.tools.length === 0) {
    console.log(`${gray}no tools registered${reset}`);
    return;
  }
  for (const t of result.tools) {
    const riskColor = t.risk === "destructive"
      ? red
      : t.risk === "network"
      ? yellow
      : t.risk === "write"
      ? yellow
      : green;
    console.log(
      `  ${bold}${t.name}${reset} ${riskColor}[${t.risk}]${reset} ${dim}${t.description}${reset}`,
    );
  }
}

export async function cmdStats() {
  const s = await requestResponse("getSessionStats") as {
    contextWindow: number;
    completionReserve: number;
    estimatedUsed: number;
    estimatedRemaining: number;
    utilizationPercent: number;
    messageCount: number;
    entryCount: number;
    compactedEntryCount: number;
    roleTokens: {
      system: number;
      user: number;
      assistant: number;
      tool: number;
    };
    resolutionTokens: {
      full: number;
      outlined: number;
      summarized: number;
      pinned: number;
    };
    phaseTokens: {
      exploration: number;
      execution: number;
      verification: number;
      conclusion: number;
      unclassified: number;
    };
    apiUsage: {
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCachedTokens: number;
      totalTokens: number;
      totalCost: number;
      requestCount: number;
    };
  };
  // Honest denominator: usable budget excludes the completion reserve.
  const budget = s.contextWindow - s.completionReserve;
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  console.log(
    `  ${bold}Context${reset}   ${k(s.estimatedUsed)} / ${
      k(budget)
    } (${s.utilizationPercent}%) ` +
      `${gray}[${k(s.completionReserve)} reserved · ${
        k(s.estimatedRemaining)
      } left]${reset}`,
  );
  // Token breakdown by role — surfaces tool-result bloat, the usual cause
  // of runaway context. Data is already on the wire; this is pure display.
  const r = s.roleTokens;
  if (r && (r.system + r.user + r.assistant + r.tool) > 0) {
    console.log(
      `  ${bold}By role${reset}     ${gray}system ${k(r.system)} · user ${
        k(r.user)
      } · assistant ${k(r.assistant)} · tool ${k(r.tool)}${reset}`,
    );
  }
  // Token breakdown by resolution — shows how compaction has reshaped the
  // live context (full vs outlined vs summarized vs pinned).
  const rs = s.resolutionTokens;
  if (rs && (rs.full + rs.outlined + rs.summarized + rs.pinned) > 0) {
    console.log(
      `  ${bold}Resolution${reset} ${gray}full ${k(rs.full)} · outlined ${
        k(rs.outlined)
      } · summarized ${k(rs.summarized)} · pinned ${k(rs.pinned)}${reset}`,
    );
  }
  // Token breakdown by session phase — shows the shape of the work
  // (exploration vs execution vs verification vs conclusion). Reveals, e.g.,
  // a session stalled in exploration or bloated with verification churn.
  const ph = s.phaseTokens;
  if (
    ph &&
    (ph.exploration + ph.execution + ph.verification + ph.conclusion +
        ph.unclassified) > 0
  ) {
    console.log(
      `  ${bold}By phase${reset}    ${gray}explore ${
        k(ph.exploration)
      } · execute ${k(ph.execution)} · verify ${
        k(ph.verification)
      } · conclude ${k(ph.conclusion)}` +
        (ph.unclassified > 0 ? ` · unclassified ${k(ph.unclassified)}` : ``) +
        `${reset}`,
    );
  }
  const compacted = s.compactedEntryCount
    ? ` ${gray}(${s.compactedEntryCount} compacted)${reset}`
    : "";
  console.log(
    `  ${bold}Messages${reset}  ${s.messageCount} messages · ${s.entryCount} entries${compacted}`,
  );
  // API usage + cost. "cost n/a" is shown when requests were made but no
  // pricing applied (unknown model / sentinel pricing) so the gap is visible.
  const a = s.apiUsage;
  const cost = a && a.totalCost > 0
    ? `$${a.totalCost.toFixed(4)}`
    : a && a.requestCount > 0
    ? `${gray}cost n/a${reset}`
    : `${gray}—${reset}`;
  const cached = a && a.totalCachedTokens > 0
    ? ` · ${k(a.totalCachedTokens)} cached`
    : "";
  console.log(
    `  ${bold}API${reset}       ${a.requestCount} requests · ${
      k(a.totalTokens)
    } tokens${cached} · ${cost}`,
  );
}

export async function cmdResume(args: string) {
  if (!args) {
    console.log(`${red}usage:${reset} /resume <session-path>`);
    return;
  }
  resetMarkdown();
  try {
    const result = await requestResponse("resumeSession", { path: args }) as {
      path: string;
      model: string;
      cwd: string;
      entryCount: number;
    };
    setCurrentModel(result.model);
    console.log(
      `${green}resumed${reset} ${result.path} ${gray}(${result.entryCount} entries, model: ${result.model})${reset}`,
    );
  } catch (e) {
    const message = (e as { message?: string })?.message ?? JSON.stringify(e);
    console.log(`${red}failed${reset}: ${message}`);
  }
}
