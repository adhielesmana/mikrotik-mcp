#!/usr/bin/env node
// Build the local documentation corpus in ./docs from MikroTik's two official documentation sites:
//  1. manual.mikrotik.com — current RouterOS manual. Its llms.txt links an official Markdown copy of every page,
//     saved byte-for-byte (no conversion).
//  2. help.mikrotik.com   — the older Confluence documentation (space ROS). Pages are fetched through Confluence's
//     REST API and converted HTML → Markdown (text unchanged; only markup is converted).
// Usage: npm run scrape   (re-run any time to refresh). Writes docs/VERSION.json.
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
const CONCURRENCY = 8;

async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "mikrotik-mcp-scraper" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

async function pool(items, fn) {
  const queue = [...items];
  let done = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let it; (it = queue.shift()) !== undefined; ) {
        await fn(it);
        if (++done % 100 === 0) console.error(`  ${done}/${items.length}`);
      }
    }),
  );
}

async function save(rel, text) {
  const file = join(OUT, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

// ---------------------------------------------------------------- manual.mikrotik.com
async function scrapeManual() {
  const BASE = "https://manual.mikrotik.com";
  const indexRes = await get(`${BASE}/llms.txt`);
  const index = await indexRes.text();
  const urls = [...new Set([...index.matchAll(/\]\((https:\/\/manual\.mikrotik\.com\/docs\/[^)\s]+\.md)\)/g)].map((m) => m[1]))];
  if (urls.length < 100) throw new Error(`manual: llms.txt lists only ${urls.length} pages — site layout changed?`);
  console.error(`manual.mikrotik.com: ${urls.length} pages`);
  const failed = [];
  await pool(urls, async (url) => {
    try {
      await save(join("manual.mikrotik.com", url.slice(`${BASE}/docs/`.length)), await (await get(url)).text());
    } catch (e) {
      failed.push(e.message);
    }
  });
  return { index: `${BASE}/llms.txt`, lastModified: indexRes.headers.get("last-modified"), pages: urls.length - failed.length, failed };
}

// ---------------------------------------------------------------- help.mikrotik.com (Confluence)
function converter() {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.use(gfm);
  // Confluence code macro: <pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: ros; ...">
  td.addRule("confluence-code", {
    filter: (node) => node.nodeName === "PRE",
    replacement: (_c, node) => {
      const brush = (node.getAttribute("data-syntaxhighlighter-params") ?? "").match(/brush:\s*([\w-]+)/)?.[1] ?? "";
      const lang = ["ros", "text", "bash", "js", "javascript", "python", "xml", "html", "sql", "java", "cpp"].includes(brush) ? brush : "";
      return `\n\n\`\`\`${lang}\n${node.textContent.replace(/\n$/, "")}\n\`\`\`\n\n`;
    },
  });
  // Info/note/warning panels → blockquotes, keeping their label.
  td.addRule("confluence-panel", {
    filter: (node) => node.nodeName === "DIV" && /confluence-information-macro(?!-)/.test(node.getAttribute("class") ?? ""),
    replacement: (content, node) => {
      const label = node.getAttribute("aria-label");
      return "\n\n" + `${label ? `**${label}:** ` : ""}${content.trim()}`.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
    },
  });
  td.remove(["style", "script", "colgroup"]);
  return td;
}

async function scrapeHelp() {
  const BASE = "https://help.mikrotik.com/docs";
  const pages = [];
  for (let start = 0; ; start += 100) {
    const d = await (await get(`${BASE}/rest/api/content?spaceKey=ROS&type=page&limit=100&start=${start}&expand=version`)).json();
    pages.push(...d.results.map((r) => ({ id: r.id, title: r.title, when: r.version.when, webui: r._links.webui })));
    if (!d._links.next) break;
  }
  console.error(`help.mikrotik.com: ${pages.length} pages`);
  const td = converter();
  const failed = [];
  await pool(pages, async (p) => {
    try {
      const d = await (await get(`${BASE}/rest/api/content/${p.id}?expand=body.export_view`)).json();
      const md = td.turndown(d.body.export_view.value);
      const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
      const header = `<!-- source: ${BASE}${p.webui} | last edited: ${p.when.slice(0, 10)} -->\n# ${p.title}\n\n`;
      await save(join("help.mikrotik.com", `${p.id}-${slug}.md`), header + md + "\n");
    } catch (e) {
      failed.push(`${p.title}: ${e.message}`);
    }
  });
  const newest = pages.map((p) => p.when).sort().pop();
  return { api: `${BASE}/rest/api/content?spaceKey=ROS`, newestEdit: newest, pages: pages.length - failed.length, failed };
}

// ---------------------------------------------------------------- run
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const manual = await scrapeManual();
const help = await scrapeHelp();
const stable = await get("https://upgrade.mikrotik.com/routeros/NEWESTa7.stable")
  .then((r) => r.text())
  .then((t) => t.trim().split(/\s+/)[0])
  .catch(() => null);

const version = {
  scrapedAt: new Date().toISOString(),
  routerosStableAtScrape: stable,
  note:
    "Neither site is tagged with a single RouterOS version; both document current RouterOS v7. routerosStableAtScrape is the latest stable release reported by upgrade.mikrotik.com when this copy was made. manual.mikrotik.com is the newer, primary source; help.mikrotik.com is the older documentation site.",
  sources: { "manual.mikrotik.com": manual, "help.mikrotik.com": help },
};
await writeFile(join(OUT, "VERSION.json"), JSON.stringify(version, null, 2) + "\n");
console.error(`Done: manual ${manual.pages} pages, help ${help.pages} pages, RouterOS stable ${stable}; failures: ${manual.failed.length + help.failed.length}`);
for (const f of [...manual.failed, ...help.failed]) console.error("  " + f);
