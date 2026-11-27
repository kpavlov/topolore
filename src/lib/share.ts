// Infra text in a URL, like PlantUML links: deflate-raw, then base64url. `#infra=` keeps it off servers; `?infra=` works too.

const toBase64Url = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const pipe = async (bytes: Uint8Array, stream: CompressionStream | DecompressionStream) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

export async function encodeInfra(text: string): Promise<string> {
  return toBase64Url(await pipe(new TextEncoder().encode(text), new CompressionStream("deflate-raw")));
}

/** Decodes a deflated value; a plain base64url value (not compressed) is accepted too. */
export async function decodeInfra(value: string): Promise<string> {
  const bytes = fromBase64Url(value.trim());
  try {
    return new TextDecoder().decode(await pipe(bytes, new DecompressionStream("deflate-raw")));
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** The `infra` value from the hash or the query string, if any. */
export const infraParam = (url: URL) => new URLSearchParams(url.hash.slice(1)).get("infra") ?? url.searchParams.get("infra");
