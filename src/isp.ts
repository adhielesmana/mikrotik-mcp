import { randomInt } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RosRecord, RosValue, RouterClient } from "./routeros.js";
import { ok, safe, routerArg, yes, cli, VERBATIM } from "./util.js";
import { CONFIRM_RULE, applyStaged, stage } from "./confirm.js";

/** Where each service keeps its accounts and live sessions, and which session field holds the username. */
const SERVICES = {
  pppoe: { accounts: "ppp/secret", active: "ppp/active", profiles: "ppp/profile", userField: "name" },
  hotspot: { accounts: "ip/hotspot/user", active: "ip/hotspot/active", profiles: "ip/hotspot/user/profile", userField: "user" },
} as const;
type Service = keyof typeof SERVICES;

const serviceArg = z.enum(["pppoe", "hotspot"]).describe('"pppoe" (ppp/secret) or "hotspot" (ip/hotspot/user)');

/** Unambiguous characters for voucher codes (no 0/O, 1/I/L). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code = (len: number) => Array.from({ length: len }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

async function findAccount(c: RouterClient, service: Service, name: string): Promise<RosRecord> {
  const [acct] = await c.print(SERVICES[service].accounts, { name });
  if (!acct) throw new Error(`No ${service} user named "${name}"`);
  return acct;
}

/** Disconnect every live session of a user; returns how many were removed. */
async function kick(c: RouterClient, service: Service, name: string): Promise<number> {
  const s = SERVICES[service];
  const sessions = await c.print(s.active, { [s.userField]: name });
  for (const sess of sessions) await c.remove(s.active, String(sess[".id"]));
  return sessions.length;
}

