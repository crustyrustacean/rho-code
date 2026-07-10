// Handle JSON-RPC notifications from rho (messages without an id).

import { dim, reset, bold, yellow, red, cyan, gray } from "./ansi.ts";
import { requestResponse, sendRequest } from "./rpc.ts";
import {
  currentModel,
  inReasoning,
  readyResolve,
  setCurrentModel,
  setInReasoning,
  setResolveApproval,
} from "./state.ts";
import { flushMarkdownBuffer, writeMarkdownChunk } from "./markdown.ts";
import { formatToolArgs } from "./format.ts";

export function handleRhoMessage(msg: Record<string, unknown>) {
  if (msg.id) {
    if (msg.error) {
      console.error(`${red}[error]${reset} ${JSON.stringify(msg.error)}`);
    }
    return;
  }

  const method = msg.method as string;
  const params = msg.params as Record<string, unknown>;

  switch (method) {
    case "ready":
      // Fetch model/provider state before showing the banner.
      requestResponse("getState").then((state) => {
        const s = state as { model: string; provider: string; cwd: string };
        setCurrentModel(s.model);
        console.log(`\n${bold}rho-code${reset} — interactive frontend for rho-coding-agent`);
        console.log(`${gray}Type a message, /quit to exit, /abort to cancel.${reset}`);
        console.log(`${gray}Commands: /model, /models, /providers, /stats, /tools, /extensions, /sessions, /messages, /clear, /resume, /compact, /reload, /paste, /abort${reset}`);
        console.log(
          `${cyan}${s.model}${reset} ${gray}(${s.provider || "default provider"})${reset}`,
        );
        console.log(`${dim}${s.cwd}${reset}\n`);
        process.stdout.write("> ");
      }).catch((e) => {
        console.error(`${red}[error]${reset} failed to fetch state: ${JSON.stringify(e)}`);
      }).finally(() => {
        readyResolve();
      });
      break;

    case "state/change":
      if (params.state === "idle") {
        if (inReasoning) {
          setInReasoning(false);
          process.stdout.write(`${reset}\n`);
        }
      }
      break;

    case "message/delta":
      if (inReasoning) {
        setInReasoning(false);
        process.stdout.write(`${reset}\n\n`);
      }
      writeMarkdownChunk(params.delta as string);
      break;

    case "reasoning/delta":
      flushMarkdownBuffer();
      if (!inReasoning) {
        setInReasoning(true);
        process.stdout.write(`${gray}┌ thinking${reset}\n${dim}`);
      }
      process.stdout.write(params.delta as string);
      break;

    case "tool/call": {
      flushMarkdownBuffer();
      if (inReasoning) {
        setInReasoning(false);
        process.stdout.write(`${reset}\n`);
      }
      const name = params.name as string;
      const args = formatToolArgs(params.arguments as string);
      process.stdout.write(`\n${yellow}● ${bold}${name}${reset} ${gray}${args}${reset}`);
      break;
    }

    case "tool/result": {
      const isError = params.is_error as boolean;
      process.stdout.write(isError ? ` ${red}✗${reset}\n` : ` ${gray}✓${reset}\n`);
      break;
    }

    case "tool/denied":
      process.stdout.write(` ${yellow}blocked${reset}\n`);
      break;

    case "approval/request": {
      const risk = params.risk as string;
      const riskColor = risk === "destructive" ? red : risk === "network" ? yellow : gray;
      console.log(`\n${red}⚠${reset} ${bold}Approval required${reset} ${riskColor}[${risk}]${reset}`);
      console.log(`  ${cyan}${params.tool}${reset} ${gray}${formatToolArgs(params.arguments as string)}${reset}`);
      console.log(`${dim}  [y] allow · [n] deny · or type a redirect message${reset}`);
      process.stdout.write(`  ${gray}>${reset} `);
      setResolveApproval((decision: boolean | string | null) => {
        if (decision === true) {
          sendRequest("approvalResponse", { approved: true });
        } else if (typeof decision === "string" && decision.trim()) {
          // Redirect: deny with a message that becomes alternative instructions
          // for the model. The agent loop injects this as a user turn and
          // returns to Thinking so the model can re-plan.
          sendRequest("approvalResponse", { approved: false, message: decision });
        } else {
          // Plain denial — no message, generic error fed to the model.
          sendRequest("approvalResponse", { approved: false });
        }
        setResolveApproval(null);
      });
      break;
    }

    case "agent/start":
      break;

    case "usage": {
      // Per-iteration live tick: a terse telemetry line so long multi-iteration
      // turns show a context/cost gauge as they happen, not only at agent/end.
      // Kept dim and one-line so it reads as status, not conversation content.
      const u = params.usage as {
        inputTokens: number; outputTokens: number; cost: number; requestCount: number;
      };
      const c = params.context as {
        estimatedUsed: number; contextWindow: number; completionReserve: number;
        utilizationPercent: number;
      };
      const budget = c.contextWindow - c.completionReserve;
      const tick: string[] = [
        `${dim}iter ${params.iteration}${reset}`,
        `${Math.round(c.estimatedUsed / 1000)}k/${Math.round(budget / 1000)}k ctx (${c.utilizationPercent}%)`,
      ];
      if (u && u.cost > 0) tick.push(`$${u.cost.toFixed(4)}`);
      process.stdout.write(`${gray}  · ${tick.join(" · ")}${reset}\n`);
      break;
    }

    case "agent/end": {
      flushMarkdownBuffer();
      const dur = params.durationMs as number;
      const iters = params.iterations as number;
      const toolCalls = params.toolCalls as Array<{ name: string; outcome: { kind: string } }>;
      const finishReason = params.finishReason as string;

      const parts: string[] = [];
      parts.push(`${cyan}${currentModel}${reset}`);
      if (iters > 1) parts.push(`${iters} iterations`);
      if (toolCalls && toolCalls.length > 0) {
        parts.push(`${toolCalls.length} tool call${toolCalls.length !== 1 ? "s" : ""}`);
      }
      parts.push(dur > 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`);
      if (finishReason && finishReason !== "stop") {
        parts.push(`${yellow}${finishReason.replace(/_/g, " ")}${reset}`);
      }

      requestResponse("getSessionStats").then((stats) => {
        const s = stats as {
          contextWindow: number;
          completionReserve: number;
          estimatedUsed: number;
          utilizationPercent: number;
          apiUsage: { totalCost: number; totalTokens: number; requestCount: number };
        };
        // Honest denominator: the usable budget is contextWindow minus the
        // completion reserve, which is what utilizationPercent is computed
        // against. Showing the raw window made the fraction and the % disagree.
        const budget = s.contextWindow - s.completionReserve;
        parts.push(`${Math.round(s.estimatedUsed / 1000)}k/${Math.round(budget / 1000)}k ctx (${s.utilizationPercent}%)`);
        // Always surface cost. A missing figure means pricing is unavailable
        // (unknown model or sentinel/router pricing) — say so explicitly
        // instead of silently omitting it and looking free.
        if (s.apiUsage && s.apiUsage.totalCost > 0) {
          parts.push(`$${s.apiUsage.totalCost.toFixed(4)}`);
        } else if (s.apiUsage && s.apiUsage.requestCount > 0) {
          parts.push(`${gray}cost n/a${reset}`);
        }
        process.stdout.write(`\n${gray}─── ${parts.join(" · ")} ───${reset}\n`);
        process.stdout.write("> ");
      }).catch((e) => {
        process.stdout.write(`\n${gray}─── ${parts.join(" · ")} ───${reset}\n`);
        process.stdout.write("> ");
        console.error(`${red}[error]${reset} failed to fetch session stats: ${JSON.stringify(e)}`);
      });
      break;
    }

    case "agent/error":
      console.error(`\n${red}[error]${reset} ${params.error}`);
      process.stdout.write("> ");
      break;

    default:
      // Unknown notification from rho: surface a single unobtrusive line
      // rather than dumping raw params into the conversation.
      console.log(`${gray}[unhandled notification: ${method}]${reset}`);
  }
}