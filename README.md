# Topolore

A 3D viewer for infrastructure. Give it a topology file and, if you like, a stream of updates. It draws:

- groups (cloud, region, VPC, cluster, namespace) as stacked plates;
- services as shaped blocks with AWS, GCP, Azure, Kubernetes or vendor icons;
- connections as arcs with flow particles that move in the direction of traffic.

States show as they change: a service on fire, down or degraded; a link slow or broken.

Controls:
- **Camera:** drag to rotate, right-drag to pan, scroll to zoom, or use **Iso**, **3D** and **Top**. Large topologies initially open zoomed in so labels are readable; your zoom is then remembered locally. **Fit** brings everything into view. **Rotate** cycles counterclockwise, stopped, clockwise, stopped; `?rotate` starts counterclockwise.
- **Inspect:** hover for a title; click a node, link or group to see its details and connections; Esc clears the selection. Search nodes with **Search** or Cmd+K / Ctrl+K.
- **Explore:** click legend filters to isolate categories or states; Shift-, Ctrl-, or Cmd-click combines them. Select a node and press **Blast radius** or B to see its callers and dependencies.
- **Compare and export:** use **Diff / Compare** for before and after files, and **Export** for PNG, SVG or Mermaid.

```sh
make dev        # installs if needed, starts Vite and opens the browser (reuses the tab where it can)
make build      # tests, then builds dist/
```

Or with pnpm directly:

```sh
pnpm install
pnpm dev        # http://localhost:5173
pnpm test
pnpm typecheck
pnpm build      # dist/
pnpm artifact   # dist/artifact.html, one self-contained page
pnpm icons      # regenerate src/lib/icons.json from @iconify-json/logos
```

Load files or folders with **Open**, drag and drop, or `?src=<url>`. **Open → URL** loads a topology URL, and **Open → Edit / paste** accepts pasted text.
Supported inputs include Terraform `.tf` and `.tf.json` files, `terraform show -json` output, Docker Compose,
Kubernetes YAML, Topolore JSON and `.topolore.json` snapshots. Terraform references can link across files in a folder.
Connect a stream with
the URL box or `?stream=<url>` (`?events=<url>` is the same). **Simulation** plays the sample's recorded events, or makes
up traffic and incidents for any other file. ◐ switches between light and dark and remembers the choice.

Without `?src` or `#infra`, the page opens the default sample from `samples/` next to it and plays its events. A
source of your own plays nothing unless you pass `?stream`/`?events`.

**Open → Samples** groups examples and postmortem recordings. Samples live in `public/samples/`, with their labels,
groups and file names listed in `public/samples/index.json`. Files in `private/` (gitignored) appear under Local only
under `pnpm dev`, never in a build; a `name.jsonl` beside `name.hcl` becomes its events.

Choosing a sample or URL and connecting a stream updates the address (`?sample=`, `?src=` and `?stream=`), so reload,
Back and Forward reopen the same source and recording. Remote sources must allow access from the site. URLs can contain
credentials: review them before sharing. Local files are available only on the device where they were opened.

## Links that carry the file

Like PlantUML links, a URL can hold the whole file: `#infra=<value>`, or `?infra=<value>`.
- The value is the file's text, deflated (raw, no zlib header), then base64url-encoded. Plain base64url is accepted too.
- **Share URL** scans the source for potential secrets and offers redaction, a compact link and a downloadable snapshot.
  Detection is best effort: check sensitive content before sharing. Long URLs may be truncated; snapshots can be dropped back into Topolore.
- Prefer `#infra=`: the hash never reaches a server, so neither the file nor its length limits do.

From a shell:

```sh
python3 -c "import sys,zlib,base64;print(base64.urlsafe_b64encode(zlib.compress(sys.stdin.buffer.read(),9)[2:-4]).decode().rstrip('='))" < infra.hcl
# open https://kpavlov.github.io/topolore/#infra=<output>
```

## Highlight and view-only links

- `?highlight=k8s,aws.rds,issues` brings the matching nodes forward and dims the rest. A term matches a node's id, label,
  kind (or kind prefix, so `aws` matches every AWS node) or any group it sits in, ignoring case. `issues` matches every
  node that is not ok and both ends of slow or broken links.
