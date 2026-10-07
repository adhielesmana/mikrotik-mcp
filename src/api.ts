import net from "node:net";
import tls from "node:tls";
import type { RouterConfig } from "./config.js";
import { RouterOSError, normalizePath, type RosRecord, type RosValue, type RouterClient } from "./routeros.js";

/**
 * Client for the classic RouterOS API (TCP 8728, TLS 8729) — works on RouterOS v6.43+ and v7.
 * https://help.mikrotik.com/docs/display/ROS/API
 * One connection per call: simple, and the router's api service handles many sessions.
 */

function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([(n >> 8) | 0x80, n & 0xff]);
  if (n < 0x200000) return Buffer.from([(n >> 16) | 0xc0, (n >> 8) & 0xff, n & 0xff]);
  if (n < 0x10000000) return Buffer.from([(n >> 24) | 0xe0, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.from([0xf0, (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

/** Returns [length, headerBytes] or null if the buffer does not yet hold the full length prefix. */
function decodeLength(b: Buffer, i: number): [number, number] | null {
  if (i >= b.length) return null;
  const c = b[i];
  const need = c < 0x80 ? 1 : c < 0xc0 ? 2 : c < 0xe0 ? 3 : c < 0xf0 ? 4 : 5;
  if (i + need > b.length) return null;
  switch (need) {
    case 1: return [c, 1];
    case 2: return [((c & 0x3f) << 8) | b[i + 1], 2];
    case 3: return [((c & 0x1f) << 16) | (b[i + 1] << 8) | b[i + 2], 3];
    case 4: return [(((c & 0x0f) << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0, 4];
    default: return [b.readUInt32BE(i + 1), 5];
  }
}

const encodeSentence = (words: string[]) =>
  Buffer.concat([
    ...words.flatMap((w) => {
      const wb = Buffer.from(w, "utf8");
      return [encodeLength(wb.length), wb];
    }),
    Buffer.from([0]),
  ]);

/** REST-style query word ("name=x", "rx-byte>5", "-comment", "#|") → API query word ("?name=x", "?>rx-byte=5", ...). */
export function toApiQuery(word: string): string {
  if (word.startsWith("#")) return `?${word}`;
  if (word.startsWith("-")) return `?-${word.slice(1)}`;
  const m = word.match(/^([^=<>]+)([=<>])(.*)$/);
  if (!m) return `?${word}`;
  const [, k, op, v] = m;
  return op === "=" ? `?${k}=${v}` : `?${op}${k}=${v}`;
}

const attrs = (params: Record<string, RosValue | RosValue[]>) =>
  Object.entries(params).map(([k, v]) => `=${k}=${Array.isArray(v) ? v.join(",") : String(v)}`);

export class RouterOSApiClient implements RouterClient {
  constructor(public readonly cfg: RouterConfig) {}

  /** Connect, log in, run one sentence, return the !re rows plus the !done attributes. */
  private run(words: string[], timeoutMs?: number): Promise<{ rows: RosRecord[]; done: RosRecord }> {
    const useTls = this.cfg.tls ?? true;
    const port = this.cfg.port ?? (useTls ? 8729 : 8728);
    const timeout = timeoutMs ?? this.cfg.timeoutMs ?? 30_000;

    return new Promise((resolve, reject) => {
      const sock = useTls
        ? tls.connect({ host: this.cfg.host, port, rejectUnauthorized: !(this.cfg.insecure ?? false) })
        : net.connect({ host: this.cfg.host, port });
      const timer = setTimeout(() => fail(new RouterOSError(`Timed out contacting ${this.cfg.host}:${port}`)), timeout);
      let buf = Buffer.alloc(0);
      let sentence: string[] = [];
      let stage: "login" | "cmd" = "login";
      const rows: RosRecord[] = [];
      let trap: string | undefined;

      const finish = (err?: Error, done?: RosRecord) => {
        clearTimeout(timer);
        sock.destroy();
        err ? reject(err) : resolve({ rows, done: done ?? {} });
      };
      const fail = (e: Error) => finish(e);

      const handle = (s: string[]) => {
        const [type, ...rest] = s;
        const rec: RosRecord = {};
        for (const w of rest) {
          if (!w.startsWith("=")) continue;
          const eq = w.indexOf("=", 1);
          rec[w.slice(1, eq)] = w.slice(eq + 1);
        }
        if (type === "!re") rows.push(rec);
        else if (type === "!trap") trap = String(rec.message ?? "trap");
        else if (type === "!fatal") fail(new RouterOSError(`RouterOS fatal: ${rest.join(" ")}`));
        else if (type === "!done") {
          if (trap) return fail(new RouterOSError(stage === "login" ? `Login failed: ${trap}` : `RouterOS error: ${trap}`));
          if (stage === "login") {
            stage = "cmd";
            sock.write(encodeSentence(words));
          } else finish(undefined, rec);
        }
      };

      sock.on(useTls ? "secureConnect" : "connect", () =>
        sock.write(encodeSentence(["/login", `=name=${this.cfg.username}`, `=password=${this.cfg.password}`])),
      );
      sock.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        let i = 0;
        for (;;) {
          const len = decodeLength(buf, i);
          if (!len || i + len[1] + len[0] > buf.length) break;
          const [n, h] = len;
          const word = buf.subarray(i + h, i + h + n).toString("utf8");
          i += h + n;
          if (n === 0) {
            handle(sentence);
            sentence = [];
          } else sentence.push(word);
        }
        buf = buf.subarray(i);
      });
      sock.on("error", (e) => fail(new RouterOSError(`Cannot reach ${this.cfg.host}:${port}: ${e.message}`)));
      sock.on("close", () => fail(new RouterOSError(`Connection to ${this.cfg.host} closed unexpectedly`)));
    });
  }

  async print(path: string, filter: Record<string, RosValue> = {}, proplist?: string[]): Promise<RosRecord[]> {
    const words = [`/${normalizePath(path)}/print`, ...Object.entries(filter).map(([k, v]) => `?${k}=${v}`)];
    if (proplist?.length) words.push(`=.proplist=${proplist.join(",")}`);
    return (await this.run(words)).rows;
  }

  async query(path: string, query: string[], proplist?: string[]): Promise<RosRecord[]> {
    const words = [`/${normalizePath(path)}/print`, ...query.map(toApiQuery)];
    if (proplist?.length) words.push(`=.proplist=${proplist.join(",")}`);
    return (await this.run(words)).rows;
  }

  async add(path: string, props: Record<string, RosValue>): Promise<unknown> {
    const { done } = await this.run([`/${normalizePath(path)}/add`, ...attrs(props)]);
    return { ".id": done.ret, ...props };
  }

  async set(path: string, id: string, props: Record<string, RosValue>): Promise<unknown> {
    await this.run([`/${normalizePath(path)}/set`, `=.id=${id}`, ...attrs(props)]);
    return { ".id": id, ...props };
  }

  async setSingleton(path: string, props: Record<string, RosValue>): Promise<unknown> {
    await this.run([`/${normalizePath(path)}/set`, ...attrs(props)]);
    return props;
  }

  async remove(path: string, id: string): Promise<unknown> {
    await this.run([`/${normalizePath(path)}/remove`, `=.id=${id}`]);
    return null;
  }

  async command(path: string, params: Record<string, RosValue | RosValue[]> = {}, timeoutMs?: number): Promise<unknown> {
    const { rows, done } = await this.run([`/${normalizePath(path)}`, ...attrs(params)], timeoutMs);
    return rows.length ? rows : done;
  }
}
