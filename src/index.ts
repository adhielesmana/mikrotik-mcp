#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { RouterOSClient, normalizePath, type RosRecord, type RosValue, type RouterClient } from "./routeros.js";
import { RouterOSApiClient } from "./api.js";
import { registerIspTools } from "./isp.js";
import { ok, safe, routerArg, yes, cli, VERBATIM } from "./util.js";
import { findPage, isKnownMenu, manualVersion, readPage, searchManual, similarMenus } from "./manual.js";
import { CONFIRM_RULE, applyStaged, stage } from "./confirm.js";

const config = loadConfig();
const clients = new Map<string, RouterClient>(
  config.routers.map((r) => [r.name, r.protocol === "api" ? new RouterOSApiClient(r) : new RouterOSClient(r)]),
);

function client(name?: string): RouterClient {
  const key = name ?? config.defaultRouter;
  const c = clients.get(key);
  if (!c) {
    const known = [...clients.keys()].join(", ") || "(none configured — set MIKROTIK_HOST or MIKROTIK_CONFIG)";
    throw new Error(`Unknown router "${key}". Known routers: ${known}`);
  }
  return c;
}

/** Normalize a user/model-supplied menu path and refuse it unless the manual documents it. */
function knownPath(path: string): string {
  const p = normalizePath(path);
  if (config.menuCheck && !isKnownMenu(p)) {
    const near = similarMenus(p);
    throw new Error(
      `Unknown RouterOS menu "/${p}": it does not appear in the RouterOS manual. Do not guess menu paths — ` +
        `call mikrotik_search_manual to find the documented menu, then retry.${near.length ? ` Documented menus with a similar name: ${near.join(", ")}` : ""}`,
    );
  }
  return p;
}

/** Every router result carries where it came from. */
const fromRouter = (c: RouterClient, command: string, output: unknown) => ({
  source: { router: c.cfg.name, host: c.cfg.host, command },
  output,
});

function diff(before: RosRecord = {}, after: RosRecord = {}) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (String(before[k] ?? "") !== String(after[k] ?? "")) changes[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return changes;
}

/** Console commands that only read or measure; anything else must go through mikrotik_safe_write. */
const READ_COMMANDS = new Set(["print", "monitor", "monitor-traffic", "ping", "traceroute", "torch", "profile", "check-for-updates"]);
/** Commands that reboot, wipe, or replace configuration — flagged in previews. */
const DISRUPTIVE =
  /(^|\/)(reboot|shutdown|reset-configuration|import)$|system\/backup\/load|package\/update\/install|package\/downgrade|routerboard\/upgrade/;

const pathArg = z
  .string()
  .describe('RouterOS menu path exactly as documented in the manual, e.g. "ip/address", "ip/firewall/filter". Never guess: look it up with mikrotik_search_manual.');
const valuesArg = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .describe('Properties with their documented names, e.g. {"address":"10.0.0.1/24","interface":"ether2"}');

const server = new McpServer(
  { name: "mikrotik-mcp", version: "0.2.0" },
  {
    instructions: `MikroTik RouterOS server. GROUNDING RULES — follow strictly:
1. Never answer RouterOS questions (syntax, menus, properties, defaults, behaviour) from memory. Find the answer with mikrotik_search_manual / mikrotik_read_manual, or from live router output.
2. Cite the manual file path or URL for every factual statement about RouterOS, and the router + command for every statement about the user's router.
3. Copy commands, property names and values exactly as they appear in the manual or router output. Do not paraphrase syntax.
4. If the manual and the router disagree, or the manual does not cover something, say so — do not fill the gap.
5. Every change goes through mikrotik_safe_write / mikrotik_subscriber_action / mikrotik_hotspot_vouchers: preview → show the user → explicit approval → apply with confirmToken.
Workflow: mikrotik_list_routers → mikrotik_system_overview (model, version) → read (mikrotik_print, mikrotik_get_*) → change only via the confirmation flow.${
      config.readOnly ? "\nThis server is in READ-ONLY mode: write tools are disabled." : ""
    }`,
  },
);

// ---------------------------------------------------------------- manual (grounding layer)

