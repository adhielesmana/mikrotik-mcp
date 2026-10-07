import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local copy of MikroTik's official documentation (docs/, built by `npm run scrape`):
 *   docs/manual.mikrotik.com/...  current manual (primary; includes the CLI reference)
 *   docs/help.mikrotik.com/...    older Confluence documentation (secondary)
 * Everything returned from here is verbatim corpus text plus its file path and source URL.
 */

export interface Page {
  /** Path relative to docs/, without .md, e.g. "manual.mikrotik.com/firewall-and-quality-of-service/firewall/filter". */
  id: string;
  site: "manual.mikrotik.com" | "help.mikrotik.com";
  url: string;
  lastEdited?: string;
  title: string;
  text: string;
  lines: string[];
  sections: Section[];
}
interface Section {
  heading: string;
  level: number;
  start: number; // line index
  end: number; // exclusive
}

export const DOCS_DIR = process.env.MIKROTIK_DOCS_DIR ?? fileURLToPath(new URL("../docs", import.meta.url));
const MANUAL = "manual.mikrotik.com";
const HELP = "help.mikrotik.com";
const CLI_REF = `${MANUAL}/cli-reference/`;
/** help.mikrotik.com is older; rank its sections slightly below the current manual. */
const HELP_WEIGHT = 0.8;

/** Console commands that apply to any menu, so "<known menu>/<verb>" is a valid path. */
const MENU_VERBS = new Set([
  "print", "add", "set", "remove", "enable", "disable", "export", "find", "get", "edit", "comment",
  "move", "unset", "reset", "reset-counters", "reset-counters-all", "monitor", "make-static", "listen",
]);

let pages: Page[] | null = null;
let menus: Set<string> | null = null;
let version: Record<string, unknown> | null = null;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

function parseSections(lines: string[]): Section[] {
  const heads: { heading: string; level: number; start: number }[] = [];
  let inCode = false;
  lines.forEach((l, i) => {
    if (l.startsWith("```")) inCode = !inCode;
    const m = !inCode && l.match(/^(#{1,6})\s+(.*)$/);
    if (m) heads.push({ heading: m[2].trim(), level: m[1].length, start: i });
  });
  return heads.map((h, i) => {
    // A section runs until the next heading of the same or higher level.
    const next = heads.slice(i + 1).find((n) => n.level <= h.level);
    return { ...h, end: next ? next.start : lines.length };
  });
}

/** Menu paths found in the manual's RouterOS code examples, e.g. "/ip address add ..." → ip, ip/address, ip/address/add. */
function codePaths(text: string, into: Set<string>) {
  let lang: string | null = null;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("```")) {
      lang = lang === null ? raw.slice(3).trim() : null;
      continue;
    }
    if (lang === null || !["", "ros", "routeros", "text", "none"].includes(lang)) continue;
    const line = raw.replace(/^\s*\[[^\]]*\]\s*>\s*/, "").trim(); // strip "[admin@MikroTik] >" prompts
    if (!line.startsWith("/")) continue;
    const [first, ...rest] = line.split(/\s+/);
    const segs = first.slice(1).split("/").filter(Boolean);
    if (segs.length <= 1) for (const t of rest) { if (/^[a-z][a-z0-9-]*$/.test(t)) segs.push(t); else break; }
    if (!segs.every((s) => /^[a-z][a-z0-9-]*$/.test(s))) continue;
    for (let i = 1; i <= segs.length; i++) into.add(segs.slice(0, i).join("/"));
  }
}

