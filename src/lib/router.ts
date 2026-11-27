/** The hash takes precedence, as it does for existing share links. */
export function route(url: URL) {
  const hash = new URLSearchParams(url.hash.slice(1));
  const get = (key: string) => hash.get(key) ?? url.searchParams.get(key);
  const infra = get("infra");
  const src = get("src");
  return { infra, src: infra ? null : src, sample: infra || src ? null : (get("sample") ?? "platform"), stream: get("stream") ?? get("events") };
}

function without(url: URL, keys: string[]): URL {
  const next = new URL(url);
  const hash = new URLSearchParams(next.hash.slice(1));
  for (const key of keys) { next.searchParams.delete(key); hash.delete(key); }
  next.hash = hash.toString();
  return next;
}

export function sourceRoute(url: URL, kind: "sample" | "src", value: string): URL {
  const next = without(url, ["sample", "src", "infra", "stream", "events"]);
  next.searchParams.set(kind, value);
  return next;
}

export function streamRoute(url: URL, value: string): URL {
  const next = without(url, ["stream", "events"]);
  if (value) next.searchParams.set("stream", value);
  return next;
}