server.registerTool(
  "mikrotik_search_manual",
  {
    title: "Search the RouterOS manual",
    description: `${VERBATIM}
Full-text search over the local copy of MikroTik's official documentation: manual.mikrotik.com (current RouterOS v7 manual incl. the CLI reference for every menu — primary) and help.mikrotik.com (older documentation site, e.g. "Moving from ROSv6 to v7 with examples"). Returns matching sections with site, page title, section, verbatim excerpt, file path and URL. Prefer manual.mikrotik.com when both cover a topic; mention the lastEdited date when citing help.mikrotik.com. Search BEFORE answering any RouterOS question or using any menu path; cite the returned file/url.
Tips: use feature words ("bridge vlan filtering", "pppoe server"), a menu path ("/ip/firewall/filter"), or a property name ("check-gateway").`,
    inputSchema: {
      query: z.string().min(2),
      limit: z.number().int().min(1).max(25).default(8),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ query, limit }) => ok(searchManual(query, limit))),
);

server.registerTool(
  "mikrotik_read_manual",
  {
    title: "Read a RouterOS manual page",
    description: `${VERBATIM}
Return the full verbatim Markdown of one manual page (or one section of it). "page" is a file path from mikrotik_search_manual (e.g. "docs/manual.mikrotik.com/firewall-and-quality-of-service/firewall/filter.md"), a manual.mikrotik.com or help.mikrotik.com URL, or a console menu path ("/ip/firewall/filter" → its CLI reference page). Long pages are returned in chunks (use offset) — or pass a section heading.`,
    inputSchema: {
      page: z.string(),
      section: z.string().optional().describe("Heading text (exact or substring)"),
      offset: z.number().int().min(0).default(0),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ page, section, offset }) => ok({ manual: manualVersion(), ...readPage(page, section, offset) })),
);

// ---------------------------------------------------------------- router: read-only

server.registerTool(
  "mikrotik_list_routers",
  {
    title: "List routers",
    description: "List MikroTik routers configured for this server (no secrets) and which one is the default.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () =>
    ok({ default: config.defaultRouter, readOnly: config.readOnly, routers: config.routers.map(({ password, ...r }) => r) }),
  ),
);

server.registerTool(
  "mikrotik_system_overview",
  {
    title: "System overview",
    description: `${VERBATIM}
Identity, model, RouterOS version, uptime, CPU, memory, disk, health, clock and update status of a router. Good first call.`,
    inputSchema: { router: routerArg },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ router }) => {
    const c = client(router);
    const menus = ["system/identity", "system/resource", "system/routerboard", "system/health", "system/clock", "system/package/update"];
    const results = await Promise.all(
      menus.map((p) => c.print(p).then((r) => (r.length === 1 ? r[0] : r)).catch((e) => ({ error: e.message }))),
    );
    return ok(fromRouter(c, menus.map((m) => `/${m}/print`).join("; "), Object.fromEntries(menus.map((m, i) => [m, results[i]]))));
  }),
);

server.registerTool(
  "mikrotik_print",
  {
    title: "Print (read) a menu",
    description: `${VERBATIM}
Read items from any documented RouterOS menu (equivalent of "/<path>/print"), as the router returns them. Works for lists (ip/address, ppp/active, ...) and singleton menus (ip/dns, system/resource).
"filter" = exact match on properties; "query" = RouterOS API query words (e.g. ["chain=input","disabled=false"], ["rx-byte>1000000"]); "proplist" = return only these properties.
Unknown menu → error: search the manual first, never guess.`,
    inputSchema: {
      router: routerArg,
      path: pathArg,
      filter: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      query: z.array(z.string()).optional(),
      proplist: z.array(z.string()).optional(),
      limit: z.number().int().positive().default(300),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ router, path, filter, query, proplist, limit }) => {
    const c = client(router);
    const p = knownPath(path);
    const rows = query?.length ? await c.query(p, query, proplist) : await c.print(p, filter, proplist);
    const items = rows.length > limit ? (p === "log" ? rows.slice(-limit) : rows.slice(0, limit)) : rows;
    const cmd = cli(p, "print", proplist?.length ? { proplist: proplist.join(",") } : {}) +
      (filter && Object.keys(filter).length ? ` where ${Object.entries(filter).map(([k, v]) => `${k}=${v}`).join(" ")}` : "") +
      (query?.length ? ` (API query: ${query.join(" ")})` : "");
    return ok(fromRouter(c, cmd, rows.length > limit ? { total: rows.length, returned: items.length, items } : items));
  }),
);

