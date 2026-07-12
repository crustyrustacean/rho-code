// rho-code — TUI frontend for the rho-coding-agent
// Spawns rho in headless JSON-RPC mode and runs a terminal UI over it.

import { handleCliFlags, shouldContinueSession } from "./src/cli.ts";
import { initTransport, spawnRho } from "./src/rpc.ts";
import { runTui } from "./src/tui/run.ts";

handleCliFlags();
const continueSession = shouldContinueSession();

const { child, childStdin, childStdout } = spawnRho(continueSession);
initTransport(child, childStdin, childStdout);

await runTui();
