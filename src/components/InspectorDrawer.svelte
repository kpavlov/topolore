<script lang="ts">
  import { iconDataUrl, lookOf } from "../lib/catalog.ts";
  import { flowSpeed, type Edge, type Infra, type InfraNode } from "../lib/model.ts";
  import type { Pick } from "../lib/scene.ts";
  import type { TopologyDiff } from "../graph/topology-diff.ts";
  import { highlightCode } from "../lib/highlight.ts";
  import { sourceBlock, type SourceFile } from "../parsers/index.ts";
  import { untrack } from "svelte";

  interface Props {
    infra: Infra;
    tick: number;
    selected: Pick;
    sources: SourceFile[];
    baseSources: SourceFile[];
    diff?: TopologyDiff;
    log: { at: string; text: string; tone: string; ids?: string[] }[];
    blast: string | null;
    open: boolean;
    onchoose: (pick: Pick) => void;
    onblast: () => void;
  }
  let { infra, tick, selected, sources, baseSources, diff, log, blast, open, onchoose, onblast }: Props = $props();

  let collapsed = $state(false);
  let copied = $state(false);

  const node = (id: string) => infra.nodes.find((n) => n.id === id);
  const name = (id: string) => node(id)?.label ?? id;
  const tone = (state = "ok") => ({ fire: "fire", down: "crit", broken: "crit", degraded: "warn", slow: "warn", ok: "ok" })[state] ?? "idle";
  const show = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v));
  const percent = (v: number) => `${(v * 100).toFixed(1)}%`;

  /** What the node is taking right now, from the links into it. */
  function traffic(ins: Edge[]): [string, string][] {
    const rated = ins.filter((e) => e.rps !== undefined);
    const rps = rated.reduce((sum, e) => sum + e.rps!, 0);
    const latencies = ins.flatMap((e) => (e.latencyMs === undefined ? [] : [e.latencyMs]));
    const failing = rated.filter((e) => e.errorRate !== undefined);
    const out: [string, string][] = [];
    if (rated.length) out.push(["Requests", `${Math.round(rps)} req/s`]);
    if (latencies.length) out.push(["Latency (worst)", `${Math.max(...latencies)} ms`]);
    if (failing.length && rps) out.push(["Errors", percent(failing.reduce((sum, e) => sum + e.errorRate! * e.rps!, 0) / rps)]);
    return out;
  }

  let view = $derived.by(() => {
    tick; // the infrastructure changes in place
    if (!selected) return null;
    const { id } = selected;
    if (selected.type === "node") {
      const n = node(id);
      if (!n) return null;
      const directed = infra.edges.filter((e) => !e.undirected);
      const lists = [
        { title: "Inbound / Callers", links: directed.filter((e) => e.to === n.id).map((e) => ({ e, other: e.from })) },
        { title: "Outbound / Dependencies", links: directed.filter((e) => e.from === n.id).map((e) => ({ e, other: e.to })) },
        { title: "Shares a network", links: infra.edges.filter((e) => e.undirected && (e.from === n.id || e.to === n.id)).map((e) => ({ e, other: e.from === n.id ? e.to : e.from })) },
      ].filter((l, i) => i < 2 || l.links.length);
      return {
        kind: "node" as const, n: { ...n }, look: lookOf(n.kind), lists,
        metrics: [...traffic(infra.edges.filter((e) => e.to === n.id)), ...Object.entries(n.metrics ?? {}).map(([k, v]): [string, string] => [k, String(v)])],
        events: log.filter((entry) => entry.ids?.includes(n.id)).slice(0, 5),
        change: diff?.nodes.get(n.id),
        changes: diff?.changes.get(n.id) ?? [],
        attributes: Object.entries(n.props ?? {}).map(([k, v]) => [k, show(v)]),
      };
    }
    if (selected.type === "edge") {
      const e = infra.edges.find((e) => e.id === id);
      if (!e) return null;
      const rows = [
        ["Protocol", e.protocol], ["Traffic", e.rps !== undefined ? `${e.rps} req/s` : undefined],
        ["Latency", e.latencyMs !== undefined ? `${e.latencyMs} ms` : undefined], ["Speed", flowSpeed(e, infra)],
        ["Errors", e.errorRate !== undefined ? percent(e.errorRate) : undefined], ["Label", e.label], ["Change", diff?.edges.get(e.id)],
      ].filter(([, v]) => v !== undefined) as [string, string][];
      return { kind: "edge" as const, e: { ...e }, rows };
    }
    const g = infra.groups.find((g) => g.id === id);
    return g ? { kind: "group" as const, g: { ...g }, members: infra.nodes.filter((n) => n.parent === g.id).map((n) => ({ ...n })) } : null;
  });

  // Finding the source may parse a large file, so it follows the selection and not every traffic update.
  let nodeId = $derived(view?.kind === "node" ? view.n.id : undefined);
  let removed = $derived(view?.kind === "node" && view.change === "removed");
  let code = $derived.by(() => {
    const id = nodeId;
    const files = removed ? baseSources : sources;
    return untrack(() => {
      const n: InfraNode | undefined = id ? node(id) : undefined;
      return n && sourceBlock(n, files);
    });
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(code ?? "");
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {}
  }
</script>

<aside class="panel drawer" class:open={open && view} aria-label="Details">
  {#if view}
    <div class="controls">
      <button onclick={() => (collapsed = !collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? "Expand details" : "Collapse details"}>{collapsed ? "▸" : "▾"}</button>
      <button onclick={() => onchoose(null)} aria-label="Close">✕</button>
    </div>
    {#if view.kind === "node"}
      <div class="head">
        {#if iconDataUrl(view.look.icon)}<img src={iconDataUrl(view.look.icon)} alt="" />{/if}
        <div><h2>{view.n.label}</h2><code>{view.n.kind}</code></div>
      </div>
      {#if !collapsed}
        <p class="state {tone(view.n.state)}">{view.n.state ?? "ok"}{view.n.message ? ` — ${view.n.message}` : ""}</p>
        {#if view.n.sourceFile}<span class="badge file">{view.n.sourceFile}{view.n.lineStart ? `:${view.n.lineStart}` : ""}</span>{/if}
        <button class="blast" class:on={blast === view.n.id} onclick={onblast} aria-keyshortcuts="B">Blast radius <kbd>B</kbd></button>

        {#if view.change && view.change !== "unchanged"}
          <h3>Diff: {view.change}</h3>
          {#if view.changes.length}
            <dl>{#each view.changes as c}<dt>{c.key}</dt><dd><del>{c.before ?? "—"}</del> → <ins>{c.after ?? "—"}</ins></dd>{/each}</dl>
          {/if}
        {/if}

        {#if view.metrics.length || view.events.length}
          <h3>Live metrics</h3>
          <dl>{#each view.metrics as [k, v]}<dt>{k}</dt><dd>{v}</dd>{/each}</dl>
          {#each view.events as entry}<div class="event"><time>{entry.at}</time><i class="dot {entry.tone}"></i>{entry.text}</div>{/each}
        {/if}

        {#each view.lists as list}
          <h3>{list.title} ({list.links.length})</h3>
          <ul>
            {#each list.links as { e, other }}
              <li><button onclick={() => onchoose({ type: "node", id: other })}><i class="dot {tone(node(other)?.state)}"></i>{name(other)}<small>{e.protocol ?? ""} {e.rps ? `${e.rps}/s` : ""}</small></button></li>
            {/each}
          </ul>
        {/each}

        {#if view.attributes.length}
          <h3>Attributes</h3>
          <dl>{#each view.attributes as [k, v]}<dt>{k}</dt><dd>{v}</dd>{/each}</dl>
        {/if}

        {#if code}
          <h3>Source <button class="copy" onclick={copy}>{copied ? "Copied" : "Copy"}</button></h3>
          <pre>{#each highlightCode(code) as piece}<span class={piece.cls}>{piece.text}</span>{/each}</pre>
        {/if}
      {/if}
    {:else if view.kind === "edge"}
      <div class="head"><div><h2>{name(view.e.from)} → {name(view.e.to)}</h2><code>connection</code></div></div>
      {#if !collapsed}
        <p class="state {tone(view.e.state)}">{view.e.state ?? "ok"}{view.e.message ? ` — ${view.e.message}` : ""}</p>
        <dl>{#each view.rows as [k, v]}<dt>{k}</dt><dd>{v}</dd>{/each}</dl>
        <ul>
          <li><button onclick={() => onchoose({ type: "node", id: view!.kind === "edge" ? view!.e.from : "" })}>From: {name(view.e.from)}</button></li>
          <li><button onclick={() => onchoose({ type: "node", id: view!.kind === "edge" ? view!.e.to : "" })}>To: {name(view.e.to)}</button></li>
        </ul>
      {/if}
    {:else}
      <div class="head"><div><h2>{view.g.label}</h2><code>{view.g.kind ?? "group"}</code></div></div>
      {#if !collapsed}
        <ul>
          {#each view.members as n}<li><button onclick={() => onchoose({ type: "node", id: n.id })}><i class="dot {tone(n.state)}"></i>{n.label}</button></li>{/each}
        </ul>
      {/if}
    {/if}
  {/if}
</aside>

<style>
  .drawer { top: 12px; right: max(16px, env(safe-area-inset-right)); width: 320px; max-height: calc(100% - 24px); overflow: auto;
    padding: 14px; display: none; z-index: 2; }
  .drawer.open { display: block; }
  .controls { position: absolute; top: 8px; right: 8px; display: flex; }
  .controls button { border: none; padding: 2px 8px; }
  .head { display: flex; gap: 10px; align-items: center; padding-right: 56px; }
  .head img { width: 36px; height: 36px; }
  .file { display: inline-block; text-transform: none; overflow-wrap: anywhere; }
  .blast { display: block; margin-top: 8px; }
  kbd { font: 11px var(--mono); border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; opacity: 0.7; }
  del { color: var(--crit); } ins { color: var(--ok); text-decoration: none; }
  .event { font-size: 12px; margin-top: 3px; }
  .event time { color: var(--muted); font: 11px var(--mono); margin-right: 8px; }
  li button { width: 100%; text-align: left; border: none; padding: 4px 6px; display: flex; align-items: center; gap: 2px; }
  li button:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
  li small { margin-left: auto; color: var(--muted); font-family: var(--mono); }
  .copy { font-size: 11px; padding: 1px 8px; float: right; text-transform: none; }
  pre { margin: 6px 0 0; padding: 8px; max-height: 260px; overflow: auto; font: 11px/1.5 var(--mono); background: var(--scene);
    border: 1px solid var(--line); border-radius: 6px; }
  .comment { color: var(--muted); font-style: italic; } .key { color: var(--accent); }
  .string { color: var(--ok); } .number { color: var(--warn); }
  @media (max-width: 720px) {
    .drawer { top: auto; bottom: 0; left: 0; right: 0; width: auto; max-height: 45%; border-radius: 12px 12px 0 0;
      padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  }
</style>