export function registerIspTools(server: McpServer, client: (name?: string) => RouterClient, readOnly: boolean) {
  server.registerTool(
    "mikrotik_subscribers",
    {
      title: "List subscribers",
      description: `${VERBATIM}
List /ppp/secret or /ip/hotspot/user accounts joined with their live sessions from /ppp/active or /ip/hotspot/active (online, address, caller-id/MAC, uptime). Filter by name substring, profile, or online/offline/disabled status.`,
      inputSchema: {
        router: routerArg,
        service: serviceArg,
        search: z.string().optional().describe("Case-insensitive substring of name or comment"),
        profile: z.string().optional(),
        status: z.enum(["all", "online", "offline", "disabled"]).default("all"),
        includePasswords: z.boolean().default(false),
        limit: z.number().int().positive().default(500),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ router, service, search, profile, status, includePasswords, limit }) => {
      const c = client(router);
      const s = SERVICES[service];
      const [accounts, sessions] = await Promise.all([c.print(s.accounts), c.print(s.active)]);
      const online = new Map(sessions.map((x) => [String(x[s.userField]), x]));
      const needle = search?.toLowerCase();

      const rows = accounts
        .filter((a) => !profile || a.profile === profile)
        .filter((a) => !needle || `${a.name} ${a.comment ?? ""}`.toLowerCase().includes(needle))
        .filter((a) => {
          const isOnline = online.has(String(a.name));
          if (status === "online") return isOnline;
          if (status === "offline") return !isOnline && !yes(a.disabled);
          if (status === "disabled") return yes(a.disabled);
          return true;
        })
        .map((a) => {
          const sess = online.get(String(a.name));
          const { password, ...rest } = a;
          return {
            ...(includePasswords ? a : rest),
            online: !!sess,
            ...(sess && {
              session: {
                address: sess.address,
                "caller-id": sess["caller-id"] ?? sess["mac-address"],
                uptime: sess.uptime,
                ...(sess["session-time-left"] ? { "session-time-left": sess["session-time-left"] } : {}),
              },
            }),
          };
        });

      return ok({
        source: { router: c.cfg.name, host: c.cfg.host, command: `/${s.accounts}/print; /${s.active}/print` },
        service,
        total: accounts.length,
        online: sessions.length,
        matched: rows.length,
        items: rows.slice(0, limit),
      });
    }),
  );

  if (readOnly) return;

  server.registerTool(
    "mikrotik_subscriber_action",
    {
      title: "Manage a subscriber (preview + confirm)",
      description: `${CONFIRM_RULE}
Manage one PPPoE (/ppp/secret) or hotspot (/ip/hotspot/user) account by name:
- create: needs password (and usually profile); extra properties via values using names from the manual's CLI reference (e.g. {"remote-address":"10.100.0.50","comment":"Cust 001"})
- update: change password/profile/values (a live session keeps its old profile until kicked)
- enable / disable: disable also removes the live session (isolates the customer)
- kick: remove the live session so the client reconnects (applies a new profile)
- delete: remove the live session and the account
The preview shows the account as it is now (password masked), its live sessions, the profile check, and the exact console commands.`,
      inputSchema: {
        router: routerArg,
        service: serviceArg.optional(),
        name: z.string().optional(),
        action: z.enum(["create", "update", "enable", "disable", "kick", "delete"]).optional(),
        password: z.string().optional(),
        profile: z.string().optional(),
        values: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
        confirmToken: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    safe(async ({ router, service, name, action, password, profile, values, confirmToken }) => {
      if (confirmToken) return ok(await applyStaged(server, "mikrotik_subscriber_action", confirmToken));
      if (!service || !name || !action) throw new Error("service, name and action are required for a preview");

      const c = client(router);
      const s = SERVICES[service];
      const props: Record<string, RosValue> = { ...values, ...(password && { password }), ...(profile && { profile }) };
      const masked = (r: Record<string, unknown>) => ("password" in r ? { ...r, password: "***" } : r);
      if (profile && !(await c.print(s.profiles, { name: profile })).length) {
        throw new Error(`Profile "${profile}" does not exist in /${s.profiles} on ${c.cfg.name}. Print that menu to see the existing profiles.`);
      }
      const sessions = await c.print(s.active, { [s.userField]: name });
      const kickCmds = sessions.map((x) => cli(s.active, "remove", { numbers: x[".id"] }));
      const base = { router: c.cfg.name, service, action, name, liveSessions: sessions };

      if (action === "create") {
        if (!password) throw new Error("create requires a password");
        if ((await c.print(s.accounts, { name })).length) throw new Error(`A ${service} account named "${name}" already exists.`);
        const add: Record<string, RosValue> = { name, ...(service === "pppoe" && !("service" in props) && { service: "pppoe" }), ...props };
        return ok(stage("mikrotik_subscriber_action", { ...base, commands: [cli(s.accounts, "add", masked(add))] }, async () => {
          const res = (await c.add(s.accounts, add)) as RosRecord;
          return { created: name, ".id": res?.[".id"] };
        }));
      }

      const acct = await findAccount(c, service, name);
      const id = String(acct[".id"]);
      const plan: { commands: string[]; run: () => Promise<Record<string, unknown>> } = (() => {
        switch (action) {
          case "update":
            if (!Object.keys(props).length) throw new Error("update needs password, profile or values");
            return {
              commands: [cli(s.accounts, "set", masked({ numbers: id, ...props }))],
              run: async () => (await c.set(s.accounts, id, props), { updated: name, fields: Object.keys(props) }),
            };
          case "enable":
            return {
              commands: [cli(s.accounts, "enable", { numbers: id })],
              run: async () => (await c.set(s.accounts, id, { disabled: false }), { enabled: name }),
            };
          case "disable":
            return {
              commands: [cli(s.accounts, "disable", { numbers: id }), ...kickCmds],
              run: async () => (await c.set(s.accounts, id, { disabled: true }), { disabled: name, sessionsRemoved: await kick(c, service, name) }),
            };
          case "kick":
            return { commands: kickCmds, run: async () => ({ kicked: name, sessionsRemoved: await kick(c, service, name) }) };
          default: // delete
            return {
              commands: [...kickCmds, cli(s.accounts, "remove", { numbers: id })],
              run: async () => {
                const removed = await kick(c, service, name);
                await c.remove(s.accounts, id);
                return { deleted: name, sessionsRemoved: removed };
              },
            };
        }
      })();
      if (!plan.commands.length) return ok({ ...base, account: masked(acct), result: "No live session — nothing to do." });
      return ok(stage("mikrotik_subscriber_action", { ...base, account: masked(acct), commands: plan.commands }, plan.run));
    }),
  );

  server.registerTool(
    "mikrotik_hotspot_vouchers",
    {
      title: "Generate hotspot vouchers (preview + confirm)",
      description: `${CONFIRM_RULE}
Create a batch of /ip/hotspot/user accounts with random codes (unambiguous characters). The preview verifies the profile (and server) exist on the router. After applying, returns the codes so they can be printed. All vouchers in a batch share a comment so the batch can be found or deleted later.`,
      inputSchema: {
        router: routerArg,
        count: z.number().int().min(1).max(500).optional(),
        profile: z.string().optional().describe("Existing /ip/hotspot/user/profile name"),
        server: z.string().default("all").describe("Hotspot server name, or all"),
        prefix: z.string().default(""),
        length: z.number().int().min(4).max(16).default(6),
        mode: z.enum(["same", "separate"]).default("same").describe('"same": password = username; "separate": random password too'),
        limitUptime: z.string().optional().describe('limit-uptime, e.g. "3h", "1d"'),
        limitBytesTotal: z.string().optional().describe('limit-bytes-total in bytes, e.g. "1073741824"'),
        comment: z.string().optional().describe("Batch label; defaults to vc-<timestamp>"),
        confirmToken: z.string().optional(),
      },
      annotations: { destructiveHint: false },
    },
    safe(async ({ router, count, profile, server: hsServer, prefix, length, mode, limitUptime, limitBytesTotal, comment, confirmToken }) => {
      if (confirmToken) return ok(await applyStaged(server, "mikrotik_hotspot_vouchers", confirmToken));
      if (!count || !profile) throw new Error("count and profile are required for a preview");

      const c = client(router);
      if (!(await c.print("ip/hotspot/user/profile", { name: profile })).length)
        throw new Error(`Hotspot user profile "${profile}" does not exist on ${c.cfg.name}. Print /ip/hotspot/user/profile to see existing profiles.`);
      if (hsServer !== "all" && !(await c.print("ip/hotspot", { name: hsServer })).length)
        throw new Error(`Hotspot server "${hsServer}" does not exist on ${c.cfg.name}. Print /ip/hotspot to see existing servers.`);

      const batch = comment ?? `vc-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
      const fixed: Record<string, RosValue> = {
        profile,
        server: hsServer,
        comment: batch,
        ...(limitUptime && { "limit-uptime": limitUptime }),
        ...(limitBytesTotal && { "limit-bytes-total": limitBytesTotal }),
      };
      const preview = {
        router: c.cfg.name,
        count,
        codeFormat: `${prefix}${"X".repeat(length)} (${mode === "same" ? "password = username" : "separate random password"})`,
        commandPerVoucher: cli("ip/hotspot/user", "add", { name: `${prefix}${"X".repeat(length)}`, password: "***", ...fixed }),
      };

      return ok(stage("mikrotik_hotspot_vouchers", preview, async () => {
        const existing = new Set((await c.print("ip/hotspot/user", {}, ["name"])).map((u) => String(u.name)));
        const vouchers: { username: string; password: string }[] = [];
        const errors: string[] = [];
        while (vouchers.length + errors.length < count) {
          const username = prefix + code(length);
          if (existing.has(username)) continue;
          existing.add(username);
          const password = mode === "same" ? username : code(length);
          try {
            await c.add("ip/hotspot/user", { name: username, password, ...fixed });
            vouchers.push({ username, password });
          } catch (e: any) {
            errors.push(`${username}: ${e.message}`);
            if (errors.length >= 3 && vouchers.length === 0) break; // systematic failure
          }
        }
        return { batch, profile, created: vouchers.length, vouchers, ...(errors.length && { errors }) };
      }));
    }),
  );
}
