<script lang="ts">
  import { onMount } from "svelte";
  import { InfraScene, type Pick, type View } from "./lib/scene.ts";
  import { layout } from "./lib/layout.ts";
  import { applyUpdate, flowSpeed, highlighted, normalize, splitTerms, type Edge, type Infra, type InfraNode, type Update } from "./lib/model.ts";
  import { parseHcl } from "./lib/hcl.ts";
  import { connect, replay, simulate, type Status } from "./lib/stream.ts";
  import { iconDataUrl, lookOf } from "./lib/catalog.ts";
  import { decodeInfra, encodeInfra, infraParam } from "./lib/share.ts";

  type Sample = { label: string; read: () => Promise<string>; events?: () => Promise<string> };
  const fetchText = (url: string) => fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${url}: ${r.status} ${r.statusText}`))));
  // Samples are files on the site (public/samples), so links and streams can point at them too.
  const SAMPLES: Record<string, Sample> = {
    platform: { label: "Global retail platform (HCL)", read: () => fetchText("samples/platform.hcl"), events: () => fetchText("samples/platform.jsonl") },
    multicloud: { label: "Multi-cloud shop (JSON)", read: () => fetchText("samples/multicloud.json") },
    serverless: { label: "Serverless (Terraform)", read: () => fetchText("samples/serverless.tf") },
  };
  // private/ is gitignored and only `pnpm dev` lists it, never a build: real infrastructure stays local.
  // A `name.jsonl` beside `name.hcl` is that sample's events.
  if (import.meta.env.DEV) {
    const files = import.meta.glob<string>("../private/*.{hcl,json,tf,jsonl}", { query: "?raw", import: "default" });
    for (const [path, read] of Object.entries(files)) {
      const [, id, ext] = path.match(/([^/]+)\.(\w+)$/)!;
      const entry = (SAMPLES[id] ??= { label: `${id} (local)`, read: () => Promise.reject(new Error(`${id}: no infra file`)) });
      if (ext === "jsonl") entry.events = read;
      else entry.read = read;
    }
  }
  const loadSample = (id: string) => SAMPLES[id].read().then((t) => load(t, id), (e: Error) => void (error = e.message));

  let host: HTMLDivElement;
  let scene: InfraScene;
  let infra = $state.raw<Infra>({ groups: [], nodes: [], edges: [] });
  let tick = $state(0); // bumps when infra changes in place
  let selected = $state<Pick>(null);
  let hover = $state<{ pick: NonNullable<Pick>; x: number; y: number } | null>(null);
  let view = $state<View>("iso");
  let sample = $state("platform");
  let error = $state("");
  let streamUrl = $state("");
  let status = $state<Status>({ state: "idle" });
  let simulating = $state(false);
  let log = $state<{ at: string; text: string; tone: string }[]>([]);
  let dragging = $state(false);
  // `?name=` or `#name=`: the hash wins, since links that carry the file keep everything there.
  const urlParam = (name: string) => new URLSearchParams(location.hash.slice(1)).get(name) ?? new URLSearchParams(location.search).get(name);
  /** `?readonly`: watch only. Nothing that changes what is loaded (samples, files, paste, streams, simulation). */
  const readonly = urlParam("readonly") !== null && urlParam("readonly") !== "false";
  let terms = $state<string[]>(splitTerms(urlParam("highlight")));
  let filterOpen = $state(false);
  /** `?rotate`: start turning slowly, for a screen on the wall. */
  let rotating = $state(urlParam("rotate") !== null && urlParam("rotate") !== "false");
  let panel = $state(true);
  let source = ""; // text of the loaded file, for Paste and Share link
  let pasteDialog: HTMLDialogElement;
  let pasteText = $state("");
  let shared = $state("");
  let stop: (() => void) | undefined;
  let relayout: ReturnType<typeof setTimeout> | undefined;

  const node = (id: string) => infra.nodes.find((n) => n.id === id);
  const edge = (id: string) => infra.edges.find((e) => e.id === id);
  const name = (id: string) => node(id)?.label ?? id;
  const tone = (state = "ok") => ({ fire: "fire", down: "crit", broken: "crit", degraded: "warn", slow: "warn", ok: "ok" })[state] ?? "idle";

  function parse(text: string, file = "") {
    const json = file.endsWith(".json") || /^\s*[[{]/.test(text);
    return json ? normalize(JSON.parse(text)) : parseHcl(text);
  }

  async function load(text: string, file = "") {
    try {
      const next = parse(text, file);
      error = "";
      infra = next;
      source = text;
      selected = null;
      scene.select(null);
      scene.build(infra, await layout(infra), true);
      log = [];
      tick++;
    } catch (e) {
      error = `${file || "File"}: ${(e as Error).message}`;
    }
  }

  function note(text: string, state?: string) {
    log = [{ at: new Date().toLocaleTimeString(), text, tone: tone(state) }, ...log].slice(0, 40);
  }

  function onUpdate(u: Update) {
    const before =
      u.type === "node" ? node(u.id)?.state :
      u.type === "edge" ? edge(u.id ?? `${u.from}->${u.to}`)?.state : undefined;
    const topology = applyUpdate(infra, u);
    if (topology) {
      clearTimeout(relayout);
      relayout = setTimeout(async () => scene.build(infra, await layout(infra)), 150);
      note(u.type === "remove" ? `Removed ${u.id}` : `Topology changed (${u.type} ${"id" in u ? u.id ?? "" : ""})`);
    } else if (u.type === "node") {
      const n = node(u.id);
      if (n) scene.updateNode(n);
      if (n && u.state && u.state !== before) note(`${n.label}: ${u.state}${n.message ? ` — ${n.message}` : ""}`, u.state);
    } else if (u.type === "edge") {
      const e = edge(u.id ?? `${u.from}->${u.to}`);
      if (e) scene.updateEdge(e);
      if (e && u.state && u.state !== before) note(`${name(e.from)} → ${name(e.to)}: ${u.state}${e.message ? ` — ${e.message}` : ""}`, u.state);
    }
    tick++;
  }

  function stopStream() {
    stop?.();
    stop = undefined;
    simulating = false;
    status = { state: "idle" };
  }

  function toggleSimulation() {
    if (simulating) return stopStream();
    stopStream();
    simulating = true;
    // A sample with its own events replays them; anything else gets random incidents.
    const events = SAMPLES[sample]?.events;
    status = { state: "live", detail: events ? "replay" : "simulated" };
    if (!events) return void (stop = simulate(() => infra, onUpdate));
    let stopReplay = () => {};
    let stopped = false;
    stop = () => ((stopped = true), stopReplay());
    events().then((t) => void (stopped || (stopReplay = replay(t, onUpdate))), (e: Error) => void (error = e.message));
  }

  function connectStream(e: SubmitEvent) {
    e.preventDefault();
    stopStream();
    if (!streamUrl.trim()) return;
    stop = connect(streamUrl.trim(), onUpdate, (s) => {
      status = s;
      if (s.detail) note(s.detail);
    });
  }

  async function openFile(file?: File | null) {
    if (!file) return;
    stopStream();
    sample = "";
    await load(await file.text(), file.name);
  }

  function openPaste() {
    pasteText = source;
    pasteDialog.showModal();
  }

  async function applyPaste(e: SubmitEvent) {
    e.preventDefault();
    stopStream();
    sample = "";
    await load(pasteText, "Pasted text");
    if (!error) pasteDialog.close();
  }

  /** Puts the current file into the URL (#infra=…) and copies the link. */
  async function shareLink() {
    const url = new URL(location.href);
    url.searchParams.delete("src");
    url.searchParams.delete("infra");
    url.hash = `infra=${await encodeInfra(source)}`;
    history.replaceState(null, "", url);
    try {
      await navigator.clipboard.writeText(url.href);
      shared = "Link copied";
    } catch {
      shared = "Link is in the address bar";
    }
    setTimeout(() => (shared = ""), 2500);
  }

  /** Highlights these terms and keeps them in the URL (`?highlight=`), so the view can be shared. */
  function setTerms(next: string[]) {
    terms = next;
    const url = new URL(location.href);
    const hash = new URLSearchParams(url.hash.slice(1));
    hash.delete("highlight");
    url.hash = hash.toString();
    if (next.length) url.searchParams.set("highlight", next.join(","));
    else url.searchParams.delete("highlight");
    history.replaceState(null, "", url);
  }

  const toggleTerm = (term: string) =>
    setTerms(terms.some((t) => t.toLowerCase() === term.toLowerCase()) ? terms.filter((t) => t.toLowerCase() !== term.toLowerCase()) : [...terms, term]);

  function setView(v: View) {
    view = v;
    scene.setView(v);
  }

  function choose(pick: Pick) {
    selected = pick;
    scene.select(pick, true);
    panel = true;
  }

  onMount(() => {
    scene = new InfraScene(host);
    scene.setAutoRotate(rotating);
    scene.onSelect = (p) => (selected = p, p && (panel = true));
    scene.onHover = (pick, x, y) => (hover = pick ? { pick, x, y } : null);
    const src = urlParam("src");
    // `?stream=` (or `?events=`): a WebSocket, an SSE endpoint or a .jsonl recording.
    const stream = urlParam("stream") ?? urlParam("events");
    const inline = infraParam(new URL(location.href));
    if (inline || src) sample = "";
    const loaded =
      inline ? decodeInfra(inline).then((t) => load(t, "Link"), () => void (error = "The infra in this link cannot be decoded.")) :
      src ? fetchText(src).then((t) => load(t, src), (e: Error) => void (error = e.message)) :
      loadSample(sample);
    if (stream) {
      streamUrl = stream;
      stop = connect(stream, onUpdate, (s) => (status = s));
    } else if (!src && !inline) loaded.then(toggleSimulation); // your own infra gets no sample events

    // A pasted link that differs only in the hash does not reload the page.
    const onHash = () => {
      const value = infraParam(new URL(location.href));
      if (value) decodeInfra(value).then((t) => (stopStream(), (sample = ""), load(t, "Link")));
    };
    addEventListener("hashchange", onHash);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const restyle = () => scene.restyle();
    media.addEventListener("change", restyle);
    return () => {
      stopStream();
      media.removeEventListener("change", restyle);
      removeEventListener("hashchange", onHash);
      scene.dispose();
    };
  });

  const toggleTheme = () => {
    const root = document.documentElement;
    const dark = (root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch {}
    scene.restyle();
  };

  let highlight = $derived.by(() => {
    tick;
    return terms.length ? highlighted(infra, terms) : null;
  });
  $effect(() => {
    const ids = highlight;
    scene?.setHighlight(ids);
  });

  // Quick picks for the filter panel: issues, then providers and groups present in the file.
  let picks = $derived.by(() => {
    tick;
    const providers = [...new Set(infra.nodes.map((n) => n.kind.split(".")[0]))].sort();
    return { providers, groups: infra.groups.map((g) => g.label) };
  });

  let sel = $derived.by(() => {
    tick;
    if (!selected) return null;
    if (selected.type === "node") {
      const n = node(selected.id);
      return n && { kind: "node" as const, n, look: lookOf(n.kind), ins: infra.edges.filter((e) => e.to === n.id), outs: infra.edges.filter((e) => e.from === n.id) };
    }
    if (selected.type === "edge") {
      const e = edge(selected.id);
      return e && { kind: "edge" as const, e };
    }
    const g = infra.groups.find((g) => g.id === selected!.id);
    return g && { kind: "group" as const, g, members: infra.nodes.filter((n) => n.parent === g.id) };
  });

  let tip = $derived.by(() => {
    tick;
    if (!hover) return null;
    if (hover.pick.type === "node") {
      const n = node(hover.pick.id);
      return n && { title: n.label, sub: n.kind, state: n.state ?? "ok", message: n.message };
    }
    const e = edge(hover.pick.id);
    return e && {
      title: `${name(e.from)} → ${name(e.to)}`,
      sub: [e.protocol, e.label, e.rps !== undefined && `${e.rps} rps`, e.latencyMs !== undefined && `${e.latencyMs} ms`, `${flowSpeed(e, infra)} flow`].filter(Boolean).join(" · "),
      state: e.state ?? "ok", message: e.message,
    };
  });

  let health = $derived.by(() => {
    tick;
    const bad = infra.nodes.filter((n) => n.state && n.state !== "ok").length + infra.edges.filter((e) => e.state === "slow" || e.state === "broken").length;
    return { nodes: infra.nodes.length, edges: infra.edges.length, bad };
  });

  const metrics = (e: Edge) => [
    ["Protocol", e.protocol], ["Traffic", e.rps !== undefined ? `${e.rps} req/s` : undefined],
    ["Latency", e.latencyMs !== undefined ? `${e.latencyMs} ms` : undefined], ["Speed", flowSpeed(e, infra)],
    ["Errors", e.errorRate !== undefined ? `${(e.errorRate * 100).toFixed(1)}%` : undefined], ["Label", e.label],
  ].filter(([, v]) => v !== undefined) as [string, string][];
  const props = (n: InfraNode) => Object.entries({ ...n.props, ...n.metrics }).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
</script>

<svelte:window
  ondragover={(e) => (e.preventDefault(), (dragging = !readonly))}
  ondragleave={(e) => !e.relatedTarget && (dragging = false)}
  ondrop={(e) => (e.preventDefault(), (dragging = false), !readonly && openFile(e.dataTransfer?.files[0]))}
  onkeydown={(e) => e.key === "Escape" && choose(null)}
/>

<div class="app">
  <header>
    <div class="brand">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 21 7v10l-9 5-9-5V7z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 7l9 5 9-5M12 12v10" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
      <h1>Topolore</h1>
      {#if infra.title}<span class="title">{infra.title}</span>{/if}
    </div>
    <div class="tools">
      {#if readonly}<span class="badge" title="Opened with ?readonly">View only</span>{:else}
      <select bind:value={sample} onchange={() => (stopStream(), loadSample(sample).then(toggleSimulation))} aria-label="Sample">
        {#if !sample}<option value="">Your file</option>{/if}
        {#each Object.entries(SAMPLES) as [id, { label }]}<option value={id}>{label}</option>{/each}
      </select>
      <button onclick={openPaste}>Paste</button>
      {/if}
      <button onclick={shareLink} title="Copy a link that contains this infrastructure">{shared || "Share link"}</button>
      {#if !readonly}
      <label class="button">Open file<input type="file" accept=".json,.hcl,.tf" hidden onchange={(e) => openFile(e.currentTarget.files?.[0])} /></label>
      <form onsubmit={connectStream}>
        <input bind:value={streamUrl} placeholder="wss:// or https:// SSE stream" aria-label="Update stream URL" />
        <button>Connect</button>
      </form>
      <button class:on={simulating} onclick={toggleSimulation} title="Play the sample's events, or random incidents and traffic drift">{simulating ? "Stop simulation" : "Simulate"}</button>
      {/if}
      <button onclick={toggleTheme} title="Switch between light and dark" aria-label="Switch theme">◐</button>
      <span class="status" data-state={status.state}>{status.state === "live" && status.detail === "simulated" ? "simulating" : status.state}</span>
    </div>
  </header>

  <main>
    <div class="stage" bind:this={host}></div>

    <div class="views" role="group" aria-label="Camera">
      {#each [["iso", "Iso"], ["3d", "3D"], ["top", "Top"]] as [id, label]}
        <button class:on={view === id} onclick={() => setView(id as View)}>{label}</button>
      {/each}
      <button onclick={() => scene.zoomBy(1.25)} aria-label="Zoom in">+</button>
      <button onclick={() => scene.zoomBy(0.8)} aria-label="Zoom out">−</button>
      <button onclick={() => scene.setView(view)} title="Fit everything in view">Fit</button>
      <button class:on={rotating} onclick={() => scene.setAutoRotate((rotating = !rotating))} title="Turn the view slowly">Rotate</button>
      <button class:on={filterOpen || terms.length > 0} onclick={() => (filterOpen = !filterOpen)} aria-expanded={filterOpen}>
        Highlight{terms.length ? ` · ${highlight?.size ?? 0}` : ""}
      </button>
    </div>

    {#if filterOpen}
      <div class="filter">
        <label>
          <span>Names, ids, kinds or groups, comma-separated</span>
          <input value={terms.join(", ")} oninput={(e) => setTerms(splitTerms(e.currentTarget.value))} placeholder="orgs, aws.rds, k8s, issues" />
        </label>
        <h3>Quick picks</h3>
        <div class="chips">
          {#each ["issues", ...picks.providers] as term}
            <button class:on={terms.some((t) => t.toLowerCase() === term)} onclick={() => toggleTerm(term)}>{term}</button>
          {/each}
        </div>
        {#if picks.groups.length}
          <h3>Groups</h3>
          <div class="chips">
            {#each picks.groups as term}
              <button class:on={terms.some((t) => t.toLowerCase() === term.toLowerCase())} onclick={() => toggleTerm(term)}>{term}</button>
            {/each}
          </div>
        {/if}
        <div class="actions">
          <span>{terms.length ? `${highlight?.size ?? 0} of ${infra.nodes.length} nodes` : "Nothing highlighted"}</span>
          <button onclick={() => setTerms([])} disabled={!terms.length}>Clear</button>
        </div>
      </div>
    {/if}

    <div class="legend">
      <div><i class="dot ok"></i>{health.nodes} nodes · {health.edges} links</div>
      <div><i class="dot" class:crit={health.bad} class:ok={!health.bad}></i>{health.bad ? `${health.bad} open issues` : "all healthy"}</div>
      <div class="keys">
        <span><i class="dot fire"></i>on fire</span><span><i class="dot crit"></i>down / broken</span>
        <span><i class="dot warn"></i>degraded / slow</span><span><i class="ramp"></i>pipe: traffic light → heavy</span><span>flow speed: fast · medium · slow (latency, else placement)</span>
      </div>
      <div class="keys">
        {#each [["compute", "compute"], ["data", "data"], ["network", "network"], ["messaging", "messaging"], ["security", "security"], ["external", "SaaS"]] as [cat, label]}
          <span><i class="dot" style:background="var(--cat-{cat})"></i>{label}</span>
        {/each}
      </div>
      <div class="hint">Drag to rotate · right-drag to pan · scroll to zoom · drop a .json/.hcl/.tf file</div>
    </div>

    {#if error}<div class="error" role="alert">{error}<button onclick={() => (error = "")} aria-label="Dismiss">✕</button></div>{/if}

    {#if tip && hover}
      <div class="tip" style:left="{hover.x + 14}px" style:top="{hover.y + 14}px">
        <b>{tip.title}</b>
        <span>{tip.sub}</span>
        {#if tip.state !== "ok"}<em class={tone(tip.state)}>{tip.state}{tip.message ? ` — ${tip.message}` : ""}</em>{/if}
      </div>
    {/if}

    <aside class:open={panel && sel}>
      {#if sel}
        <button class="close" onclick={() => choose(null)} aria-label="Close">✕</button>
        {#if sel.kind === "node"}
          <div class="head">
            {#if iconDataUrl(sel.look.icon)}<img src={iconDataUrl(sel.look.icon)} alt="" />{/if}
            <div><h2>{sel.n.label}</h2><code>{sel.n.kind}</code></div>
          </div>
          <p class="state {tone(sel.n.state)}">{sel.n.state ?? "ok"}{sel.n.message ? ` — ${sel.n.message}` : ""}</p>
          {#if props(sel.n).length}
            <dl>{#each props(sel.n) as [k, v]}<dt>{k}</dt><dd>{v}</dd>{/each}</dl>
          {/if}
          {#each [["Calls", sel.outs, "to"], ["Called by", sel.ins, "from"]] as [title, list, end]}
            {#if (list as Edge[]).length}
              <h3>{title}</h3>
              <ul>
                {#each list as Edge[] as e}
                  <li><button onclick={() => choose({ type: "edge", id: e.id })}><i class="dot {tone(e.state)}"></i>{name(e[end as "to" | "from"])}<small>{e.protocol ?? ""} {e.rps ? `${e.rps}/s` : ""}</small></button></li>
                {/each}
              </ul>
            {/if}
          {/each}
        {:else if sel.kind === "edge"}
          <div class="head"><div><h2>{name(sel.e.from)} → {name(sel.e.to)}</h2><code>connection</code></div></div>
          <p class="state {tone(sel.e.state)}">{sel.e.state ?? "ok"}{sel.e.message ? ` — ${sel.e.message}` : ""}</p>
          <dl>{#each metrics(sel.e) as [k, v]}<dt>{k}</dt><dd>{v}</dd>{/each}</dl>
          <ul>
            <li><button onclick={() => choose({ type: "node", id: sel.e.from })}>From: {name(sel.e.from)}</button></li>
            <li><button onclick={() => choose({ type: "node", id: sel.e.to })}>To: {name(sel.e.to)}</button></li>
          </ul>
        {:else}
          <div class="head"><div><h2>{sel.g.label}</h2><code>{sel.g.kind ?? "group"}</code></div></div>
          <ul>
            {#each sel.members as n}<li><button onclick={() => choose({ type: "node", id: n.id })}><i class="dot {tone(n.state)}"></i>{n.label}</button></li>{/each}
          </ul>
        {/if}
      {/if}
    </aside>

    {#if log.length}
      <section class="log" aria-label="Events">
        {#each log.slice(0, 6) as entry}
          <div><time>{entry.at}</time><i class="dot {entry.tone}"></i>{entry.text}</div>
        {/each}
      </section>
    {/if}

    <dialog bind:this={pasteDialog} aria-label="Paste infrastructure">
      <form onsubmit={applyPaste}>
        <h2>Paste infrastructure</h2>
        <p>JSON, HCL or Terraform. It is read in the browser and never uploaded.</p>
        <textarea bind:value={pasteText} spellcheck="false" placeholder={'node "api" { kind = "aws.lambda"  calls = ["db"] }\nnode "db" { kind = "aws.rds" }'}></textarea>
        {#if error}<p class="crit">{error}</p>{/if}
        <div class="actions">
          <button type="button" onclick={() => pasteDialog.close()}>Cancel</button>
          <button class="on">Show</button>
        </div>
      </form>
    </dialog>

    {#if dragging}<div class="drop">Drop an infrastructure file (.json, .hcl, .tf)</div>{/if}
  </main>
</div>

<style>
  .app { display: flex; flex-direction: column; height: 100%; }
  header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between;
    padding: 8px max(16px, env(safe-area-inset-right)) 8px max(16px, env(safe-area-inset-left));
    border-bottom: 1px solid var(--line); background: var(--panel); z-index: 3; }
  .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .brand svg { width: 22px; height: 22px; color: var(--accent); flex: none; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  .title { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  form { display: flex; gap: 6px; }
  input:not([type]), select, button, .button { font: inherit; font-size: 13px; color: var(--ink); background: transparent;
    border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  input:not([type]) { width: 230px; cursor: text; }
  .filter input:not([type]) { width: 100%; }
  .filter input:not([type]) { width: 100%; }
  button:hover, .button:hover { border-color: var(--accent); }
  button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .status { font: 600 11px var(--mono); text-transform: uppercase; color: var(--muted); }
  .status[data-state="live"] { color: var(--ok); }
  .status[data-state="error"] { color: var(--crit); }

  main { position: relative; flex: 1; min-height: 0; }
  .stage { position: absolute; inset: 0; background: var(--scene); }
  .stage :global(canvas) { display: block; cursor: grab; touch-action: none; }

  .views, .legend, aside, .log, .tip, .error { position: absolute; background: var(--panel); border: 1px solid var(--line);
    border-radius: 8px; box-shadow: var(--shadow); backdrop-filter: blur(6px); }
  .views { top: 12px; left: max(16px, env(safe-area-inset-left)); display: flex; gap: 4px; padding: 4px; }
  .views button { border: none; min-width: 32px; }
  .badge { font: 600 11px var(--mono); text-transform: uppercase; padding: 4px 8px; border-radius: 99px;
    background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
  .filter { position: absolute; top: 60px; left: max(16px, env(safe-area-inset-left)); width: min(320px, calc(100% - 32px));
    max-height: calc(100% - 200px); overflow: auto; padding: 12px; display: grid; gap: 8px; background: var(--panel);
    border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); backdrop-filter: blur(6px); z-index: 2; }
  .filter label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
  .filter h3 { margin: 4px 0 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chips button { font-size: 12px; padding: 2px 10px; border-radius: 99px; }
  .filter .actions { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--muted); }
  button:disabled { opacity: 0.5; cursor: default; }
  .legend { left: max(16px, env(safe-area-inset-left)); bottom: max(16px, env(safe-area-inset-bottom)); padding: 10px 12px; font-size: 12px; display: grid; gap: 4px; max-width: 320px; }
  .keys { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); }
  .hint { color: var(--muted); font-size: 11px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--idle); flex: none; }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.crit { background: var(--crit); }
  .dot.fire { background: var(--fire); box-shadow: 0 0 6px var(--fire); } .dot.flow { background: var(--flow); }
  .ramp { display: inline-block; width: 28px; height: 6px; border-radius: 3px; margin-right: 6px; background: linear-gradient(90deg, var(--flow), var(--accent)); }

  .tip { pointer-events: none; padding: 8px 10px; display: grid; gap: 2px; max-width: 300px; z-index: 5; position: fixed; }
  .tip span { color: var(--muted); font: 12px var(--mono); }
  .tip em, .state { font-style: normal; font: 600 12px var(--mono); }
  .warn { color: var(--warn); } .crit { color: var(--crit); } .fire { color: var(--fire); } .ok { color: var(--ok); }

  aside { top: 12px; right: max(16px, env(safe-area-inset-right)); width: 300px; max-height: calc(100% - 24px); overflow: auto;
    padding: 14px; display: none; }
  aside.open { display: block; }
  .close { position: absolute; top: 8px; right: 8px; border: none; padding: 2px 8px; }
  .head { display: flex; gap: 10px; align-items: center; padding-right: 24px; }
  .head img { width: 36px; height: 36px; }
  h2 { font-size: 15px; margin: 0; overflow-wrap: anywhere; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 14px 0 4px; }
  code { font: 12px var(--mono); color: var(--muted); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 10px 0 0; font-size: 12px; }
  dt { color: var(--muted); } dd { margin: 0; font-family: var(--mono); overflow-wrap: anywhere; }
  ul { list-style: none; margin: 0; padding: 0; }
  li button { width: 100%; text-align: left; border: none; padding: 4px 6px; display: flex; align-items: center; gap: 2px; }
  li button:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
  li small { margin-left: auto; color: var(--muted); font-family: var(--mono); }

  .log { right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom)); width: 360px; padding: 8px 10px;
    font-size: 12px; display: grid; gap: 3px; }
  .log div { display: flex; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .log time { color: var(--muted); font: 11px var(--mono); margin-right: 8px; }
  aside.open ~ .log { display: none; }

  .error { top: 12px; left: 50%; transform: translateX(-50%); padding: 8px 12px; color: var(--crit); display: flex; gap: 10px; align-items: center; z-index: 4; max-width: calc(100% - 32px); }
  .error button { border: none; color: inherit; }
  dialog { width: min(760px, calc(100% - 32px)); padding: 16px; border: 1px solid var(--line); border-radius: 10px;
    background: var(--panel); color: var(--ink); box-shadow: var(--shadow); }
  dialog::backdrop { background: rgba(0, 0, 0, 0.35); }
  dialog form { display: grid; gap: 10px; }
  dialog p { margin: 0; color: var(--muted); font-size: 13px; }
  dialog p.crit { color: var(--crit); }
  textarea { width: 100%; height: min(60vh, 480px); resize: vertical; font: 12px/1.5 var(--mono); color: var(--ink);
    background: var(--scene); border: 1px solid var(--line); border-radius: 6px; padding: 10px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .drop { position: absolute; inset: 12px; border: 2px dashed var(--accent); border-radius: 12px; display: grid; place-items: center;
    font-size: 18px; background: color-mix(in srgb, var(--scene) 80%, transparent); z-index: 6; }

  @media (max-width: 720px) {
    input:not([type]) { width: 150px; }
    .legend .keys, .legend .hint, .log { display: none; }
    aside { top: auto; bottom: 0; left: 0; right: 0; width: auto; max-height: 45%; border-radius: 12px 12px 0 0;
      padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  }
</style>
