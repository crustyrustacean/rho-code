// rho-code — frontend for the rho-coding-agent
// Spawns rho in headless JSON-RPC mode, provides an interactive REPL

import { handleCliFlags, shouldContinueSession } from "./src/cli.ts";
import { initTransport, spawnRho } from "./src/rpc.ts";
import { readRhoOutput, readUserInput } from "./src/repl.ts";

handleCliFlags();
const continueSession = shouldContinueSession();

const { child, childStdin, childStdout } = spawnRho(continueSession);
initTransport(child, childStdin, childStdout);

await Promise.all([readRhoOutput(), readUserInput()]);
