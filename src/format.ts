// Format tool arguments JSON for compact display.

export function formatToolArgs(args: string): string {
  try {
    const parsed = JSON.parse(args);
    if (parsed.path && Object.keys(parsed).length === 1) return parsed.path;
    if (parsed.path && Array.isArray(parsed.edits)) {
      return `${parsed.path} (${parsed.edits.length} edit${parsed.edits.length !== 1 ? "s" : ""})`;
    }
    if (parsed.command) {
      const cmd = parsed.command.length > 60
        ? parsed.command.slice(0, 57) + "..."
        : parsed.command;
      return cmd;
    }
    if (parsed.pattern) return `/${parsed.pattern}/`;
    return Object.entries(parsed)
      .filter(([k]) => k !== "path")
      .slice(0, 3)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
  } catch {
    return args.length > 80 ? args.slice(0, 77) + "..." : args;
  }
}