server.registerTool(
  "mikrotik_get_config",
  {
    title: "Export configuration",
    description: `${VERBATIM}
Return "/export terse" output of the whole configuration or one section (e.g. "ip/firewall", "interface/bridge") exactly as the router prints it. Secrets are hidden unless showSensitive=true. Needs RouterOS v7.`,
    inputSchema: {
      router: routerArg,
      section: z.string().optional().describe('Menu to export, e.g. "ip/firewall". Omit for the full config.'),
      showSensitive: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ router, section, showSensitive }) => {
    const c = client(router);
    const script = `${section ? "/" + knownPath(section) : ""}/export terse${showSensitive ? " show-sensitive" : ""}`;
    const res = (await c.command("execute", { script, "as-string": "" }, 120_000)) as RosRecord;
    return ok(fromRouter(c, script, typeof res?.ret === "string" ? res.ret : res));
  }),
);

server.registerTool(
  "mikrotik_get_logs",
  {
    title: "Get logs",
    description: `${VERBATIM}
Most recent entries of /log (newest last). Optional "topics" keeps entries whose topics contain any of the given words (e.g. ["error","critical","pppoe"]); "search" matches message text.`,
    inputSchema: {
      router: routerArg,
      limit: z.number().int().positive().max(2000).default(100),
      topics: z.array(z.string()).optional(),
      search: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ router, limit, topics, search }) => {
    const c = client(router);
    const rows = (await c.print("log")).filter(
      (r) =>
        (!topics?.length || topics.some((t) => String(r.topics ?? "").includes(t))) &&
        (!search || String(r.message ?? "").toLowerCase().includes(search.toLowerCase())),
    );
    return ok(fromRouter(c, "/log/print", rows.slice(-limit)));
  }),
);

server.registerTool(
  "mikrotik_get_interfaces",
  {
    title: "Get interfaces",
    description: `${VERBATIM}
All interfaces from /interface/print (name, type, running, disabled, MTU, MAC, traffic and error counters). Optional exact "type" filter (e.g. "ether", "vlan", "pppoe-in", "wg").`,
    inputSchema: { router: routerArg, type: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ router, type }) => {
    const c = client(router);
    return ok(fromRouter(c, cli("interface", "print") + (type ? ` where type=${type}` : ""), await c.print("interface", type ? { type } : {})));
  }),
);

server.registerTool(
  "mikrotik_get_routes",
  {
    title: "Get routes",
    description: `${VERBATIM}
Routing table from /ip/route/print (or /ipv6/route/print). Optional exact "dstAddress" (e.g. "0.0.0.0/0") and "routingTable" filters; activeOnly keeps active routes.`,
    inputSchema: {
      router: routerArg,
      ipv6: z.boolean().default(false),
      dstAddress: z.string().optional(),
      routingTable: z.string().optional(),
      activeOnly: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ router, ipv6, dstAddress, routingTable, activeOnly }) => {
    const c = client(router);
    const path = ipv6 ? "ipv6/route" : "ip/route";
    const filter: Record<string, RosValue> = {
      ...(dstAddress && { "dst-address": dstAddress }),
      ...(routingTable && { "routing-table": routingTable }),
      ...(activeOnly && { active: "true" }),
    };
    const where = Object.entries(filter).map(([k, v]) => `${k}=${v}`).join(" ");
    return ok(fromRouter(c, cli(path, "print") + (where ? ` where ${where}` : ""), await c.print(path, filter)));
  }),
);