export function loadManual(): { pages: Page[]; menus: Set<string> } {
  if (pages && menus) return { pages, menus };
  if (!existsSync(DOCS_DIR)) {
    throw new Error(`RouterOS manual not found at ${DOCS_DIR}. Run "npm run scrape" in the mikrotik-mcp folder.`);
  }
  pages = [];
  menus = new Set();
  for (const file of walk(DOCS_DIR)) {
    const id = relative(DOCS_DIR, file).split(sep).join("/").replace(/\.md$/, "");
    const site = id.startsWith(HELP + "/") ? HELP : MANUAL;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const sections = parseSections(lines);
    // help pages start with "<!-- source: URL | last edited: DATE -->" written by the scraper
    const meta = text.match(/^<!-- source: (\S+) \| last edited: ([\d-]+) -->/);
    const url = meta ? meta[1] : `https://${MANUAL}/docs/${id.slice(MANUAL.length + 1)}`;
    pages.push({ id, site, url, lastEdited: meta?.[2], title: sections[0]?.heading ?? id, text, lines, sections });
    if (id.startsWith(CLI_REF)) {
      const segs = id.slice(CLI_REF.length).split("/");
      for (let i = 1; i <= segs.length; i++) menus.add(segs.slice(0, i).join("/"));
    }
    codePaths(text, menus);
  }
  return { pages, menus };
}

export function manualVersion(): Record<string, unknown> {
  if (!version) {
    try {
      version = JSON.parse(readFileSync(join(DOCS_DIR, "VERSION.json"), "utf8"));
    } catch {
      version = { error: "docs/VERSION.json missing — run npm run scrape" };
    }
  }
  return version!;
}

const cite = (page: Page, heading?: string) => ({
  site: page.site,
  ...(page.lastEdited && { lastEdited: page.lastEdited }),
  file: `docs/${page.id}.md`,
  // Docusaurus anchors are slugified headings; Confluence anchors are not predictable, so link the page.
  url: page.url + (heading && page.site === MANUAL ? `#${heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-")}` : ""),
});

/**
 * Resolve a page reference: a file path from search results ("docs/manual.mikrotik.com/x.md"), a manual path
 * ("getting-started/securing-your-router"), a URL on either site, or a console menu path ("/ip/firewall/filter").
 */
