import { placementSpeed, type Infra, type NodeState, type EdgeState, type Update } from "./model.ts";

export type Status = { state: "idle" | "connecting" | "live" | "closed" | "error"; detail?: string };

/**
 * Listens to updates: `ws://` and `wss://` open a WebSocket, `http(s)://` an EventSource (SSE). Each message is one
 * update object, an array of them, or newline-separated JSON. Returns a function that disconnects.
 */
export function connect(url: string, onUpdate: (u: Update) => void, onStatus: (s: Status) => void): () => void {
  const deliver = (text: string) => {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        for (const u of Array.isArray(parsed) ? parsed : [parsed]) onUpdate(u);
      } catch {
        onStatus({ state: "live", detail: `Skipped a message that is not JSON: ${line.slice(0, 60)}` });
      }
    }
  };
  onStatus({ state: "connecting" });
  if (/\.jsonl(\?|#|$)/.test(url)) {
    let stop = () => {};
    let closed = false;
    fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${r.statusText}`)))).then(
      (text) => !closed && ((stop = replay(text, onUpdate)), onStatus({ state: "live", detail: "replay" })),
      (e) => onStatus({ state: "error", detail: `${url}: ${e.message}` }),
    );
    return () => ((closed = true), stop());
  }
  if (/^wss?:\/\//.test(url)) {
    const ws = new WebSocket(url);
    ws.onopen = () => onStatus({ state: "live" });
    ws.onmessage = (m) => deliver(String(m.data));
    ws.onerror = () => onStatus({ state: "error", detail: "The WebSocket connection failed." });
    ws.onclose = () => onStatus({ state: "closed" });
    return () => ws.close();
  }
  const es = new EventSource(url);
  es.onopen = () => onStatus({ state: "live" });
  es.onmessage = (m) => deliver(m.data);
  es.onerror = () => onStatus({ state: es.readyState === EventSource.CLOSED ? "error" : "connecting", detail: "Reconnecting to the event stream." });
  return () => es.close();
}

/** One JSONL line: an update plus when it happens, `t` seconds from the start or an `at` timestamp. */
export type Timed = Update & { t?: number; at?: string };

/** Seconds from the start of each line, in file order; `at` counts from the first timestamp, a line without either follows the one before. */
export function timeline(text: string): [number, Update][] {
  let first: number | undefined;
  let last = 0;
  return text.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("//")).map((line) => {
    const { t, at, ...update } = JSON.parse(line) as Timed;
    const ms = at === undefined ? NaN : Date.parse(at);
    if (!Number.isNaN(ms)) first ??= ms;
    last = typeof t === "number" ? t : !Number.isNaN(ms) ? (ms - first!) / 1000 : last;
    return [last, update as Update];
  });
}

/** Plays a JSONL recording at its own pace, then starts over after `pause` seconds. Returns a function that stops it. */
export function replay(text: string, onUpdate: (u: Update) => void, pause = 4): () => void {
  const events = timeline(text);
  const length = (events.at(-1)?.[0] ?? 0) + pause;
  let timer: ReturnType<typeof setTimeout>;
  let i = 0;
  let started = performance.now();
  const step = () => {
    if (i === events.length) (i = 0), (started += length * 1000);
    const [at, update] = events[i++];
    timer = setTimeout(() => (onUpdate(update), step()), Math.max(0, started + at * 1000 - performance.now()));
  };
  if (events.length) step();
  return () => clearTimeout(timer);
}

/**
 * Plays incidents against the loaded infrastructure: traffic drifts, a service catches fire, a link slows down or
 * breaks, and everything recovers after a while. Same message shapes as a real stream.
 */
export function simulate(getInfra: () => Infra, onUpdate: (u: Update) => void, speed = 1): () => void {
  const open = new Map<string, number>(); // id -> tick when it recovers
  let tick = 0;
  // Each link keeps a typical latency that fits where its ends sit: same network fast, same cloud medium, beyond slow.
  const typical = new Map<string, number>();
  const RANGE = { fast: [8, 35], medium: [70, 150], slow: [280, 200] } as const;
  const baseLatency = (infra: Infra, e: { id: string; from: string; to: string }) => {
    if (!typical.has(e.id)) {
      const [low, spread] = RANGE[placementSpeed(infra, e.from, e.to)];
      typical.set(e.id, low + Math.random() * spread);
    }
    return typical.get(e.id)!;
  };
  const pick = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)];

  const timer = setInterval(() => {
    tick++;
    const infra = getInfra();
    // Traffic drifts on every link.
    for (const e of infra.edges) {
      if (e.state === "broken") continue;
      const base = e.rps ?? 20 + Math.random() * 200;
      const rps = Math.max(1, Math.round(base * (0.85 + Math.random() * 0.3)));
      const latencyMs = e.state === "slow" ? 600 + Math.round(Math.random() * 900) : Math.round(baseLatency(infra, e) * (0.85 + Math.random() * 0.3));
      onUpdate({ type: "edge", id: e.id, rps, latencyMs, errorRate: e.state === "slow" ? 0.02 : 0 });
    }
    for (const [id, until] of open) {
      if (tick < until) continue;
      open.delete(id);
      if (infra.nodes.some((n) => n.id === id)) onUpdate({ type: "node", id, state: "ok", message: "Recovered", metrics: { cpu: 0.3, errors: 0 } });
      else onUpdate({ type: "edge", id, state: "ok", message: "Recovered" });
    }
    if (tick % 3 !== 0 || open.size >= 3) return;

    const healthyNodes = infra.nodes.filter((n) => (n.state ?? "ok") === "ok" && !n.kind.startsWith("internet"));
    const healthyEdges = infra.edges.filter((e) => (e.state ?? "ok") === "ok");
    const roll = Math.random();
    if (roll < 0.25 && healthyNodes.length) {
      const n = pick(healthyNodes);
      const fire = Math.random() < 0.5;
      const state: NodeState = fire ? "fire" : "down";
      open.set(n.id, tick + 6 + Math.floor(Math.random() * 8));
      onUpdate({
        type: "node", id: n.id, state,
        message: fire ? pick(["CPU 99% for 5 min", "OOMKilled 3× in 2 min", "Error rate 38%", "p99 latency 9.4 s"]) : pick(["0/2 pods ready", "Health check failing", "Connection refused"]),
        metrics: { cpu: fire ? 0.99 : 0, errors: fire ? 0.38 : 1 },
      });
      // A dead service breaks the links into it.
      if (!fire) for (const e of infra.edges.filter((e) => e.to === n.id)) {
        open.set(e.id, open.get(n.id)!);
        onUpdate({ type: "edge", id: e.id, state: "broken", message: `${n.label} is down` });
      }
    } else if (roll < 0.55 && healthyNodes.length) {
      const n = pick(healthyNodes);
      open.set(n.id, tick + 5 + Math.floor(Math.random() * 6));
      onUpdate({ type: "node", id: n.id, state: "degraded", message: pick(["1/3 pods restarting", "Queue depth rising", "Replica lag 40 s", "Disk 91% full"]) });
    } else if (healthyEdges.length) {
      const e = pick(healthyEdges);
      const state: EdgeState = Math.random() < 0.65 ? "slow" : "broken";
      open.set(e.id, tick + 5 + Math.floor(Math.random() * 7));
      onUpdate({ type: "edge", id: e.id, state, message: state === "slow" ? "p99 above 800 ms" : pick(["Connection reset", "TLS handshake failed", "503 from upstream"]) });
    }
  }, 1000 / speed);
  return () => clearInterval(timer);
}