server.registerTool(
  "mikrotik_check_update",
  {
    title: "Check for RouterOS updates",
    description: `${VERBATIM}
Runs /system/package/update/check-for-updates (contacts MikroTik's update server; installs nothing) and returns installed vs latest version for the configured channel.`,
    inputSchema: { router: routerArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async ({ router }) => {
    const c = client(router);
    const check = await c.command("system/package/update/check-for-updates", {}, 60_000);
    const status = await c.print("system/package/update");
    return ok(fromRouter(c, "/system/package/update/check-for-updates; /system/package/update/print", { check, status: status[0] ?? status }));
  }),
);

server.registerTool(
  "mikrotik_run_command",
  {
    title: "Run a read-only command",
    description: `${VERBATIM}
Run a READ-ONLY RouterOS command and return the router's output verbatim. Allowed: any documented "<menu>/print" plus the diagnostic commands ${[...READ_COMMANDS].filter((x) => x !== "print").join(", ")}. Examples:
- path="ping" params={"address":"8.8.8.8","count":"4"}
- path="tool/traceroute" params={"address":"1.1.1.1","count":"1"}
- path="interface/monitor-traffic" params={"interface":"ether1","once":""}
- path="tool/torch" params={"interface":"ether1","duration":"5s"}
Look up the command's parameters in the manual first (mikrotik_read_manual with the menu path). Anything that changes state is refused here — use mikrotik_safe_write.`,
    inputSchema: {
      router: routerArg,
      path: z.string().describe('Command path, e.g. "ping", "tool/traceroute", "ip/address/print"'),
      params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
      timeoutSeconds: z.number().positive().max(300).default(60),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ router, path, params, timeoutSeconds }) => {
    const p = knownPath(path);
    const verb = p.split("/").pop()!;
    if (!READ_COMMANDS.has(verb)) {
      throw new Error(`"/${p}" is not a read-only command. Allowed: ${[...READ_COMMANDS].join(", ")}. Use mikrotik_safe_write (operation="command") for changes.`);
    }
    if ("file" in params) throw new Error('The "file" parameter writes to the router\'s storage — not allowed in read-only mode.');
    const c = client(router);
    return ok(fromRouter(c, cli(p, null, params), await c.command(p, params, timeoutSeconds * 1000)));
  }),
);