export function findPage(ref: string): Page | undefined {
  const { pages } = loadManual();
  const r = ref.trim();
  const helpId = r.match(/help\.mikrotik\.com\/.*?(?:pages\/|pageId=)(\d+)/)?.[1] ?? r.match(/help\.mikrotik\.com\/(\d+)-/)?.[1];
  if (helpId) return pages.find((p) => p.id.startsWith(`${HELP}/${helpId}-`));
  const id = r
    .replace(/^https?:\/\/manual\.mikrotik\.com\/docs\//, `${MANUAL}/`)
    .replace(/^docs\//, "")
    .replace(/[#?].*$/, "")
    .replace(/\.md$/, "")
    .replace(/^\/+|\/+$/g, "");
  return (
    pages.find((p) => p.id === id) ??
    pages.find((p) => p.id === `${MANUAL}/${id}`) ??
    (r.startsWith("/") ? pages.find((p) => p.id === CLI_REF + id.replace(/\s+/g, "/")) : undefined)
  );
}

export function readPage(ref: string, section?: string, offset = 0, maxChars = 60_000) {
  const page = findPage(ref);
  if (!page) {
    const hits = searchManual(ref.replace(/[\/\-_]/g, " "), 5).results.map((r) => r.file);
    throw new Error(`No manual page "${ref}". Use mikrotik_search_manual to find it.${hits.length ? ` Closest: ${hits.join(", ")}` : ""}`);
  }
  let text = page.text;
  let heading: string | undefined;
  if (section) {
    const s = page.sections.find((x) => x.heading.toLowerCase() === section.toLowerCase()) ??
      page.sections.find((x) => x.heading.toLowerCase().includes(section.toLowerCase()));
    if (!s) {
      throw new Error(`Section "${section}" not in ${page.id}. Sections: ${page.sections.map((x) => x.heading).join(" | ")}`);
    }
    heading = s.heading;
    text = page.text.split("\n").slice(s.start, s.end).join("\n");
  }
  // Chunk long pages at line boundaries so every chunk is verbatim.
  let chunk = text.slice(offset);
  let nextOffset: number | undefined;
  if (chunk.length > maxChars) {
    const cut = chunk.lastIndexOf("\n", maxChars);
    chunk = chunk.slice(0, cut > 0 ? cut : maxChars);
    nextOffset = offset + chunk.length;
  }
  return {
    title: page.title,
    ...cite(page, heading),
    ...(heading && { section: heading }),
    ...(nextOffset !== undefined && {
      truncated: `Page continues — call again with offset=${nextOffset}, or pass a section.`,
      sections: page.sections.filter((s) => s.level <= 3).map((s) => s.heading),
    }),
    content: chunk,
  };
}

/** Full-text search over manual sections. Scores term hits, boosting headings, titles and exact phrases. */
export function searchManual(query: string, limit = 8) {
  const { pages } = loadManual();
  const q = query.toLowerCase().trim();
  const terms = [...new Set(q.split(/[^a-z0-9.\-/]+/).filter((t) => t.length > 1))];
  const pathLike = /^\/?[a-z0-9-]+(\/[a-z0-9-]+)+$/.test(q) ? q.replace(/^\//, "") : null;
  const results: { score: number; page: Page; sec: Section; lines: string[] }[] = [];

  for (const page of pages) {
    const lines = page.lines;
    const titleL = page.title.toLowerCase();
    for (const sec of page.sections.length ? page.sections : [{ heading: page.title, level: 1, start: 0, end: lines.length }]) {
      // Score only the section's own text (up to its first subsection) to avoid duplicates from nesting.
      const sub = page.sections.find((s) => s.start > sec.start && s.start < sec.end);
      const own = lines.slice(sec.start, sub ? sub.start : sec.end);
      const body = own.join("\n").toLowerCase();
      let score = 0;
      for (const t of terms) {
        const n = body.split(t).length - 1;
        if (!n) continue;
        score += Math.min(n, 10) + (sec.heading.toLowerCase().includes(t) ? 8 : 0) + (titleL.includes(t) ? 4 : 0);
      }
      if (terms.length > 1 && terms.every((t) => body.includes(t))) score *= 2;
      if (q.length > 3 && body.includes(q)) score += 15;
      if (pathLike && page.id === CLI_REF + pathLike) score += 100;
      if (page.site === HELP) score *= HELP_WEIGHT;
      if (score > 0) results.push({ score, page, sec, lines: own });
    }
  }
  results.sort((a, b) => b.score - a.score);

  return {
    query,
    manual: manualVersion(),
    results: results.slice(0, limit).map(({ page, sec, lines }) => {
      // Verbatim excerpt: whole lines around the first line containing a query term.
      const hit = Math.max(0, lines.findIndex((l) => terms.some((t) => l.toLowerCase().includes(t))));
      const from = Math.max(0, hit - 3);
      let excerpt = lines.slice(from, from + 18).join("\n");
      if (excerpt.length > 1500) excerpt = excerpt.slice(0, excerpt.lastIndexOf("\n", 1500));
      return { title: page.title, section: sec.heading, ...cite(page, sec.level > 1 ? sec.heading : undefined), excerpt };
    }),
  };
}

/** Is this console path documented in the manual (CLI reference or code examples)? */
export function isKnownMenu(path: string): boolean {
  const { menus } = loadManual();
  if (menus.has(path)) return true;
  const i = path.lastIndexOf("/");
  return i > 0 && menus.has(path.slice(0, i)) && MENU_VERBS.has(path.slice(i + 1));
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

/** Documented menus closest to a mistyped path — grounded suggestions, never invented ones. */
export function similarMenus(path: string, max = 6): string[] {
  const { menus } = loadManual();
  const last = path.split("/").pop() ?? path;
  const parent = path.split("/").slice(0, -1).join("/");
  const scored = [...menus].map((m) => {
    const ml = m.split("/").pop()!;
    const mp = m.split("/").slice(0, -1).join("/");
    const dist = editDistance(last, ml) + (mp === parent ? 0 : 2);
    return { m, dist: ml.includes(last) || last.includes(ml) ? Math.min(dist, 2) : dist };
  });
  return scored.filter((x) => x.dist <= 2).sort((a, b) => a.dist - b.dist).slice(0, max).map((x) => "/" + x.m);
}