- **Highlight** opens a panel for the same terms, with quick picks for `issues`, providers and groups; it keeps the
  `highlight` parameter in the address bar, so the link shares what you see.
- `?readonly` leaves only watching: no Open menu, drag and drop, stream box or Simulation. A `stream`
  given in the link still connects.

Colours follow the category of each node: compute blue, data purple, network teal, messaging pink, security indigo,
SaaS lime. Pipes run cyan to indigo as traffic grows; amber is slow, red is broken.

## Agents (WebMCP)

The page offers its tools to agents through [WebMCP](https://webmachinelearning.github.io/webmcp/)
(`document.modelContext`):

| Tool | Does |
|---|---|
| `get_topology` | Reads the infrastructure, states, selection, view, simulation, last error and recent events |
| `apply_updates` | Sends events in the [update stream](#update-stream) format and reports each rejected one |
| `load_infra` | Loads JSON, HCL or Terraform text |
| `set_view` | Sets highlight, selection and camera |
| `set_simulation` | Starts or stops the simulation; it starts by itself with a sample, so turn it off before testing |

With `?readonly`, only `get_topology` and `set_view` are offered. The public site and builds work with a browser's
built-in WebMCP only.

For local agents such as Claude Code, `pnpm dev` also loads a WebMCP runtime and
[relay](https://www.npmjs.com/package/@mcp-b/webmcp-local-relay) script from jsDelivr. The relay runs on your machine:

1. Start `make dev` and open exactly `http://localhost:5173`; `127.0.0.1` or another port is refused.
2. Start the relay: restart Claude Code in this repository and approve the `topolore` server from `.mcp.json`. To look
   around by hand, run `make inspector` instead, press **Connect**, then **List Tools**.
3. No page tools, only `webmcp_*`? Reload the tab. A page that found no relay checks again only now and then.

While `pnpm dev` runs, those third-party scripts share the page with anything loaded from `private/`, and a connected
agent can read it.

## GitHub Pages

`.github/workflows/pages.yml` tests, builds and deploys `dist/` on every push to `main`, or when run by hand. Turn it on
once in the repository's **Settings → Pages → Source: GitHub Actions**.

## Files

**JSON** (`public/samples/multicloud.json`):

```json
{
  "title": "Shop",
  "links": [{ "label": "Postmortem", "url": "https://example.com/postmortem" }],
  "groups": [{ "id": "gcp", "label": "GCP", "kind": "gcp" }],
  "nodes": [
    { "id": "api", "label": "api", "kind": "gcp.run", "parent": "gcp" },
    { "id": "db", "kind": "gcp.sql", "parent": "gcp", "state": "degraded", "message": "Replica lag" }
  ],
  "edges": [{ "from": "api", "to": "db", "protocol": "postgres", "rps": 300 }]
}
```

Optional `links` appear beside the topology title; use absolute HTTP or HTTPS URLs for postmortems or other references.

**HCL** (`public/samples/platform.hcl`). Blocks nest the way groups do:

```hcl
title = "Shop"
group "gcp" { kind = "gcp"
  node "api" { kind = "gcp.run"  calls = ["db"] }
  node "db"  { kind = "gcp.sql" }
}
edge "api" "db" { protocol = "postgres"  rps = 300 }
```

**Terraform** (`public/samples/serverless.tf`):
- Each `resource` becomes a node, and a reference from one resource to another becomes an edge.
- References are found in attributes, nested blocks and `${...}` interpolations.
- `group = "..."` places a resource on a plate.
- `module`, `provider` and `locals` wrappers are looked through.

**Kinds** are `provider.service`:
- **Providers:** `aws.rds`, `aws.lambda`, `gcp.pubsub`, `azure.cosmos`, `cloudflare.cdn`.
- **Kubernetes:** `k8s.deployment`, `k8s.statefulset`, `helm.release`.
- **Generic and SaaS:** `db.postgresql`, `db.redis`, `saas.stripe`, `internet`, `user`, `customers`, `client.mobile`, `browser`, `partner`.

The kind picks the icon, the shape (database, bucket, queue, gateway, …) and the tint. An unknown service falls back to
its provider's logo with a short badge.

**Flow speed:** each pipe's colour wave moves `slow`, `medium` or `fast`. Set `speed` on an edge (HCL: `speed = "fast"`),
or let `latencyMs` decide (HCL: `latency_ms`): under 50 ms fast, under 250 ms medium, otherwise slow. With neither, the
infrastructure decides: both ends in the same network (a shared group below the top level, such as a VPC or cluster)
is fast, the same cloud or region medium, and across clouds or to anything outside every group (internet, SaaS) slow. Pipe colour shows
traffic (`rps`), from teal when light to cobalt when heavy.

**States:**
- Nodes: `ok`, `degraded`, `down`, `fire`, `unknown`.
- Edges: `ok`, `slow`, `broken`, `idle`.

## Update stream

See the [event log format guide](public/docs/event-log.md) for timestamps, update commands, capacity and scaling examples.

A `ws://`/`wss://` URL opens a WebSocket; an `http(s)://` URL opens Server-Sent Events. Each message is one update, a
JSON array of them, or newline-separated JSON:

```jsonc
{ "type": "node", "id": "db", "state": "fire", "message": "CPU 99%", "metrics": { "cpu": 0.99 } }
{ "type": "edge", "from": "api", "to": "db", "state": "slow", "latencyMs": 1400, "rps": 40 }
{ "type": "edge", "id": "api->db", "speed": "fast" }                           // flow speed, else from latencyMs
{ "type": "node", "id": "cache", "kind": "gcp.memorystore", "parent": "gcp" }   // unknown id + kind: adds a node
{ "type": "edge", "from": "api", "to": "cache" }                                // unknown pair: adds an edge
{ "type": "group", "id": "eu", "label": "Europe" }
{ "type": "remove", "id": "cache" }                                             // node, group or edge, and its edges
{ "type": "snapshot", "nodes": [...], "edges": [...], "groups": [...] }          // replace the whole topology
```

State changes repaint in place; anything that changes the topology runs the layout again.

A URL ending in `.jsonl` is a recording. You can also open or drop a `.jsonl` file against the current topology, or
select it together with its topology file. Timed recordings show a bottom timeline with play, pause, rewind, seeking
and playback speed; **Dynamic** spaces nearby events to make them visible and is enabled by default. Choose a fixed speed, then Dynamic, to set its maximum. Playback stops at the end.
Rewinding reconstructs the topology from its state when replay began.
Each line is an update plus `t` seconds from the start, or an ISO `at` timestamp. Timestamps may include `Z` or an
offset such as `+02:00`; timestamps without an offset use UTC. The timeline displays UTC. Lines must be in chronological
order; a line with neither time follows the previous line. Lines starting with `//` are comments.

```jsonc
{ "t": 0, "type": "edge", "id": "checkout->payments", "rps": 900 }
{ "t": 12.5, "type": "node", "id": "orders", "state": "fire", "message": "CPU 99%" }
{ "at": "2024-07-30T12:55:00+00:00", "type": "edge", "from": "api", "to": "backup", "rps": 100 }
```

Use node updates with a new `id` and `kind` to add instances, edge updates to add paths or change traffic, and `remove`
to remove a node or edge. Remove an old edge and add a new one to switch a path. A node removal also removes its edges.
See `public/samples/platform.jsonl` and the illustrative Azure Front Door incident sample, based on Microsoft's
[post-incident review](https://azure.status.microsoft/status/history/?trackingId=KTY1-HW8). The Azure sample's topology
is simplified; the documented event times describe the real incident. The GitHub Actions runner sample follows the
[May 2026 availability report](https://github.blog/news-insights/company-news/github-availability-report-may-2026/);
its topology and recovery node are schematic, and do not represent individual machines or reported capacity counts.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).
- You may use, change and share Topolore, commercially too.
- Anything you distribute that includes or is derived from it must also be released under the GPL, with its source.
- It cannot be folded into a closed-source product.

Icons come from [Iconify's `logos` set](https://github.com/gilbarbara/logos) (CC0). The cloud, Kubernetes and vendor
marks are trademarks of their owners.