server.registerTool(
  "mikrotik_security_audit",
  {
    title: "Security audit",
    description: `${VERBATIM}
Reads the router's users, services, DNS, firewall, MAC server, neighbor discovery, SOCKS/proxy/UPnP and update status, and reports observed settings that the manual's "Securing your router" guidance addresses. Each finding contains the observed router values and the manual section to read (cite it; quote the fix from the manual, do not invent one). Schedulers and scripts are listed for manual review.`,
    inputSchema: { router: routerArg },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ router }) => {
    const c = client(router);
    const read = (p: string) => c.print(p).catch(() => [] as RosRecord[]);
    const one = async (p: string) => (await read(p))[0] ?? {};
    const [resource, users, services, dns, filter, macServer, discovery, socks, proxy, upnp, update, schedulers, scripts] =
      await Promise.all([
        one("system/resource"), read("user"), read("ip/service"), one("ip/dns"), read("ip/firewall/filter"),
        one("tool/mac-server"), one("ip/neighbor/discovery-settings"), one("ip/socks"), one("ip/proxy"), one("ip/upnp"),
        one("system/package/update"), read("system/scheduler"), read("system/script"),
      ]);

    const SEC = "manual.mikrotik.com/getting-started/securing-your-router";
    // Verify the cited page/section exists in this corpus version; fall back to the page file.
    const ref = (id: string, section?: string) => {
      try {
        return readPage(id, section, 0, 1).url;
      } catch {
        return `docs/${id}.md`;
      }
    };
    const findings: { severity: "high" | "medium" | "low"; observed: string; manual: string }[] = [];
    const add = (severity: "high" | "medium" | "low", observed: string, id: string, section?: string) =>
      findings.push({ severity, observed, manual: ref(id, section) });

    if (users.some((u) => u.name === "admin" && !yes(u.disabled))) add("medium", 'user "admin" exists, disabled=false', SEC, "Access Username");
    for (const u of users) if (!yes(u.disabled) && !u.address) add("low", `user "${u.name}": address is empty (login allowed from any address)`, "manual.mikrotik.com/authentication-authorization-accounting/user");
    for (const s of services) {
      if (yes(s.disabled)) continue;
      if (["telnet", "ftp", "www", "api"].includes(String(s.name))) add("high", `ip/service "${s.name}" port=${s.port} disabled=false (unencrypted protocol)`, SEC, "Management service ports");
      else if (!s.address) add("medium", `ip/service "${s.name}" port=${s.port} address is empty (reachable from any address)`, SEC, "Management service ports");
    }
    const inputDrop = filter.some((r) => r.chain === "input" && r.action === "drop" && !yes(r.disabled) && !r["src-address"] && !r.protocol);
    if (!inputDrop) add("high", "ip/firewall/filter has no enabled chain=input action=drop rule without src-address/protocol matchers", "manual.mikrotik.com/firewall-and-quality-of-service/firewall/filter", "Protect the router itself");
    if (yes(dns["allow-remote-requests"])) add(inputDrop ? "low" : "high", `ip/dns allow-remote-requests=${dns["allow-remote-requests"]}${inputDrop ? "" : " and no catch-all input drop rule"}`, SEC, "DNS Cache");
    if (macServer["allowed-interface-list"] === "all") add("medium", "tool/mac-server allowed-interface-list=all", SEC, "RouterOS MAC-access");
    if (discovery["discover-interface-list"] === "all") add("low", "ip/neighbor/discovery-settings discover-interface-list=all", SEC, "Neighbor Discovery");
    for (const [name, rec] of [["ip/socks", socks], ["ip/proxy", proxy], ["ip/upnp", upnp]] as const)
      if (yes(rec.enabled)) add(name === "ip/socks" ? "high" : "medium", `${name} enabled=true`, SEC, "Additional Services");
    if (update["latest-version"] && update["installed-version"] && update["latest-version"] !== update["installed-version"])
      add("medium", `installed-version=${update["installed-version"]}, latest-version=${update["latest-version"]}`, SEC, "RouterOS Version");

    const order = { high: 0, medium: 1, low: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    return ok({
      source: { router: c.cfg.name, host: c.cfg.host, version: resource.version, board: resource["board-name"] },
      severityNote: "Severity is this tool's triage heuristic; the remediation must be taken from the cited manual section.",
      findings,
      reviewManually: {
        schedulers: schedulers.map((s) => ({ name: s.name, interval: s.interval, "on-event": s["on-event"] })),
        scripts: scripts.map((s) => ({ name: s.name, owner: s.owner, "last-started": s["last-started"] })),
      },
    });
  }),
);

// ---------------------------------------------------------------- router: writes (preview → confirm → apply)

