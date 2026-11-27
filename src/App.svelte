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
  import { advanceRecording, connect, recording, recordingState, simulate, type Status } from "./lib/stream.ts";
  import { decodeInfra } from "./lib/share.ts";
  import { route, sourceRoute, streamRoute } from "./lib/router.ts";
  import { checkUpdate, registerTools, type AppApi } from "./lib/mcp.ts";

  type Sample = { label: string; file: string; group: string; read: () => Promise<string>; events?: () => Promise<string> };
  const fetchText = (url: string) => fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${url}: ${r.status} ${r.statusText}`))));
  let samples = $state.raw<Record<string, Sample>>({});
  // private/ is gitignored and only `pnpm dev` lists it, never a build: real infrastructure stays local.
  // A `name.jsonl` beside `name.hcl` is that sample's events.
  const privateSamples: Record<string, Sample> = {};
  if (import.meta.env.DEV) {
    const files = import.meta.glob<string>("../private/*.{hcl,json,tf,jsonl}", { query: "?raw", import: "default" });
    for (const [path, read] of Object.entries(files)) {
      const [, id, ext] = path.match(/([^/]+)\.(\w+)$/)!;
      const entry = (privateSamples[id] ??= { label: `${id} (local)`, group: "Local", file: `${id}.${ext}`, read: () => Promise.reject(new Error(`${id}: no infra file`)) });
      if (ext === "jsonl") entry.events = read;
      else (entry.read = read), (entry.file = `${id}.${ext}`);
    }
  }
  const sampleIndex = fetchText("samples/index.json").then((text) => {
    const index = JSON.parse(text) as { id: string; label: string; group: string; file: string; events?: string }[];
    samples = Object.fromEntries(index.map(({ id, label, group, file, events }) => [id, {
      label, group, file, read: () => fetchText(`samples/${file}`), events: events ? () => fetchText(`samples/${events}`) : undefined,
    }]));
    samples = { ...samples, ...privateSamples };
  }).catch((e: Error) => { error = `Samples: ${e.message}`; samples = privateSamples; });
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
  let openMenu = $state<HTMLDetailsElement>();
  let urlDialog: HTMLDialogElement;
  let sourceUrl = $state("");
  let routeVersion = 0;
  let routeKey = "";
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
  let playback = $state<{ data: ReturnType<typeof recording>; base: Infra; position: number; speed: number; playing: boolean; dynamic: boolean } | null>(null);
  let replayTimer: ReturnType<typeof setInterval> | undefined;
  let replayIndex = -1;
  let replayWait = 0;
  let slowing = $state(false);
  let drawVersion = 0;

  const node = (id: string) => infra.nodes.find((n) => n.id === id);
  const edge = (id: string) => infra.edges.find((e) => e.id === id);
  const name = (id: string) => node(id)?.label ?? id;
  const tone = (state = "ok") => ({ fire: "fire", down: "crit", broken: "crit", degraded: "warn", slow: "warn", ok: "ok" })[state] ?? "idle";

  function say(text: string) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 3500);
  }

  async function draw(next: Infra, frame = true, animate = false) {
    const version = ++drawVersion;
    infra = next;
    selected = null;
    blast = null;
    scene.select(null);
    const placed = await layout(next);
    if (version !== drawVersion) return;
    scene.build(next, placed, frame, animate);
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
    ++routeVersion;
    stopStream();
    sample = "";
    const scripts = files.filter((f) => /\.jsonl$/i.test(f.path));
    if (scripts.length) {
      if (scripts.length > 1) return (error = "Choose one JSONL recording at a time.");
      const topology = files.filter((f) => !/\.jsonl$/i.test(f.path));
      if (topology.length && await loadFiles(topology, "Files")) return error;
      try { startRecording(scripts[0].text); } catch (e) { return (error = (e as Error).message); }
      return "";
    }
    return loadFiles(files, files.length === 1 ? files[0].path : "Files");
  }

  function applyEdit(files: SourceFile[]) {
    ++routeVersion;
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
    ++routeVersion;
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
      relayout = setTimeout(async () => scene.build(infra, await layout(infra), false, true), 150);
      note("message" in u && u.message ? u.message : u.type === "remove" ? `Removed ${u.id}` : `Topology changed (${u.type} ${"id" in u ? u.id ?? "" : ""})`);
    } else if (u.type === "node") {
      const n = node(u.id);
      if (n) { scene.updateNode(n); scene.showNodeEvent(n.id); }
      if (n && (u.message || (u.state && u.state !== before))) note(`${n.label}: ${u.state ?? n.state ?? "ok"}${u.message ? ` — ${u.message}` : ""}`, u.state ?? n.state, [n.id]);
    } else if (u.type === "edge") {
      const e = edge(u.id ?? `${u.from}->${u.to}`);
      if (e) scene.updateEdge(e);
      if (e && (u.message || (u.state && u.state !== before))) note(`${name(e.from)} → ${name(e.to)}: ${u.state ?? e.state ?? "ok"}${u.message ? ` — ${u.message}` : ""}`, u.state ?? e.state, [e.from, e.to]);
    }
    tick++;
  }

  function stopStream() {
    stop?.();
    stop = undefined;
    simulating = false;
    status = { state: "idle" };
    clearInterval(replayTimer);
    playback = null;
    replayIndex = -1;
    replayWait = 0;
    slowing = false;
  }

  function replayTime(seconds: number, start?: number) {
    if (start !== undefined) return new Date(start + seconds * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  }

  function renderReplay(position: number, index: number) {
    if (!playback) return;
    const { data, base } = playback;
    playback.position = Math.max(0, Math.min(data.duration, position));
    if (index === replayIndex) return;
    replayIndex = index;
    clearTimeout(relayout);
    log = data.events.slice(0, index + 1).flatMap(([at, update]) => {
      if (!("message" in update) || !update.message) return [];
      return [{ at: replayTime(at, data.start), text: update.message, tone: tone("state" in update ? update.state : undefined), ids: "id" in update && update.id ? [update.id] : [] }];
    }).reverse().slice(0, 40);
    void draw(recordingState($state.snapshot(base), $state.snapshot(data.events), playback.position, index), false, true);
  }

  function seek(position: number) {
    if (!playback) return;
    replayWait = 0;
    slowing = false;
    const target = Math.max(0, Math.min(playback.data.duration, position));
    renderReplay(target, playback.data.events.findLastIndex(([at]) => at <= target));
  }

  function rewind() {
    if (!playback) return;
    replayWait = 0;
    slowing = false;
    replayIndex = -2;
    renderReplay(0, -1);
  }

  function startRecording(text: string) {
    const data = recording(text);
    const validation = $state.snapshot(infra);
    for (const [index, [, update]] of data.events.entries()) {
      const problem = checkUpdate(validation, update);
      if (problem) throw new Error(`Recording event ${index + 1}: ${problem}`);
      applyUpdate(validation, update);
    }
    playback = { data, base: $state.snapshot(infra), position: 0, speed: data.start === undefined ? 1 : 600, playing: true, dynamic: true };
    replayIndex = -2;
    replayWait = 0;
    slowing = false;
    simulating = true;
    status = { state: "live", detail: "replay" };
    renderReplay(0, -1);
    let last = performance.now();
    replayTimer = setInterval(() => {
      const now = performance.now();
      if (playback?.playing) {
        if (playback.dynamic) {
          const next = advanceRecording(playback.data.events, playback.position, replayIndex, replayWait, (now - last) / 1000, playback.speed);
          replayWait = next.wait;
          slowing = next.wait > 0;
          renderReplay(next.position, next.index);
        } else seek(playback.position + (now - last) / 1000 * playback.speed);
        if (replayIndex === playback.data.events.length - 1 && playback.position >= playback.data.duration) {
          playback.playing = false;
          slowing = false;
        }
      }
      last = now;
    }, 100);
  }

  function openStream(url: string) {
    if (/\.jsonl(?:[?#]|$)/i.test(url)) {
      let cancelled = false;
      status = { state: "connecting" };
      stop = () => { cancelled = true; };
      fetchText(url).then((text) => { if (!cancelled) startRecording(text); }).catch((e: Error) => {
        if (!cancelled) { error = e.message; status = { state: "error", detail: e.message }; }
      });
    } else stop = connect(url, onUpdate, (s) => { status = s; if (s.detail) note(s.detail); });
  }

  function toggleSimulation() {
    if (simulating) return stopStream();
    stopStream();
    simulating = true;
    // A sample with its own events replays them; anything else gets random incidents.
    const events = samples[sample]?.events;
    status = { state: "live", detail: events ? "replay" : "simulated" };
    if (!events) return void (stop = simulate(() => infra, onUpdate));
    let stopped = false;
    stop = () => { stopped = true; };
    events().then((t) => { if (!stopped) startRecording(t); }).catch((e: Error) => { if (!stopped) { error = e.message; stopStream(); } });
  }

  function connectStream(e: SubmitEvent) {
    e.preventDefault();
    ++routeVersion;
    stopStream();
    const value = streamUrl.trim();
    const url = streamRoute(new URL(location.href), value);
    history.pushState(null, "", url);
    routeKey = JSON.stringify(route(url));
    if (value) openStream(value);
  }

  async function openRoute(force = false) {
    const url = new URL(location.href);
    const next = route(url);
    const key = JSON.stringify(next);
    if (!force && key === routeKey) return;
    routeKey = key;
    const version = ++routeVersion;
    ++drawVersion;
    clearTimeout(relayout);
    stopStream();
    streamUrl = next.stream ?? "";
    sample = next.sample ?? "";
    error = "";
    try {
      let text: string, file: string;
      if (next.infra) {
        text = await decodeInfra(next.infra);
        file = "Link";
      } else if (next.src) {
        text = await fetchText(next.src);
        file = new URL(next.src, location.href).pathname.split("/").pop() || "Source";
      } else {
        await sampleIndex;
        if (version !== routeVersion) return;
        const entry = samples[next.sample!];
        if (!entry) throw new Error(`Sample "${next.sample}" was not found.`);
        text = await entry.read();
        file = entry.file;
      }
      if (version !== routeVersion) return;
      const problem = await load(text, file);
      if (version !== routeVersion || problem) return;
      if (next.stream) openStream(next.stream);
      else if (next.sample) toggleSimulation();
    } catch (e) {
      if (version === routeVersion) error = `Open: ${(e as Error).message}`;
    }
  }

  function navigateSource(kind: "sample" | "src", value: string) {
    const url = sourceRoute(new URL(location.href), kind, value);
    history.pushState(null, "", url);
    void openRoute(true);
  }

  function submitSource(e: SubmitEvent) {
    e.preventDefault();
    const value = sourceUrl.trim();
    try {
      if (!["http:", "https:"].includes(new URL(value, location.href).protocol) || !value) throw new Error();
    } catch {
      error = "Enter an HTTP or HTTPS topology URL.";
      return;
    }
    urlDialog.close();
    navigateSource("src", value);
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
      if (openMenu) openMenu.open = false;
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
    const ready = openRoute(true);

    // Agent tools (WebMCP). Registered once the first load has settled, so it cannot overwrite what an agent loads.
    const agent = new AbortController();
    const api: AppApi = {
      readonly,
      state: () => ({ infra, selected, highlight: terms, view, simulating, status, error, log }),
      apply: onUpdate,
      load: (text, format) => {
        ++routeVersion;
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

    const onRoute = () => { void openRoute(); };
    addEventListener("hashchange", onRoute);
    addEventListener("popstate", onRoute);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const restyle = () => scene.restyle();
    media.addEventListener("change", restyle);
    return () => {
      agent.abort();
      stopStream();
      media.removeEventListener("change", restyle);
      removeEventListener("hashchange", onRoute);
      removeEventListener("popstate", onRoute);
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
      {#each infra.links ?? [] as link}
        <a class="source-link" href={link.url} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>
      {/each}
    </div>
    <div class="tools">
      {#if readonly}<span class="badge" title="Opened with ?readonly">View only</span>{:else}
      <details class="menu" bind:this={openMenu}>
        <summary class="button">Open <span class="chevron" aria-hidden="true">▾</span></summary>
        <div class="panel open-list">
          <button onclick={() => { openMenu!.open = false; editDialog.open(sources, sharedInfra()); }}>Edit / paste</button>
          <button onclick={() => { openMenu!.open = false; sourceUrl = ""; urlDialog.showModal(); }}>URL…</button>
          <label class="button">Files<input type="file" multiple accept=".json,.jsonl,.hcl,.tf,.yaml,.yml" hidden onchange={(e) => { openMenu!.open = false; if (e.currentTarget.files?.length) openFiles(readPicked(e.currentTarget.files)).then(() => ((e.target as HTMLInputElement).value = "")); }} /></label>
          <label class="button">Folder<input type="file" webkitdirectory multiple hidden onchange={(e) => { openMenu!.open = false; if (e.currentTarget.files?.length) openFiles(readPicked(e.currentTarget.files)).then(() => ((e.target as HTMLInputElement).value = "")); }} /></label>
          <details class="sample-menu">
            <summary>Samples <span class="chevron" aria-hidden="true">▾</span></summary>
            {#each ["Examples", "Postmortems", "Local"] as group}
              {#if Object.values(samples).some((entry) => entry.group === group)}
                <span class="menu-heading">{group}</span>
                {#each Object.entries(samples).filter(([, entry]) => entry.group === group) as [id, entry]}
                  <button class:on={sample === id} onclick={() => { openMenu!.open = false; navigateSource("sample", id); }}>{entry.label}</button>
                {/each}
              {/if}
            {/each}
          </details>
        </div>
      </details>
      <button onclick={() => diffDialog.open(sources)} title="Compare before and after">Diff / Compare</button>
      {/if}
      <button onclick={() => palette.toggle()} aria-keyshortcuts="Meta+K Control+K">Search ⌘K</button>
      <button onclick={() => shareDialog.open(sharedInfra(), sources)} title="Make a link or a file that contains this infrastructure">Share URL</button>
      <details class="menu" bind:this={exportMenu}>
        <summary class="button">Export <span class="chevron" aria-hidden="true">▾</span></summary>
        <div class="panel">
          <button onclick={() => exportAs("png")}>PNG (2×)</button>
          <button onclick={() => exportAs("svg")}>SVG</button>
          <button onclick={() => exportAs("mermaid")}>Copy Mermaid diagram</button>
        </div>
      </details>
      <details class="menu">
        <summary class="button">Help <span class="chevron" aria-hidden="true">▾</span></summary>
        <div class="panel"><a class="button" href="https://github.com/kpavlov/topolore/blob/main/public/docs/event-log.md" target="_blank" rel="noopener">Event log format ↗</a></div>
      </details>
      {#if !readonly}
      <form onsubmit={connectStream}>
        <input bind:value={streamUrl} placeholder="wss:// or https:// SSE stream" aria-label="Update stream URL" />
        <button disabled={!!comparing}>Connect</button>
      </form>
      <button class:on={simulating} aria-pressed={simulating} disabled={!!comparing} onclick={toggleSimulation} title="Play the sample's events, or random incidents and traffic drift">Simulation</button>
      {/if}
      <button onclick={toggleTheme} title="Switch between light and dark" aria-label="Switch theme">◐</button>
      <a class="button github" href="https://github.com/kpavlov/topolore" aria-label="Topolore on GitHub" title="Topolore on GitHub">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.87 10.91.58.11.79-.25.79-.55v-2.14c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.33.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18a11 11 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.75.11 3.04.73.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.55A11.5 11.5 0 0 0 12 .5Z"/></svg>
      </a>
      <span class="status" data-state={status.state}>{status.state === "live" && status.detail === "simulated" ? "simulating" : status.state}</span>
    </div>
  </header>

  <main class:has-timeline={playback && playback.data.timed} class:inspecting={!!(panel && selected)}>
    <div class="stage" bind:this={host}></div>

    <div class="views panel" role="group" aria-label="Camera">
      {#each [["iso", "Iso"], ["3d", "3D"], ["top", "Top"]] as [id, label]}
        <button class:on={view === id} onclick={() => setView(id as View)}>{label}</button>
      {/each}
      <button class:on={rotation % 2 === 1} onclick={() => { rotation = (rotation + 1) % 4; scene.setAutoRotate(rotation === 1 ? 1 : rotation === 3 ? -1 : 0); }}
        title="Cycle counterclockwise, stop, clockwise, stop" aria-pressed={rotation % 2 === 1}>Rotate {rotation === 1 ? "↺" : rotation === 3 ? "↻" : ""}</button>
      <button class:on={filterOpen || terms.length > 0} onclick={() => (filterOpen = !filterOpen)} aria-expanded={filterOpen}>
        Highlight{terms.length ? ` · ${highlight?.size ?? 0}` : ""}
      </button>
    </div>

    <div class="zoom panel" role="group" aria-label="Zoom">
      <button onclick={() => scene.zoomBy(1.25, true)} aria-label="Zoom in">+</button>
      <button onclick={() => scene.zoomBy(0.8, true)} aria-label="Zoom out">−</button>
      <button onclick={() => scene.fitView()} title="Fit everything in view">Fit</button>
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
                onclick={(e) => setTerms(toggleFilter(terms, item.term, e.shiftKey || e.ctrlKey || e.metaKey))}>
                <i class="dot" style:background="var({item.color})"></i>{item.label}
              </button>
            {/each}
          </div>
        {/each}
        <div class="keys"><span><i class="ramp"></i>pipe: traffic light → heavy</span><span>flow speed: fast · medium · slow (latency, else placement)</span></div>
        <div class="hint">Click a filter to isolate, Shift/Ctrl/⌘-click to combine · drag to rotate · right-drag to pan · scroll to zoom · drop files or folders</div>
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
      <section class="log panel" class:covered={panel && selected} class:expanded={eventsOpen} aria-label="Events">
        <button class="fold" onclick={() => keep("events", (eventsOpen = !eventsOpen))} aria-expanded={eventsOpen}>
          <span>{eventsOpen ? "▾" : "▸"} Events ({log.length})</span>
        </button>
        {#if eventsOpen}
          <div class="log-entries">
            {#each log.slice(0, 6) as entry}
              <div class="log-entry"><time>{entry.at}</time><i class="dot {entry.tone}"></i><span>{entry.text}</span></div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    {#if playback && playback.data.timed}
      <section class="timeline panel" aria-label="Incident playback">
        <button onclick={rewind} aria-label="Rewind to start" title="Rewind to start">⏮</button>
        <button onclick={() => { if (!playback!.playing && replayIndex === playback!.data.events.length - 1 && playback!.position >= playback!.data.duration) rewind(); playback!.playing = !playback!.playing; }}>
          {playback.playing ? "Pause" : "Play"}
        </button>
        <time>{replayTime(playback.position, playback.data.start)}</time>
        <input type="range" aria-label="Incident timeline" min="0" max={Math.max(playback.data.duration, 1)} step="0.1" value={playback.position} oninput={(e) => seek(Number(e.currentTarget.value))} />
        <time>{replayTime(playback.data.duration, playback.data.start)}</time>
        {#if slowing && playback.playing && playback.dynamic}<span class="pace" role="status">Slowing for events</span>{/if}
        <label title="Playback speed"><svg class="speed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.3 18a9 9 0 1 1 15.4 0H4.3Z"/><path d="m12 14 4-4"/><circle cx="12" cy="14" r="1"/></svg><select value={playback.dynamic ? "dynamic" : String(playback.speed)} aria-label="Playback speed"
          onchange={(e) => { const value = e.currentTarget.value; playback!.dynamic = value === "dynamic"; if (value !== "dynamic") playback!.speed = Number(value); }}>
          <option value="dynamic">Dynamic (up to {playback.speed}×)</option>
          {#each [1, 2, 5, 10, 60, 100, 600, 3600, 14400] as speed}<option value={String(speed)}>{speed}×</option>{/each}
        </select></label>
      </section>
    {/if}

    <CommandPalette bind:this={palette} {infra} onpick={(id) => choose({ type: "node", id })} />
    <ShareDialog bind:this={shareDialog} camera={() => scene.camera3d()} />
    <EditDialog bind:this={editDialog} onapply={applyEdit} onpick={(list) => openFiles(readPicked(list))} />
    <DiffDialog bind:this={diffDialog} oncompare={compare} />
    <dialog bind:this={urlDialog} aria-label="Open topology URL">
      <form onsubmit={submitSource}>
        <h2>Open topology URL</h2>
        <p>The URL must allow access from this site.</p>
        <input type="url" bind:value={sourceUrl} required placeholder="https://example.com/topology.json" aria-label="Topology URL" />
        <div class="actions"><button type="button" onclick={() => urlDialog.close()}>Cancel</button><button class="on">Open</button></div>
      </form>
    </dialog>

    {#if dragging}<div class="drop">Drop files or a folder: Terraform, HCL, compose, Kubernetes, JSON or .topolore.json</div>{/if}
  </main>
</div>

<style>
  .app { display: flex; flex-direction: column; height: 100%; }
  header { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; justify-content: space-between;
    padding: 6px max(12px, env(safe-area-inset-right)) 6px max(12px, env(safe-area-inset-left));
    border-bottom: 1px solid var(--line); background: var(--panel); z-index: 3; }
  .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .brand svg { width: 22px; height: 22px; color: var(--accent); flex: none; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  .title { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .source-link { color: var(--accent); font-size: 12px; white-space: nowrap; }
  .tools { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .tools > button, .tools > .button, .tools > form button, .menu summary { padding: 4px 7px; }
  .tools input:not([type]) { width: 160px; padding: 4px 7px; }
  .github { display: inline-flex; align-items: center; }
  .github svg { width: 16px; height: 16px; }
  form { display: flex; gap: 4px; }
  .status { font: 600 11px var(--mono); text-transform: uppercase; color: var(--muted); }
  .status[data-state="live"] { color: var(--ok); }
  .status[data-state="error"] { color: var(--crit); }
  .menu { position: relative; }
  .menu summary { list-style: none; }
  .menu summary::-webkit-details-marker { display: none; }
  .chevron { font-size: 1.3em; line-height: 0; vertical-align: -0.05em; }
  .menu > div { top: calc(100% + 4px); left: 0; display: grid; gap: 4px; padding: 6px; width: max-content; max-width: min(360px, 90vw); }
  .menu:not(:has(.open-list)) > div { left: auto; right: 0; }
  .menu > div button, .menu > div .button, .sample-menu summary { display: block; width: 100%; border: 0; border-radius: 4px;
    background: transparent; color: var(--ink); padding: 5px 8px; text-align: left; text-decoration: none; cursor: pointer; }
  .menu > div button:hover, .menu > div .button:hover, .sample-menu summary:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .menu > div button.on { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--ink); }
  .sample-menu { max-height: min(65vh, 500px); overflow: auto; }
  .sample-menu button, .menu-heading { display: block; width: 100%; }
  .sample-menu button { padding-left: 20px; }
  .menu-heading { padding: 8px 8px 3px; color: var(--muted); font: 600 11px var(--mono); text-transform: uppercase; }

  main { position: relative; flex: 1; min-height: 0; }
  .stage { position: absolute; inset: 0; background: var(--scene); }
  .stage :global(canvas) { display: block; cursor: grab; touch-action: none; }

  .views { top: 12px; left: max(16px, env(safe-area-inset-left)); display: flex; gap: 4px; padding: 4px; }
  .zoom { right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom)); display: flex; gap: 4px; padding: 4px; }
  .views button, .zoom button { border: none; min-width: 32px; }
  .inspecting .zoom { right: max(352px, calc(env(safe-area-inset-right) + 336px)); }
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

  .log { right: max(16px, env(safe-area-inset-right)); top: 12px; width: min(480px, calc(100% - 32px)); padding: 8px 10px;
    font-size: 12px; display: grid; gap: 6px; }
  .log.expanded { height: min(300px, 45%); grid-template-rows: auto minmax(0, 1fr); }
  .log-entries { overflow-y: auto; display: grid; align-content: start; gap: 6px; }
  .log-entry { display: grid; grid-template-columns: auto 8px minmax(0, 1fr); align-items: start; gap: 6px; }
  .log-entry time { color: var(--muted); font: 11px var(--mono); white-space: nowrap; }
  .log-entry .dot { margin: 4px 0 0; }
  .log-entry span { min-width: 0; overflow-wrap: anywhere; }
  .log.covered { display: none; }
  .timeline { left: 16px; right: 16px; bottom: max(12px, env(safe-area-inset-bottom)); padding: 8px; display: flex; align-items: center; gap: 8px; z-index: 3; }
  .timeline input[type="range"] { flex: 1; min-width: 60px; }
  .timeline time, .timeline label { font: 11px var(--mono); white-space: nowrap; }
  .timeline label { display: flex; align-items: center; gap: 4px; }
  .speed-icon { width: 18px; height: 18px; flex: none; }
  .pace { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .has-timeline .legend, .has-timeline .zoom { bottom: 74px; }

  .error { top: 12px; left: 50%; transform: translateX(-50%); padding: 8px 12px; color: var(--crit); display: flex; gap: 10px; align-items: center; z-index: 4; max-width: calc(100% - 32px); }
  .error button { border: none; color: inherit; }
  .drop { position: absolute; inset: 12px; border: 2px dashed var(--accent); border-radius: 12px; display: grid; place-items: center; padding: 16px; text-align: center;
    font-size: 18px; background: color-mix(in srgb, var(--scene) 80%, transparent); z-index: 6; }

  @media (max-width: 720px) {
    .legend .keys:not([role="group"]), .legend .hint { display: none; }
    .log { width: min(480px, calc(100% - 180px)); }
    .log-entry { grid-template-columns: 8px minmax(0, 1fr); }
    .log-entry time { grid-column: 1 / -1; white-space: normal; overflow-wrap: anywhere; }
    .inspecting .zoom { right: max(16px, env(safe-area-inset-right)); bottom: 46%; }
    .timeline { flex-wrap: wrap; }
    .timeline input[type="range"] { order: 5; flex-basis: 100%; }
    .has-timeline .legend, .has-timeline .zoom { bottom: 110px; }
    .has-timeline.inspecting .zoom { bottom: max(46%, 110px); }
  }
</style>
