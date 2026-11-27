# Topolore

A 3D viewer for infrastructure. Give it a topology file and, if you like, a stream of updates. It draws:

- groups (cloud, region, VPC, cluster, namespace) as stacked plates;
- services as shaped blocks with AWS, GCP, Azure, Kubernetes or vendor icons;
- connections as arcs with flow particles that move in the direction of traffic.

States show as they change: a service on fire, down or degraded; a link slow or broken.

Controls:
- **Camera:** drag to rotate, right-drag to pan, scroll to zoom, or use **Iso**, **3D** and **Top**; **Fit** brings everything back into view, **Rotate** (or `?rotate`) turns it slowly.
- **Inspect:** hover for a title; click a node, link or group to see its details and connections; Esc clears the selection.

```sh
make dev        # installs if needed, starts Vite and opens the browser (reuses the tab where it can)
make build      # tests, then builds dist/
```

Or with pnpm directly:

```sh
pnpm install
pnpm dev        # http://localhost:5173
pnpm test
pnpm build      # dist/
pnpm artifact   # dist/artifact.html, one self-contained page
pnpm icons      # regenerate src/lib/icons.json from @iconify-json/logos
```

Load your own file with **Open file**, drag and drop, **Paste** (a text box), or `?src=<url>`. Connect a stream with
the URL box or `?stream=<url>` (`?events=<url>` is the same). **Simulate** plays the sample's recorded events, or makes
up traffic and incidents for any other file. ◐ switches between light and dark and remembers the choice.

Without `?src` or `#infra`, the page opens the default sample from `samples/` next to it and plays its events. A
source of your own plays nothing unless you pass `?stream`/`?events`.

Samples live in `public/samples/` and ship with the site. Files in `private/` (gitignored) show up in the
picker only under `pnpm dev`, never in a build; a `name.jsonl` beside `name.hcl` becomes its events.

## Links that carry the file

Like PlantUML links, a URL can hold the whole file: `#infra=<value>`, or `?infra=<value>`.
- The value is the file's text, deflated (raw, no zlib header), then base64url-encoded. Plain base64url is accepted too.
- **Share link** builds one for whatever is loaded and copies it to the clipboard.
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
- `?readonly` leaves only watching: no sample picker, Paste, Open file, drag and drop, stream box or Simulate. A `stream`
  given in the link still connects.

Colours follow the category of each node: compute blue, data purple, network teal, messaging pink, security indigo,
SaaS lime. Pipes run cyan to indigo as traffic grows; amber is slow, red is broken.

## GitHub Pages

`.github/workflows/pages.yml` tests, builds and deploys `dist/` on every push to `main`, or when run by hand. Turn it on
once in the repository's **Settings → Pages → Source: GitHub Actions**.

## Files

**JSON** (`public/samples/multicloud.json`):

```json
{
  "title": "Shop",
  "groups": [{ "id": "gcp", "label": "GCP", "kind": "gcp" }],
  "nodes": [
    { "id": "api", "label": "api", "kind": "gcp.run", "parent": "gcp" },
    { "id": "db", "kind": "gcp.sql", "parent": "gcp", "state": "degraded", "message": "Replica lag" }
  ],
  "edges": [{ "from": "api", "to": "db", "protocol": "postgres", "rps": 300 }]
}
```

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
- **Generic and SaaS:** `db.postgresql`, `db.redis`, `saas.stripe`, `internet`.

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

A URL ending in `.jsonl` is a recording, replayed in a loop. Each line is an update plus when it happens: `t` seconds
from the start, or an ISO `at` timestamp counted from the first one (a line with neither follows the one before).
Lines starting with `//` are comments. See `public/samples/platform.jsonl`.

```jsonc
{ "t": 0, "type": "edge", "id": "checkout->payments", "rps": 900 }
{ "t": 12.5, "type": "node", "id": "orders", "state": "fire", "message": "CPU 99%" }
```

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).
- You may use, change and share Topolore, commercially too.
- Anything you distribute that includes or is derived from it must also be released under the GPL, with its source.
- It cannot be folded into a closed-source product.

Icons come from [Iconify's `logos` set](https://github.com/gilbarbara/logos) (CC0). The cloud, Kubernetes and vendor
marks are trademarks of their owners.
