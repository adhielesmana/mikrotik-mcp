import { readFileSync } from "node:fs";

export interface RouterConfig {
  name: string;
  host: string;
  /** "rest" (RouterOS v7, HTTP/HTTPS) or "api" (classic API, v6.43+ and v7). Default "rest". */
  protocol?: "rest" | "api";
  port?: number;
  username: string;
  password: string;
  /** Encrypt: HTTPS (www-ssl, 443) for rest, api-ssl (8729) for api. Default true. */
  tls?: boolean;
  /** Accept self-signed certificates. Default false. */
  insecure?: boolean;
  timeoutMs?: number;
}

export interface Config {
  routers: RouterConfig[];
  defaultRouter: string;
  readOnly: boolean;
  /** Refuse menu paths that the bundled manual does not document. Default true. */
  menuCheck: boolean;
}

const bool = (v: string | undefined, dflt: boolean) =>
  v === undefined || v === "" ? dflt : ["1", "true", "yes", "on"].includes(v.toLowerCase());

/**
 * Routers come from MIKROTIK_CONFIG (a JSON file: { "routers": [...], "default": "name" })
 * and/or a single router described by MIKROTIK_HOST / MIKROTIK_USER / MIKROTIK_PASSWORD.
 */
export function loadConfig(env = process.env): Config {
  const routers: RouterConfig[] = [];
  let defaultRouter: string | undefined;

  if (env.MIKROTIK_CONFIG) {
    const file = JSON.parse(readFileSync(env.MIKROTIK_CONFIG, "utf8"));
    routers.push(...(file.routers ?? []));
    defaultRouter = file.default;
  }

  if (env.MIKROTIK_HOST) {
    routers.push({
      name: env.MIKROTIK_NAME ?? "default",
      host: env.MIKROTIK_HOST,
      protocol: env.MIKROTIK_PROTOCOL === "api" ? "api" : "rest",
      port: env.MIKROTIK_PORT ? Number(env.MIKROTIK_PORT) : undefined,
      username: env.MIKROTIK_USER ?? "admin",
      password: env.MIKROTIK_PASSWORD ?? "",
      tls: bool(env.MIKROTIK_TLS, true),
      insecure: bool(env.MIKROTIK_INSECURE, false),
    });
  }

  for (const r of routers) {
    if (r.protocol && !["rest", "api"].includes(r.protocol)) throw new Error(`Router "${r.name}": protocol must be "rest" or "api"`);
    if (!r.name || !r.host || !r.username) {
      throw new Error(`Router entry needs name, host and username: ${JSON.stringify({ ...r, password: "***" })}`);
    }
  }

  return {
    routers,
    defaultRouter: defaultRouter ?? routers[0]?.name ?? "",
    readOnly: bool(env.MIKROTIK_READONLY, false),
    menuCheck: bool(env.MIKROTIK_MENU_CHECK, true),
  };
}
