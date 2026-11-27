<script lang="ts">
  import { onMount } from "svelte";
  import { InfraScene, type Pick, type View } from "./lib/scene.ts";
  import InspectorDrawer from "./components/InspectorDrawer.svelte";
  import CommandPalette from "./components/CommandPalette.svelte";
  import ShareDialog from "./components/ShareDialog.svelte";
  import EditDialog from "./components/EditDialog.svelte";
  import DiffDialog from "./components/DiffDialog.svelte";
  import { ingest, type Loaded, type SourceFile } from "./parsers/index.ts";
  import { readDropped, readPicked } from "./parsers/files.ts";
  import { blastRadius } from "./graph/blast-radius.ts";
  import { diffTopology, type TopologyDiff } from "./graph/topology-diff.ts";
  import { blastOverlay, diffOverlay } from "./graph/overlay.ts";
  import { download } from "./export/download.ts";
  import { toMermaid } from "./export/mermaid.ts";
  import { toSvg } from "./export/svg.ts";
  import { composePng } from "./export/png.ts";
  import { CATEGORY_LEGEND, isLegendTerm, STATE_LEGEND, toggleFilter } from "./lib/legend.ts";
  import { layout } from "./lib/layout.ts";
  import { applyUpdate, flowSpeed, highlighted, splitTerms, type Infra, type Update } from "./lib/model.ts";
  import { connect, replay, simulate, type Status } from "./lib/stream.ts";
  import { decodeInfra, infraParam } from "./lib/share.ts";
  import { registerTools, type AppApi } from "./lib/mcp.ts";

  type Sample = { label: string; file: string; read: () => Promise<string>; events?: () => Promise<string> };
  const fetchText = (url: string) => fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${url}: ${r.status} ${r.statusText}`))));
  // Samples are files on the site (public/samples), so links and streams can point at them too.
  const SAMPLES: Record<string, Sample> = {
    platform: { label: "Global retail platform (HCL)", file: "platform.hcl", read: () => fetchText("samples/platform.hcl"), events: () => fetchText("samples/platform.jsonl") },
    multicloud: { label: "Multi-cloud shop (JSON)", file: "multicloud.json", read: () => fetchText("samples/multicloud.json") },
    serverless: { label: "Serverless (Terraform)", file: "serverless.tf", read: () => fetchText("samples/serverless.tf") },
  };
  // private/ is gitignored and only `pnpm dev` lists it, never a build: real infrastructure stays local.
  // A `name.jsonl` beside `name.hcl` is that sample's events.
  if (import.meta.env.DEV) {
    const files = import.meta.glob<string>("../private/*.{hcl,json,tf,jsonl}", { query: "?raw", import: "default" });
    for (const [path, read] of Object.entries(files)) {
      const [, id, ext] = path.match(/([^/]+)\.(\w+)$/)!;
      const entry = (SAMPLES[id] ??= { label: `${id} (local)`, file: `${id}.${ext}`, read: () => Promise.reject(new Error(`${id}: no infra file`)) });
      if (ext === "jsonl") entry.events = read;
      else (entry.read = read), (entry.file = `${id}.${ext}`);
    }
  }
  const loadSample = (id: string) => SAMPLES[id].read().then((t) => load(t, SAMPLES[id].file), (e: Error) => void (error = e.message));

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
  let log = $state<{ at: string; text: string; tone: string; ids: string[] }[]>([]);
  let dragging = $state(false);
  // `?name=` or `#name=`: the hash wins, since links that carry the file keep everything there.
  const urlParam = (name: string) => new URLSearchParams(location.hash.slice(1)).get(name) ?? new URLSearchParams(location.search).get(name);
  /** `?readonly`: watch only. Nothing that changes what is loaded (samples, files, paste, streams, simulation). */
  const readonly = urlParam("readonly") !== null && urlParam("readonly") !== "false";
  let terms = $state<string[]>(splitTerms(urlParam("highlight")));
  let filterOpen = $state(false);
  /** `?rotate`: start turning slowly, for a screen on the wall. */
  // Stopped, counterclockwise, stopped, clockwise.
  let rotation = $state(urlParam("rotate") !== null && urlParam("rotate") !== "false" ? 1 : 0);
  let panel = $state(true);
  let sources = $state.raw<SourceFile[]>([]); // the loaded files, for Edit and Share
  let editDialog: EditDialog;
  let shareDialog: ShareDialog;
  let diffDialog: DiffDialog;
  let palette: CommandPalette;
  /** Comparing two topologies: what is on screen is both together, `target` is what leaving shows. */
  let comparing = $state.raw<{ result: TopologyDiff; target: Infra; baseSources: SourceFile[] } | null>(null);
  let showUnchanged = $state(true);
  let blast = $state<string | null>(null);
  let toast = $state("");
  let toastTimer: ReturnType<typeof setTimeout>;
  let exportMenu: HTMLDetailsElement;
  const remembered = (key: string) => {
    try { return localStorage.getItem(key) !== "closed"; } catch { return true; }
  };
  let legendOpen = $state(remembered("legend"));
  let eventsOpen = $state(remembered("events"));
  const keep = (key: string, open: boolean) => {
    try { localStorage.setItem(key, open ? "open" : "closed"); } catch {}
  };
  let stop: (() => void) | undefined;
  let relayout: ReturnType<typeof setTimeout> | undefined;

  const node = (id: string) => infra.nodes.find((n) => n.id === id);
  const edge = (id: string) => infra.edges.find((e) => e.id === id);
  const name = (id: string) => node(id)?.label ?? id;
  const tone = (state = "ok") => ({ fire: "fire", down: "crit", broken: "crit", degraded: "warn", slow: "warn", ok: "ok" })[state] ?? "idle";

  function say(text: string) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 3500);
  }

  async function draw(next: Infra) {
    infra = next;
    selected = null;
    blast = null;
    scene.select(null);
    scene.build(infra, await layout(infra), true);
    tick++;
  }

  async function show(loaded: Loaded) {
    sources = loaded.sources;
    log = [];
    comparing = loaded.diff
      ? { result: diffTopology(loaded.diff.base, loaded.diff.target), target: loaded.infra, baseSources: loaded.sources }
      : null;
    if (comparing) stopStream();
    await draw(comparing ? comparing.result.infra : loaded.infra);
    if (loaded.camera) (view = loaded.camera.view), scene.restoreCamera(loaded.camera);
    for (const warning of loaded.warnings) note(warning, "degraded");
    if (loaded.warnings.length) say(`${loaded.warnings.length} problem(s) while reading; see Events`);
  }

  /** Loads files; returns the error message, "" on success. */
  async function loadFiles(files: SourceFile[], name: string): Promise<string> {
    try {
      const loaded = ingest(files);
      error = "";
      await show(loaded);
    } catch (e) {
      error = `${name}: ${(e as Error).message}`;
    }
    return error;
  }

  const load = (text: string, file: string) => loadFiles([{ path: file, text }], file);

  /** Files the user picked or dropped. */
  async function openFiles(reading: Promise<SourceFile[]>): Promise<string> {
    let files: SourceFile[];
    try {
      files = await reading;
    } catch (e) {
      return (error = (e as Error).message);
    }
    stopStream();
    sample = "";
    return loadFiles(files, files.length === 1 ? files[0].path : "Files");
  }

  function applyEdit(files: SourceFile[]) {
    stopStream();
    sample = "";
    return loadFiles(files, files.length === 1 ? "Edited text" : "Files");
  }

  async function compare(before: SourceFile[], after: SourceFile[]): Promise<string> {
    let base: Loaded, target: Loaded;
    try {
      (base = ingest(before)), (target = ingest(after));
    } catch (e) {
      return (e as Error).message;
    }
    stopStream();
    error = "";
    sample = "";
    log = [];
    sources = target.sources;
    comparing = { result: diffTopology(base.infra, target.infra), target: target.infra, baseSources: base.sources };
    await draw(comparing.result.infra);
    return "";
  }

  function exitDiff() {
    const { target } = comparing!;
    comparing = null;
    draw(target);
  }

  function note(text: string, state?: string, ids: string[] = []) {
    log = [{ at: new Date().toLocaleTimeString(), text, tone: tone(state), ids }, ...log].slice(0, 40);
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
      if (n && u.state && u.state !== before) note(`${n.label}: ${u.state}${n.message ? ` — ${n.message}` : ""}`, u.state, [n.id]);
    } else if (u.type === "edge") {
      const e = edge(u.id ?? `${u.from}->${u.to}`);
      if (e) scene.updateEdge(e);
      if (e && u.state && u.state !== before) note(`${name(e.from)} → ${name(e.to)}: ${u.state}${e.message ? ` — ${e.message}` : ""}`, u.state, [e.from, e.to]);
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

  const sharedInfra = () => comparing?.target ?? infra;

  async function exportAs(format: "png" | "svg" | "mermaid") {
    exportMenu.open = false;
    try {
      if (format === "svg") download(new Blob([toSvg(scene.drawing())], { type: "image/svg+xml" }), "topolore-topology.svg");
      else if (format === "png") {
        const css = getComputedStyle(document.documentElement);
        const legend = [...STATE_LEGEND, ...CATEGORY_LEGEND].map((l) => ({ label: l.label, color: css.getPropertyValue(l.color).trim() }));
        download(await composePng(scene.capture(2), scene.drawing(), legend, 2), "topolore-topology.png");
      } else {
        const text = toMermaid(sharedInfra());
        try {
          await navigator.clipboard.writeText(text);
          say("Mermaid diagram copied");
        } catch {
          download(new Blob([text], { type: "text/plain" }), "topolore-topology.mmd");
          say("The clipboard is blocked; downloaded a .mmd file instead");
        }
      }
    } catch (e) {
      error = `Export: ${(e as Error).message}`;
    }
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

  const toggleBlast = () => {
    if (selected?.type === "node") blast = blast === selected.id ? null : selected.id;
  };

  function keydown(e: KeyboardEvent) {
    const modal = document.querySelector("dialog[open]");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      // From another dialog the shortcut does nothing; from the palette it closes it.
      e.preventDefault();
      if (!modal || modal.getAttribute("aria-label") === "Search nodes") palette.toggle();
      return;
    }
    if (modal) return; // Esc closes a dialog by itself
    if (e.key === "Escape") {
      exportMenu.open = false;
      if (blast) blast = null;
      else choose(null);
    } else if (e.key.toLowerCase() === "b" && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target as HTMLElement).closest?.("input, textarea, select"))
      toggleBlast();
  }

  const dragged = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
  function drop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (!readonly && e.dataTransfer && dragged(e) && !document.querySelector("dialog[open]")) openFiles(readDropped(e.dataTransfer));
  }

  onMount(() => {
    scene = new InfraScene(host);
    scene.setAutoRotate(rotation === 1 ? 1 : 0);
    scene.onSelect = (p) => (selected = p, p && (panel = true));
    scene.onHover = (pick, x, y) => (hover = pick ? { pick, x, y } : null);
    const src = urlParam("src");
    // `?stream=` (or `?events=`): a WebSocket, an SSE endpoint or a .jsonl recording.
    const stream = urlParam("stream") ?? urlParam("events");
    const inline = infraParam(new URL(location.href));
    if (inline || src) sample = "";
    const loaded =
      inline ? decodeInfra(inline).then((t) => load(t, "Link"), () => void (error = "The infra in this link cannot be decoded.")) :
      src ? fetchText(src).then((t) => load(t, new URL(src, location.href).pathname.split("/").pop() || src), (e: Error) => void (error = e.message)) :
      loadSample(sample);
    if (stream) {
      streamUrl = stream;
      stop = connect(stream, onUpdate, (s) => (status = s));
    }
    const ready: Promise<unknown> = !stream && !src && !inline ? loaded.then(toggleSimulation) : loaded; // your own infra gets no sample events

    // Agent tools (WebMCP). Registered once the first load has settled, so it cannot overwrite what an agent loads.
    const agent = new AbortController();
    const api: AppApi = {
      readonly,
      state: () => ({ infra, selected, highlight: terms, view, simulating, status, error, log }),
      apply: onUpdate,
      load: (text, format) => {
        stopStream();
        sample = "";
        return load(text, `agent.${format}`);
      },
      setHighlight: setTerms,
      select: choose,
      setView,
      // Only toggles: turning off an idle simulation must not disconnect a real stream.
      setSimulation: (on) => void (on !== simulating && toggleSimulation()),
    };
    ready.finally(() => registerTools(api, agent.signal));

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
      agent.abort();
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

  let radius = $derived.by(() => {
    tick;
    return blast && infra.nodes.some((n) => n.id === blast) ? blastRadius(infra, blast) : null;
  });
  // Blast radius paints over a diff; without either, the scene shows the selection or highlight.
  let overlay = $derived(radius ? blastOverlay(infra, radius) : comparing ? diffOverlay(comparing.result, showUnchanged) : null);
  $effect(() => {
    const next = overlay;
    scene?.setOverlay(next);
  });
  let filters = $derived(terms.filter(isLegendTerm));
  const filtered = (term: string) => terms.some((t) => t.toLowerCase() === term);

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

</script>

<svelte:window
  ondragover={(e) => (e.preventDefault(), (dragging = !readonly && dragged(e) && !document.querySelector("dialog[open]")))}
  ondragleave={(e) => !e.relatedTarget && (dragging = false)}
  ondrop={drop}
  onkeydown={keydown}
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
      <button onclick={() => editDialog.open(sources, sharedInfra())}>Edit</button>
      <button onclick={() => diffDialog.open(sources)} title="Compare before and after">Diff / Compare</button>
      {/if}
      <button onclick={() => palette.toggle()} aria-keyshortcuts="Meta+K Control+K">Search ⌘K</button>
      <button onclick={() => shareDialog.open(sharedInfra(), sources)} title="Make a link or a file that contains this infrastructure">Share URL</button>
      <details class="menu" bind:this={exportMenu}>
        <summary class="button">Export ▾</summary>
        <div class="panel">
          <button onclick={() => exportAs("png")}>PNG (2×)</button>
          <button onclick={() => exportAs("svg")}>SVG</button>
          <button onclick={() => exportAs("mermaid")}>Copy Mermaid diagram</button>
        </div>
      </details>
      {#if !readonly}
      <label class="button">Open files<input type="file" multiple accept=".json,.hcl,.tf,.yaml,.yml" hidden onchange={(e) => e.currentTarget.files?.length && openFiles(readPicked(e.currentTarget.files)).then(() => ((e.target as HTMLInputElement).value = ""))} /></label>
      <form onsubmit={connectStream}>
        <input bind:value={streamUrl} placeholder="wss:// or https:// SSE stream" aria-label="Update stream URL" />
        <button disabled={!!comparing}>Connect</button>
      </form>
      <button class:on={simulating} disabled={!!comparing} onclick={toggleSimulation} title="Play the sample's events, or random incidents and traffic drift">{simulating ? "Stop simulation" : "Simulate"}</button>
      {/if}
      <button onclick={toggleTheme} title="Switch between light and dark" aria-label="Switch theme">◐</button>
      <span class="status" data-state={status.state}>{status.state === "live" && status.detail === "simulated" ? "simulating" : status.state}</span>
    </div>
  </header>

  <main>
    <div class="stage" bind:this={host}></div>

    <div class="views panel" role="group" aria-label="Camera">
      {#each [["iso", "Iso"], ["3d", "3D"], ["top", "Top"]] as [id, label]}
        <button class:on={view === id} onclick={() => setView(id as View)}>{label}</button>
      {/each}
      <button onclick={() => scene.zoomBy(1.25)} aria-label="Zoom in">+</button>
      <button onclick={() => scene.zoomBy(0.8)} aria-label="Zoom out">−</button>
      <button onclick={() => scene.setView(view)} title="Fit everything in view">Fit</button>
      <button class:on={rotation % 2 === 1} onclick={() => { rotation = (rotation + 1) % 4; scene.setAutoRotate(rotation === 1 ? 1 : rotation === 3 ? -1 : 0); }}
        title="Cycle counterclockwise, stop, clockwise, stop" aria-pressed={rotation % 2 === 1}>Rotate {rotation === 1 ? "↺" : rotation === 3 ? "↻" : ""}</button>
      <button class:on={filterOpen || terms.length > 0} onclick={() => (filterOpen = !filterOpen)} aria-expanded={filterOpen}>
        Highlight{terms.length ? ` · ${highlight?.size ?? 0}` : ""}
      </button>
    </div>

    {#if filterOpen}
      <div class="filter panel">
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

    <div class="legend panel">
      <div class="panel-head">
        <button class="fold" onclick={() => keep("legend", (legendOpen = !legendOpen))} aria-expanded={legendOpen}>
          <span>{legendOpen ? "▾" : "▸"} Legend</span>
        </button>
        {#if filters.length}<button class="link" onclick={() => setTerms(terms.filter((t) => !isLegendTerm(t)))}>Reset</button>{/if}
      </div>
      {#if legendOpen}
        <div><i class="dot ok"></i>{health.nodes} nodes · {health.edges} links</div>
        <div><i class="dot" class:crit={health.bad} class:ok={!health.bad}></i>{health.bad ? `${health.bad} open issues` : "all healthy"}</div>
        {#each [STATE_LEGEND, CATEGORY_LEGEND] as group}
          <div class="keys" role="group" aria-label="Filter">
            {#each group as item}
              <button class="pill" class:active={filtered(item.term)} aria-pressed={filtered(item.term)}
                onclick={(e) => setTerms(toggleFilter(terms, item.term, e.shiftKey))}>
                <i class="dot" style:background="var({item.color})"></i>{item.label}
              </button>
            {/each}
          </div>
        {/each}
        <div class="keys"><span><i class="ramp"></i>pipe: traffic light → heavy</span><span>flow speed: fast · medium · slow (latency, else placement)</span></div>
        <div class="hint">Click a filter to isolate, Shift-click to combine · drag to rotate · right-drag to pan · scroll to zoom · drop files or folders</div>
      {/if}
    </div>

    {#if radius}
      <div class="mode panel" role="status">
        Blast radius: <code>{name(radius.root)}</code> — {radius.upstream.size} upstream impacted · {radius.downstream.size} downstream
        <button onclick={() => (blast = null)}>Exit (Esc)</button>
      </div>
    {:else if comparing}
      {@const counts = comparing.result.counts}
      <div class="mode panel" role="status">
        <b class="added">+{counts.added} Added</b> · <b class="warn">~{counts.modified} Modified</b> · <b class="crit">−{counts.removed} Removed</b>
        <button aria-pressed={showUnchanged} class:on={showUnchanged} onclick={() => (showUnchanged = !showUnchanged)}>Unchanged</button>
        <button onclick={exitDiff}>Exit diff</button>
      </div>
    {/if}

    {#if toast}<div class="toast panel" role="status">{toast}</div>{/if}

    {#if error}<div class="error panel" role="alert">{error}<button onclick={() => (error = "")} aria-label="Dismiss">✕</button></div>{/if}

    {#if tip && hover}
      <div class="tip panel" style:left="{hover.x + 14}px" style:top="{hover.y + 14}px">
        <b>{tip.title}</b>
        <span>{tip.sub}</span>
        {#if tip.state !== "ok"}<em class={tone(tip.state)}>{tip.state}{tip.message ? ` — ${tip.message}` : ""}</em>{/if}
      </div>
    {/if}

    <InspectorDrawer {infra} {tick} {selected} {sources} baseSources={comparing?.baseSources ?? []} diff={comparing?.result}
      {log} {blast} open={panel} onchoose={choose} onblast={toggleBlast} />

    {#if log.length}
      <section class="log panel" class:covered={panel && selected} aria-label="Events">
        <button class="fold" onclick={() => keep("events", (eventsOpen = !eventsOpen))} aria-expanded={eventsOpen}>
          <span>{eventsOpen ? "▾" : "▸"} Events ({log.length})</span>
        </button>
        {#if eventsOpen}
          {#each log.slice(0, 6) as entry}
            <div title={entry.text}><time>{entry.at}</time><i class="dot {entry.tone}"></i>{entry.text}</div>
          {/each}
        {/if}
      </section>
    {/if}

    <CommandPalette bind:this={palette} {infra} onpick={(id) => choose({ type: "node", id })} />
    <ShareDialog bind:this={shareDialog} camera={() => scene.camera3d()} />
    <EditDialog bind:this={editDialog} onapply={applyEdit} onpick={(list) => openFiles(readPicked(list))} />
    <DiffDialog bind:this={diffDialog} oncompare={compare} />

    {#if dragging}<div class="drop">Drop files or a folder: Terraform, HCL, compose, Kubernetes, JSON or .topolore.json</div>{/if}
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
  .status { font: 600 11px var(--mono); text-transform: uppercase; color: var(--muted); }
  .status[data-state="live"] { color: var(--ok); }
  .status[data-state="error"] { color: var(--crit); }
  .menu { position: relative; }
  .menu summary { list-style: none; }
  .menu summary::-webkit-details-marker { display: none; }
  .menu div { top: calc(100% + 4px); right: 0; display: grid; gap: 4px; padding: 6px; width: max-content; }
  .menu button { text-align: left; }

  main { position: relative; flex: 1; min-height: 0; }
  .stage { position: absolute; inset: 0; background: var(--scene); }
  .stage :global(canvas) { display: block; cursor: grab; touch-action: none; }

  .views { top: 12px; left: max(16px, env(safe-area-inset-left)); display: flex; gap: 4px; padding: 4px; }
  .views button { border: none; min-width: 32px; }
  .filter { top: 60px; left: max(16px, env(safe-area-inset-left)); width: min(320px, calc(100% - 32px));
    max-height: calc(100% - 200px); overflow: auto; padding: 12px; display: grid; gap: 8px; z-index: 2; }
  .filter input:not([type]) { width: 100%; }
  .filter label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
  .filter h3 { margin: 4px 0 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chips button { font-size: 12px; padding: 2px 10px; border-radius: 99px; }
  .filter .actions { justify-content: space-between; align-items: center; font-size: 12px; color: var(--muted); }

  .legend { left: max(16px, env(safe-area-inset-left)); bottom: max(16px, env(safe-area-inset-bottom)); padding: 8px 12px; font-size: 12px; display: grid; gap: 4px; max-width: 340px; }
  .panel-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .fold { border: none; padding: 0; font: 600 11px var(--mono); text-transform: uppercase; color: var(--muted); text-align: left; }
  .link { border: none; padding: 0; font-size: 12px; color: var(--accent); text-decoration: underline; }
  .keys { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); }
  .keys[role="group"] { gap: 4px; }
  .pill { font-size: 12px; padding: 1px 8px; border-radius: 99px; color: var(--muted); }
  .pill.active { border-color: var(--accent); color: var(--ink); background: color-mix(in srgb, var(--accent) 18%, transparent); }
  .hint { color: var(--muted); font-size: 11px; }
  .ramp { display: inline-block; width: 28px; height: 6px; border-radius: 3px; margin-right: 6px; background: linear-gradient(90deg, var(--flow), var(--accent)); }

  .mode { top: 56px; left: 50%; transform: translateX(-50%); width: max-content; max-width: calc(100% - 32px); padding: 6px 12px; font-size: 13px;
    display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; z-index: 3; }
  .mode button { font-size: 12px; padding: 2px 10px; }
  .added { color: #10b981; }
  .toast { bottom: max(16px, env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); padding: 8px 14px; font-size: 13px; z-index: 5; }

  .tip { pointer-events: none; padding: 8px 10px; display: grid; gap: 2px; max-width: 300px; z-index: 5; position: fixed; }
  .tip span { color: var(--muted); font: 12px var(--mono); }
  .tip em { font-style: normal; font: 600 12px var(--mono); }

  .log { right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom)); max-width: 360px; padding: 8px 10px;
    font-size: 12px; display: grid; gap: 3px; }
  .log div { display: flex; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .log time { color: var(--muted); font: 11px var(--mono); margin-right: 8px; }
  .log.covered { display: none; }

  .error { top: 12px; left: 50%; transform: translateX(-50%); padding: 8px 12px; color: var(--crit); display: flex; gap: 10px; align-items: center; z-index: 4; max-width: calc(100% - 32px); }
  .error button { border: none; color: inherit; }
  .drop { position: absolute; inset: 12px; border: 2px dashed var(--accent); border-radius: 12px; display: grid; place-items: center; padding: 16px; text-align: center;
    font-size: 18px; background: color-mix(in srgb, var(--scene) 80%, transparent); z-index: 6; }

  @media (max-width: 720px) {
    .legend .keys:not([role="group"]), .legend .hint, .log { display: none; }
  }
</style>
