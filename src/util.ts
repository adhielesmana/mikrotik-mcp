import { z } from "zod";

export const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

/** Wrap handlers so RouterOS/network errors come back as tool errors, not protocol errors. */
export function safe<A>(fn: (args: A) => Promise<ReturnType<typeof ok>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e: any) {
      const msg = `${e?.message ?? e}${e?.detail ? ` — ${e.detail}` : ""}`;
      // RouterOS rejected the syntax: steer the model back to the manual instead of retrying guesses.
      const hint = /no such command|unknown parameter|expected end of command|invalid value|input does not match|bad request/i.test(msg)
        ? "\nThe router rejected this syntax. Do not guess: look up the exact menu path and property names with mikrotik_search_manual / mikrotik_read_manual (CLI reference), then retry."
        : "";
      return { content: [{ type: "text" as const, text: `Error: ${msg}${hint}` }], isError: true };
    }
  };
}

/** Required wording for every tool that returns router output or manual text. */
export const VERBATIM = "Returns verbatim RouterOS CLI output or official manual text. Do not paraphrase syntax; copy exactly.";

export const routerArg = z.string().optional().describe("Router name from config. Omit for the default router.");

export const yes = (v: unknown) => v === "true" || v === true || v === "yes";

/** Equivalent console command, for previews and citations. Quotes values the way the manual describes. */
export function cli(path: string, verb: string | null, args: Record<string, unknown> = {}): string {
  const q = (v: unknown) => {
    const s = String(v);
    return /^[A-Za-z0-9_.:\/*,+-]+$/.test(s) ? s : `"${s.replace(/[\\"$]/g, (c) => "\\" + c)}"`;
  };
  const kv = Object.entries(args).map(([k, v]) => `${k}=${q(v)}`);
  return [`/${path}${verb ? "/" + verb : ""}`, ...kv].join(" ");
}
