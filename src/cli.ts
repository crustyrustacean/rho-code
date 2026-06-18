// CLI flag parsing and early-exit handlers.

export function handleCliFlags(): void {
  if (Deno.args.includes("--help") || Deno.args.includes("-h")) {
    console.log(`rho-code — interactive REPL frontend for rho-coding-agent

Usage: rho-code [flags]

Flags:
  -c, --continue  Resume the previous session
  -v, --version   Print version and exit
  -h, --help      Show this help

Inside the REPL, type /help for slash commands.`);
    Deno.exit(0);
  }
  if (Deno.args.includes("--version") || Deno.args.includes("-v")) {
    try {
      const denoConfig = JSON.parse(Deno.readTextFileSync("deno.json"));
      console.log(`rho-code ${denoConfig.version}`);
    } catch {
      console.log("rho-code (unknown version)");
    }
    Deno.exit(0);
  }
}

export function shouldContinueSession(): boolean {
  return Deno.args.includes("-c");
}