if (!config.readOnly) {
  server.registerTool(
    "mikrotik_safe_write",
    {
      title: "Change configuration (preview + confirm)",
      description: `${CONFIRM_RULE}
Operations (path must be a documented menu; property names must come from the manual's CLI reference for that menu):
- add: create an item in "path" with "values" (ordered menus such as firewall accept "place-before")
- set: change "values" on item "id" (".id" like "*1A"), or on a singleton menu (ip/dns, system/identity) when id is omitted
- remove: delete item "id"
- command: run any other console command at "path" with "values" as parameters (e.g. system/backup/save, system/reboot)
The preview shows the equivalent console command and the current state read from the router (print), and for "set" the field-by-field diff. After applying, the router is read again and the actual before/after diff is returned.`,
      inputSchema: {
        router: routerArg,
        operation: z.enum(["add", "set", "remove", "command"]).optional(),
        path: pathArg.optional(),
        id: z.string().optional(),
        values: valuesArg.default({}),
        confirmToken: z.string().optional().describe("Token from the preview — only after the user explicitly approved it"),
      },
      annotations: { destructiveHint: true },
    },
    safe(async ({ router, operation, path, id, values, confirmToken }) => {
      if (confirmToken) return ok(await applyStaged(server, "mikrotik_safe_write", confirmToken));
      if (!operation || !path) throw new Error("operation and path are required for a preview");

      const c = client(router);
      const p = knownPath(path);
      const readItem = async () => {
        if (!id) throw new Error(`${operation} needs the item "id" — get it with mikrotik_print path="${p}"`);
        const [item] = await c.print(p, { ".id": id });
        if (!item) throw new Error(`No item ${id} in /${p}. Print the menu to get current .id values.`);
        return item;
      };

      switch (operation) {
        case "add": {
          const count = (await c.print(p, {}, [".id"])).length;
          return ok(stage("mikrotik_safe_write", {
            router: c.cfg.name, operation, command: cli(p, "add", values), current: { menu: `/${p}`, items: count }, willAdd: values,
          }, async () => {
            const res = (await c.add(p, values)) as RosRecord;
            const newId = res?.[".id"] ?? res?.ret;
            const [created] = newId ? await c.print(p, { ".id": String(newId) }) : [];
            return { command: cli(p, "add", values), created: created ?? res };
          }));
        }
        case "set": {
          const before = id ? await readItem() : (await c.print(p))[0];
          if (!before) throw new Error(`/${p} returned nothing to set.`);
          const planned = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]));
          const command = cli(p, "set", id ? { numbers: id, ...values } : values);
          return ok(stage("mikrotik_safe_write", {
            router: c.cfg.name, operation, command, before, diff: diff(Object.fromEntries(Object.keys(planned).map((k) => [k, before[k]])), planned),
          }, async () => {
            if (id) await c.set(p, id, values);
            else await c.setSingleton(p, values);
            const after = id ? (await c.print(p, { ".id": id }))[0] : (await c.print(p))[0];
            return { command, diff: diff(before, after), after };
          }));
        }
        case "remove": {
          const before = await readItem();
          const command = cli(p, "remove", { numbers: id });
          return ok(stage("mikrotik_safe_write", { router: c.cfg.name, operation, command, willRemove: before }, async () => {
            await c.remove(p, id!);
            return { command, removed: before };
          }));
        }
        case "command": {
          const command = cli(p, null, values);
          return ok(stage("mikrotik_safe_write", {
            router: c.cfg.name, operation, command,
            ...(DISRUPTIVE.test(p) && { warning: "DISRUPTIVE: this reboots the router, replaces configuration or installs software." }),
          }, async () => ({ command, output: await c.command(p, values, 120_000) })));
        }
      }
    }),
  );
}

registerIspTools(server, client, config.readOnly);

// ---------------------------------------------------------------- prompts

server.registerPrompt(
  "mikrotik_health_check",
  { title: "Router health check", description: "Read-only health & security review with citations.", argsSchema: { router: z.string().optional() } },
  ({ router }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Do a read-only health check of MikroTik router ${router ?? "(default)"}:
1. mikrotik_system_overview and mikrotik_check_update.
2. mikrotik_get_interfaces — flag links that are not running and non-zero error counters.
3. mikrotik_get_logs topics ["error","critical","warning"].
4. mikrotik_security_audit — for each finding, read the cited manual section and quote its recommendation.
Report a table: observation (with router command as source) → manual recommendation (with manual URL). Change nothing.`,
      },
    }],
  }),
);

server.registerPrompt(
  "mikrotik_safe_change",
  {
    title: "Make a grounded, confirmed change",
    description: "Look up the manual, preview, confirm, apply, verify.",
    argsSchema: { change: z.string().describe("What to change"), router: z.string().optional() },
  },
  ({ change, router }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `On MikroTik router ${router ?? "(default)"} I want to: ${change}
1. Find the procedure with mikrotik_search_manual and read it with mikrotik_read_manual; cite the pages.
2. Read the current state with mikrotik_print / mikrotik_get_config.
3. Show me the exact commands (copied from the manual, adapted only with my values), the lockout risk, and suggest a backup first (mikrotik_safe_write operation="command" path="system/backup/save").
4. Use mikrotik_safe_write for each step: show me each preview and wait for my approval before confirming.
5. Verify afterwards with reads (and ping if relevant).`,
      },
    }],
  }),
);

await server.connect(new StdioServerTransport());
let docs = "manual: missing (run npm run scrape)";
try {
  docs = `docs: ${findPage("introduction") ? "ok" : "?"}, scraped ${manualVersion().scrapedAt}`;
} catch {}
console.error(`mikrotik-mcp running: ${config.routers.length} router(s), default="${config.defaultRouter}", readOnly=${config.readOnly}, ${docs}`);
