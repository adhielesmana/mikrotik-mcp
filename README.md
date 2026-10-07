# MikroTik MCP Server

[![MCP](https://img.shields.io/badge/MCP-stdio-blue)](https://modelcontextprotocol.io)
[![RouterOS](https://img.shields.io/badge/RouterOS-v7%20%7C%20v6.43%2B-red)](https://manual.mikrotik.com/docs/introduction)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green)](https://nodejs.org)

An MCP server (TypeScript, stdio) that lets Claude or any MCP client **manage MikroTik routers without answering from memory**. Every answer is meant to come from one of two sources:

1. **MikroTik's official documentation**, stored locally and searched verbatim:
   - [manual.mikrotik.com](https://manual.mikrotik.com/docs/introduction): the current RouterOS v7 manual, about 1,470 pages including the CLI reference for every menu. This is the primary source.
   - [help.mikrotik.com](https://help.mikrotik.com/docs/): the older documentation site, about 320 pages, e.g. *Moving from ROSv6 to v7 with examples*.
2. **Real output from your routers**: RouterOS v7 through the REST API, or v6.43+/v7 through the classic API (port 8728/8729).

No tool returns model-written knowledge. Every change is previewed and needs your explicit approval before it touches a router.

## Quick start

```bash
git clone https://github.com/adhielesmana/mikrotik-mcp.git
cd mikrotik-mcp
npm install
npm run scrape   # download the official docs into ./docs (~2 min)
npm run build
claude mcp add mikrotik -e MIKROTIK_HOST=192.168.88.1 -e MIKROTIK_USER=mcp -e MIKROTIK_PASSWORD=secret -e MIKROTIK_INSECURE=true -- node "$PWD/dist/index.js"
```

Then ask, for example:
- *"Run a health check on my router"*: read-only, with each finding cited to the manual
- *"How do I set up bridge VLAN filtering?"*: answered from the manual, with links
- *"Which PPPoE customers on profile 10M are offline?"*
- *"Disable cust001"*: shows a preview, waits for your approval, applies, then shows the diff
- *"Make 50 one-day hotspot vouchers with prefix WF"*

## Example session

```text
You:    Add 10.10.10.1/24 on ether2
Claude: → mikrotik_search_manual "ip address add"        (cites docs/…/cli-reference/ip/address.md)
        → mikrotik_safe_write operation=add path=ip/address values={address:10.10.10.1/24, interface:ether2}
        PREVIEW ONLY — nothing has been changed
          command: /ip/address/add address=10.10.10.1/24 interface=ether2
          current: /ip/address has 1 item
        Apply this change?
You:    yes
Claude: → mikrotik_safe_write confirmToken=…              (your client may also ask you in a dialog)
        APPLIED: created *21 address=10.10.10.1/24 interface=ether2
```

## Tools

**Documentation (grounding)**

| Tool | What it does |
|---|---|
| `mikrotik_search_manual` | Full-text search over both sites. Returns site, page title, section, a verbatim excerpt, the file path and the URL. |
| `mikrotik_read_manual` | Full verbatim Markdown of a page or one section. Accepts a file path, either site's URL, or a console path like `/ip/firewall/filter`, which opens its CLI reference page. |

**Router: read-only**

| Tool | What it does |
|---|---|
| `mikrotik_list_routers` | Configured routers (no secrets) |
| `mikrotik_system_overview` | Identity, model, version, resources, health, clock, update status |
| `mikrotik_print` | Any documented menu (`/<menu>/print`) with filters, API queries, field selection |
| `mikrotik_get_config` | `/export terse` of the full config or one section (v7) |
| `mikrotik_get_logs` / `mikrotik_get_interfaces` / `mikrotik_get_routes` / `mikrotik_check_update` | Shortcuts for common read-only commands |
| `mikrotik_run_command` | Whitelisted read-only commands only: `print`, `ping`, `traceroute`, `torch`, `monitor`, `monitor-traffic`, `profile`, `check-for-updates` |
| `mikrotik_security_audit` | Observed risky settings, each citing the manual section that covers it |
| `mikrotik_subscribers` | PPPoE / hotspot accounts joined with their live sessions |

**Router: changes (always preview → user approval → apply)**

| Tool | What it does |
|---|---|
| `mikrotik_safe_write` | `add` / `set` / `remove` / `command` on any documented menu |
| `mikrotik_subscriber_action` | create / update / enable / disable (+ kick) / kick / delete a PPPoE or hotspot account |
| `mikrotik_hotspot_vouchers` | Generate a batch of hotspot vouchers |

Prompts: `mikrotik_health_check` (read-only, cited) and `mikrotik_safe_change` (manual lookup → preview → approve → verify).

## How the safeguards work

- **Server instructions.** The server tells the model never to answer RouterOS questions from memory, to cite the manual file or URL and the router command for every fact, and to copy syntax exactly.
- **Required wording in descriptions.** Every read tool says: *"Returns verbatim RouterOS CLI output or official manual text. Do not paraphrase syntax; copy exactly."*
- **Citations on every result.** Manual results carry `file` and `url`, plus `lastEdited` for help.mikrotik.com. Router results carry `source: {router, host, command}`.
- **No guessed menu paths.** Every model-supplied path is checked against the menus in the manual (CLI reference plus the manual's own code examples) *before* anything is sent to the router. An unknown path is refused with *"search the manual first"* and the closest documented menus, e.g. `ip/adress` → `/ip/address`.
- **Syntax errors point to the manual.** If the router rejects syntax (`no such command`, `unknown parameter`, …), the error tells the model to look up the CLI reference instead of retrying guesses.
- **Read-only by default.** `mikrotik_run_command` refuses anything that isn't a read command, and refuses `file=` because that writes to storage.
- **Confirmed writes.**
  1. A write tool called without a token changes nothing. It reads the current state and returns a preview: the equivalent console command, the current values, a field-by-field diff for `set`, and a warning for reboot, reset, restore or upgrade.
  2. The preview includes a single-use `confirmToken` that expires in 10 minutes. The token is bound to exactly the previewed change.
  3. After the user approves, the tool is called again with the token. It applies the change, reads the router again and returns the actual before/after diff.
- **Direct confirmation from the user.** If your MCP client supports *elicitation* (e.g. Claude Code), the server also asks you directly in a dialog before applying, so the model cannot approve a change on your behalf.
- **Strict read-only mode.** `MIKROTIK_READONLY=true` removes every write tool.

These safeguards make answers *checkable*, but they can't make a model infallible. Use the citations to verify anything important.

## Setup

```bash
npm install
npm run scrape   # builds docs/ from manual.mikrotik.com + help.mikrotik.com (~2 min, ~16 MB)
npm run build
```

`docs/VERSION.json` records the scrape date, each site's page count and last-modified date, and `routerosStableAtScrape`, the latest stable RouterOS reported by `upgrade.mikrotik.com` (7.24.5 at the last scrape). Neither site tags its content with a single RouterOS version; both track current v7. Re-run `npm run scrape` to refresh.

> The documentation is MikroTik's copyrighted content. `docs/` is in `.gitignore`: publish the scraper, not the corpus.

### Router preparation

**RouterOS v7.1+ (REST, default)**
```
/user group add name=mcp policy=read,write,api,rest-api,test,policy,sensitive,reboot
/user add name=mcp group=mcp password=<strong> address=<mcp-host-ip>/32
```
HTTPS certificate, verbatim from the manual's [REST API › setup](https://manual.mikrotik.com/docs/developer-guides/rest-api) (replace `192.168.88.1` with the router's address):
```
/certificate/add name=rest-ca common-name=rest-ca \
    key-usage=key-cert-sign,crl-sign days-valid=3650
/certificate/sign rest-ca
:delay 3s
/certificate/add name=rest-https common-name=192.168.88.1 \
    subject-alt-name=IP:192.168.88.1 days-valid=365
/certificate/sign rest-https ca=rest-ca
:delay 3s
/certificate/export-certificate rest-ca file-name=rest-ca
/ip/service/set www-ssl certificate=rest-https disabled=no
```
Then restrict the service to the MCP host (`address=` on `/ip/service`, see [Services](https://manual.mikrotik.com/docs/system-information-and-utilities/services)).

**RouterOS v6.43+ (classic API)**: set `MIKROTIK_PROTOCOL=api` and enable `api-ssl` (8729, `MIKROTIK_TLS=true`). On a trusted network only, you can use `api` (8728, `MIKROTIK_TLS=false`). `mikrotik_get_config` needs v7. v6-only menus may not be in the v7 manual; set `MIKROTIK_MENU_CHECK=false` if one is refused.

Check every command above against the manual: [User](https://manual.mikrotik.com/docs/authentication-authorization-accounting/user), [Services](https://manual.mikrotik.com/docs/system-information-and-utilities/services), [REST API](https://manual.mikrotik.com/docs/developer-guides/rest-api) (or ask the server to search them). For monitoring only, use `group=read` and `MIKROTIK_READONLY=true`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MIKROTIK_HOST` / `MIKROTIK_USER` / `MIKROTIK_PASSWORD` | – / `admin` / – | Single router |
| `MIKROTIK_PROTOCOL` | `rest` | `rest` (v7) or `api` (v6.43+/v7) |
| `MIKROTIK_PORT`, `MIKROTIK_TLS`, `MIKROTIK_INSECURE` | auto, `true`, `false` | Port; encryption; accept self-signed certificate |
| `MIKROTIK_CONFIG` | – | JSON file with several routers (see `routers.example.json`) |
| `MIKROTIK_READONLY` | `false` | Remove all write tools |
| `MIKROTIK_MENU_CHECK` | `true` | Refuse menu paths not documented in the manual |
| `MIKROTIK_DOCS_DIR` | `./docs` | Corpus location |

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "mikrotik": {
      "command": "node",
      "args": ["/Users/you/MikroTikMCP/dist/index.js"],
      "env": { "MIKROTIK_HOST": "192.168.88.1", "MIKROTIK_USER": "mcp", "MIKROTIK_PASSWORD": "…", "MIKROTIK_INSECURE": "true" }
    }
  }
}
```

### Claude Code
```bash
claude mcp add mikrotik -e MIKROTIK_HOST=192.168.88.1 -e MIKROTIK_USER=mcp -e MIKROTIK_PASSWORD=… -e MIKROTIK_INSECURE=true -- node /Users/you/MikroTikMCP/dist/index.js
```

### Kimi Work / other MCP clients
Any client that supports **stdio** MCP servers can use the same three values: command `node`, args `["/path/to/MikroTikMCP/dist/index.js"]`, and the `MIKROTIK_*` environment variables above. Enter them wherever your client registers local MCP servers.

## Project layout

```
src/
  index.ts     server, grounding rules, documentation + router tools, prompts
  manual.ts    local docs corpus: loading, search, page reading, menu validation
  confirm.ts   preview → token → (elicitation) → apply flow for all writes
  isp.ts       PPPoE / hotspot subscriber and voucher tools
  routeros.ts  RouterOS v7 REST client
  api.ts       RouterOS classic API client (v6.43+ / v7, ports 8728/8729)
  config.ts    env / multi-router config
  util.ts      shared helpers
scripts/
  scrape-docs.mjs  builds docs/ from manual.mikrotik.com (official .md copies) and help.mikrotik.com (Confluence API)
docs/          generated by `npm run scrape` (not committed)
```

## Disclaimer

This is an independent project and isn't affiliated with or endorsed by MikroTik. "MikroTik" and "RouterOS" are trademarks of their owner. The documentation corpus is downloaded from MikroTik's public sites onto your own machine and is not redistributed in this repository.
