import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Two-phase writes: a write tool called without confirmToken only previews and stages the change;
 * called again with the token it applies exactly what was previewed (args are bound to the token).
 * If the MCP client supports elicitation, the human is also asked directly before applying, so the
 * model cannot confirm on the user's behalf.
 */

const TTL_MS = 10 * 60_000;
interface Pending {
  tool: string;
  preview: unknown;
  apply: () => Promise<unknown>;
  expires: number;
}
const pending = new Map<string, Pending>();

export const CONFIRM_RULE =
  "REQUIRES CONFIRMATION. First call (no confirmToken) changes nothing: it reads the current state and returns a preview of the change plus a confirmToken. " +
  "Show that preview to the user verbatim and wait for their explicit approval; only then call again with confirmToken (other arguments are ignored on that call). Tokens are single-use and expire in 10 minutes.";

export function stage(tool: string, preview: Record<string, unknown>, apply: () => Promise<unknown>) {
  for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
  const confirmToken = randomBytes(9).toString("base64url");
  pending.set(confirmToken, { tool, preview, apply, expires: Date.now() + TTL_MS });
  return {
    status: "PREVIEW ONLY — nothing has been changed",
    ...preview,
    confirmToken,
    next: "Show this preview to the user. After they explicitly approve, call the same tool again with confirmToken.",
  };
}

export async function applyStaged(server: McpServer, tool: string, token: string) {
  const p = pending.get(token);
  if (!p || p.expires < Date.now()) throw new Error("Unknown or expired confirmToken. Call the tool again without a token to get a fresh preview.");
  if (p.tool !== tool) throw new Error(`This confirmToken belongs to ${p.tool}, not ${tool}.`);
  pending.delete(token); // single use, even if the user declines

  if (server.server.getClientCapabilities()?.elicitation) {
    const answer = await server.server.elicitInput({
      message: `Apply this MikroTik change?\n\n${JSON.stringify(p.preview, null, 2)}`,
      requestedSchema: {
        type: "object",
        properties: { confirm: { type: "boolean", title: "Apply this change to the router", default: false } },
        required: ["confirm"],
      },
    });
    if (answer.action !== "accept" || answer.content?.confirm !== true) {
      return { status: "CANCELLED by user — nothing was changed" };
    }
  }
  return { status: "APPLIED", ...((await p.apply()) as object) };
}
