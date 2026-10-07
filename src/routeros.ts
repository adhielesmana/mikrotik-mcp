import http from "node:http";
import https from "node:https";
import type { RouterConfig } from "./config.js";

export type RosValue = string | number | boolean;
export type RosRecord = Record<string, unknown>;

export class RouterOSError extends Error {
  constructor(message: string, public status?: number, public detail?: string) {
    super(message);
  }
}

/** RouterOS menu path like "ip/firewall/filter" (leading/trailing slashes and spaces tolerated). */
export function normalizePath(path: string): string {
  const p = path.trim().replace(/\s+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!/^[a-z0-9][a-z0-9\-\/.]*$/i.test(p) || p.includes("..")) {
    throw new RouterOSError(`Invalid RouterOS path: "${path}"`);
  }
  return p;
}

/** REST API values are strings; convert booleans to yes/no-compatible "true"/"false". */
function stringify(params: Record<string, RosValue | RosValue[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[k] = Array.isArray(v) ? v : String(v);
  return out;
}

/** Operations shared by the REST client (v7) and the classic API client (v6/v7). */
export interface RouterClient {
  readonly cfg: RouterConfig;
  print(path: string, filter?: Record<string, RosValue>, proplist?: string[]): Promise<RosRecord[]>;
  query(path: string, query: string[], proplist?: string[]): Promise<RosRecord[]>;
  add(path: string, props: Record<string, RosValue>): Promise<unknown>;
  set(path: string, id: string, props: Record<string, RosValue>): Promise<unknown>;
  setSingleton(path: string, props: Record<string, RosValue>): Promise<unknown>;
  remove(path: string, id: string): Promise<unknown>;
  command(path: string, params?: Record<string, RosValue | RosValue[]>, timeoutMs?: number): Promise<unknown>;
}

/** Thin client for the RouterOS v7 REST API (https://help.mikrotik.com/docs/display/ROS/REST+API). */
export class RouterOSClient implements RouterClient {
  constructor(public readonly cfg: RouterConfig) {}

  private request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    const tls = this.cfg.tls ?? true;
    const lib = tls ? https : http;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const auth = Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64");

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          host: this.cfg.host,
          port: this.cfg.port ?? (tls ? 443 : 80),
          path: `/rest/${path}`,
          method,
          rejectUnauthorized: !(this.cfg.insecure ?? false),
          timeout: timeoutMs ?? this.cfg.timeoutMs ?? 30_000,
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: "application/json",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            let parsed: any = data;
            try {
              parsed = data ? JSON.parse(data) : null;
            } catch {
              /* keep raw text */
            }
            const status = res.statusCode ?? 0;
            if (status >= 400) {
              const msg = parsed?.message ?? res.statusMessage ?? "error";
              reject(new RouterOSError(`RouterOS ${status} ${msg}`, status, parsed?.detail));
            } else resolve(parsed);
          });
        },
      );
      req.on("timeout", () => req.destroy(new RouterOSError(`Timed out contacting ${this.cfg.host}`)));
      req.on("error", (e) =>
        reject(e instanceof RouterOSError ? e : new RouterOSError(`Cannot reach ${this.cfg.host}: ${e.message}`)),
      );
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** GET /rest/<path>?k=v&.proplist=a,b — equality filters only. */
  async print(path: string, filter: Record<string, RosValue> = {}, proplist?: string[]): Promise<RosRecord[]> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) qs.set(k, String(v));
    if (proplist?.length) qs.set(".proplist", proplist.join(","));
    const q = qs.toString();
    const res = await this.request("GET", normalizePath(path) + (q ? `?${q}` : ""));
    return Array.isArray(res) ? (res as RosRecord[]) : [res as RosRecord];
  }

  /** POST /rest/<path>/print with RouterOS query stack, e.g. [".id>*5", "disabled=false", "#&"]. */
  async query(path: string, query: string[], proplist?: string[]): Promise<RosRecord[]> {
    const body: RosRecord = { ".query": query };
    if (proplist?.length) body[".proplist"] = proplist;
    return (await this.request("POST", `${normalizePath(path)}/print`, body)) as RosRecord[];
  }

  add(path: string, props: Record<string, RosValue>): Promise<unknown> {
    return this.request("PUT", normalizePath(path), stringify(props));
  }

  set(path: string, id: string, props: Record<string, RosValue>): Promise<unknown> {
    return this.request("PATCH", `${normalizePath(path)}/${encodeURIComponent(id)}`, stringify(props));
  }

  /** For singleton menus (e.g. ip/dns, system/identity) that have no items: POST <path>/set. */
  setSingleton(path: string, props: Record<string, RosValue>): Promise<unknown> {
    return this.request("POST", `${normalizePath(path)}/set`, stringify(props));
  }

  remove(path: string, id: string): Promise<unknown> {
    return this.request("DELETE", `${normalizePath(path)}/${encodeURIComponent(id)}`);
  }

  /** POST /rest/<path>/<command> — any console command, e.g. ("", "ping", {address, count}). */
  command(path: string, params: Record<string, RosValue | RosValue[]> = {}, timeoutMs?: number): Promise<unknown> {
    const p = normalizePath(path);
    return this.request("POST", p, stringify(params), timeoutMs);
  }
}
