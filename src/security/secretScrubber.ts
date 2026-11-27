/**
 * Finds and replaces secrets in infrastructure text before it leaves the browser in a link or a snapshot. A best
 * effort: patterns cannot know every secret. The redacted text must still parse as what it was.
 */
import { isMap, isScalar, isSeq, parseAllDocuments } from "yaml";

export const REDACTED = "***REDACTED***";

interface Match {
  type: string;
  start: number;
  end: number;
  /** Replaces the match; without it, {@link REDACTED}, quoted where bare asterisks would not parse. */
  with?: string;
}

/** Whole-match patterns; with a capture group, only the group is the secret. */
const PATTERNS: [string, RegExp][] = [
  ["Private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/dg],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/dg],
  ["JWT", /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/dg],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{40,})\b/dg],
  ["Slack token", /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/dg],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}/dg],
  ["Stripe key", /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/dg],
  ["Bearer token", /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/dg],
  ["Password in URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']*:([^\s/@"']+)@/dgi],
];

const SENSITIVE_WORD = "(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?key|credential|connection[_-]?string)";
/**
 * `password = `, `"apiKey": `, `DB_PASSWORD=`; group 1 is the key. After a bare key a colon needs a space, as in YAML,
 * so the `:secret:` inside an ARN is not a key.
 */
const ASSIGNMENT = new RegExp(`(?<![\\w.-])([\\w.-]*${SENSITIVE_WORD}[\\w.-]*)(?:["'][ \\t]*:|["']?[ \\t]*(?:=>|=)|[ \\t]*:(?=\\s))[ \\t]*`, "gi");
/** Kubernetes and ECS write a variable as two fields: `name: DB_PASSWORD` then `value: …`. */
const NAMED_VALUE = new RegExp(`name["']?\\s*:\\s*["']?([\\w.-]*${SENSITIVE_WORD}[\\w.-]*)["']?\\s*,?\\s*["']?value["']?[ \\t]*:[ \\t]*`, "gi");
/** Keys that only point at a secret or describe one. */
const POINTER_KEY = /(?:name|id|arn|ref|file|path|url|uri|length|type|version|enabled|policy|days|ttl|expiry|expiration|seconds|prefix|suffix|endpoint|required|algorithm|namespace|mode|keys|rotation)$/i;
/** References and placeholders, which hold no secret themselves. */
const NOT_A_SECRET = /^(?:\$\{[\w.[\]-]+\}$|\$\(|\$[A-Za-z_]\w*$|\{\{|<[^>]*>$|\*{3}|(?:var|local|module|data|each|count|self)\.|arn:|[a-z][a-z0-9]*_[a-z0-9_]+\.[\w-]+\.|(?:true|false|null|none|changeme)$)/i;

/** The value that starts at `at`: quoted, a YAML block, or bare. */
function valueAt(text: string, at: number): { start: number; end: number } | undefined {
  const quote = text[at];
  if (quote === '"' || quote === "'") {
    let end = at + 1;
    while (end < text.length && text[end] !== quote && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1;
    return { start: at + 1, end };
  }
  const block = /^[|>][+-]?\d?[ \t]*\r?\n/.exec(text.slice(at, at + 20));
  if (block) {
    const indent = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", at) + 1))![0].length;
    const lines = /^([ \t]*)\S.*$/gm;
    lines.lastIndex = at + block[0].length;
    let first: number | undefined;
    let end = 0;
    for (let line; (line = lines.exec(text)) && line[1].length > indent; end = lines.lastIndex) first ??= line.index + line[1].length;
    return first === undefined ? undefined : { start: first, end };
  }
  // `${VAR}` stays in one piece; any other brace ends the value.
  const bare = /^(?:\$\{[^}\n]*\}|[^\s"',}\]#{[(&*])(?:\$\{[^}\n]*\}|[^\s"',}\]#])*/.exec(text.slice(at, at + 4096));
  return bare ? { start: at, end: at + bare[0].length } : undefined;
}

function assignments(text: string): Match[] {
  const found: Match[] = [];
  for (const pattern of [ASSIGNMENT, NAMED_VALUE])
    for (const match of text.matchAll(pattern)) {
      if (pattern === ASSIGNMENT && POINTER_KEY.test(match[1])) continue;
      const range = valueAt(text, match.index + match[0].length);
      if (!range) continue;
      const value = text.slice(range.start, range.end);
      const bare = !/["']/.test(text[range.start - 1] ?? "");
      if (value.length < 6 || NOT_A_SECRET.test(value) || (bare && /^\w+\(/.test(value))) continue;
      found.push({ type: /pass|pwd/i.test(match[1]) ? "Password" : "Secret value", ...range });
    }
  return found;
}

const entropy = (s: string) => {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  return -[...counts.values()].reduce((sum, n) => sum + (n / s.length) * Math.log2(n / s.length), 0);
};

/** Long random-looking strings, such as an AWS secret key under a name that gives nothing away. */
function randomStrings(text: string): Match[] {
  const found: Match[] = [];
  for (const m of text.matchAll(/(?<=["'=:][ \t]*)[A-Za-z0-9+/_=-]{32,}(?=["'\s,}\]]|$)/gm)) {
    const s = m[0];
    // Digests, paths and ids lack one of the three character classes, repeat themselves or are full of slashes.
    if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/\d/.test(s) || /^sha\d+-/.test(s) || s.split("/").length > 4 || entropy(s) < 4.3) continue;
    found.push({ type: "High-entropy string", start: m.index, end: m.index + s.length });
  }
  return found;
}

/** Everything under `data` and `stringData` of a Kubernetes Secret, whatever the keys are called. */
function kubernetesSecrets(text: string): Match[] {
  if (!/\bkind["']?\s*:\s*["']?Secret\b/.test(text)) return [];
  const found: Match[] = [];
  const hide = (node: unknown) => {
    if (!isScalar(node) || !node.range || node.value === null || node.value === "" || node.value === REDACTED) return;
    const [start, end] = node.range;
    // A block scalar's range runs past its last line break, which has to stay.
    found.push({ type: "Kubernetes Secret", start, end: start + text.slice(start, end).trimEnd().length, with: `"${REDACTED}"` });
  };
  const visit = (node: unknown) => {
    if (isSeq(node)) node.items.forEach(visit);
    if (!isMap(node)) return;
    if (String(node.get("kind")) !== "Secret") return visit(node.get("items", true));
    for (const key of ["data", "stringData", "binaryData"]) {
      const map = node.get(key, true);
      if (isMap(map)) for (const pair of map.items) hide(pair.value);
    }
    // `kubectl apply` keeps a copy of the whole manifest, values included, in an annotation.
    const metadata = node.get("metadata", true);
    const annotations = isMap(metadata) ? metadata.get("annotations", true) : undefined;
    if (isMap(annotations)) hide(annotations.get("kubectl.kubernetes.io/last-applied-configuration", true));
  };
  const docs = parseAllDocuments(text);
  if (Array.isArray(docs)) for (const doc of docs) visit(doc.contents);
  return found;
}

/** Terraform says which of its values are sensitive: rewrite the document with those hidden. */
function terraformSensitive(text: string): { text: string; types: string[] } {
  const types: string[] = [];
  if (!/"format_version"/.test(text)) return { text, types };
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return { text, types };
  }
  const hide = (value: any, sensitive: any): any => {
    if (sensitive === true) {
      if (value === null || value === undefined || value === REDACTED) return value;
      if (typeof value === "object") return hideAll(value);
      types.push("Terraform sensitive value");
      return REDACTED;
    }
    if (value && typeof value === "object" && sensitive && typeof sensitive === "object")
      for (const key of Object.keys(value)) value[key] = hide(value[key], sensitive[key]);
    return value;
  };
  const hideAll = (value: any): any => {
    for (const key of Object.keys(value)) value[key] = hide(value[key], true);
    return value;
  };
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.sensitive_values) hide(node.values, node.sensitive_values);
    if (node.before_sensitive) node.before = hide(node.before, node.before_sensitive);
    if (node.after_sensitive) node.after = hide(node.after, node.after_sensitive);
    if (node.sensitive === true && "value" in node) node.value = hide(node.value, true);
    Object.values(node).forEach(walk);
  };
  walk(data);
  // A plan's input variables carry no mark of their own; the configuration says which are sensitive.
  for (const [name, declared] of Object.entries<any>(data.configuration?.root_module?.variables ?? {}))
    if (declared?.sensitive && data.variables?.[name]) data.variables[name].value = hide(data.variables[name].value, true);
  return types.length ? { text: JSON.stringify(data, null, text.includes("\n  ") ? 2 : undefined), types } : { text, types };
}

/** Bare `***` starts a YAML alias and breaks JSON, so a value that begins there gets quotes. */
function replacement(text: string, start: number): string {
  const before = text.slice(text.lastIndexOf("\n", start - 1) + 1, start);
  const open = (quote: string) => (before.replace(/\\./g, "").split(quote).length - 1) % 2 === 1;
  if (open('"') || open("'")) return REDACTED;
  return /(["']\s*:\s*|:\s+|^\s*-\s+|[[{,]\s*)$/.test(before) ? `"${REDACTED}"` : REDACTED;
}

/** The text with every secret replaced, and the type of each one found. */
export function redact(input: string): { text: string; findings: string[] } {
  const terraform = terraformSensitive(input);
  const text = terraform.text;
  const matches: Match[] = [...kubernetesSecrets(text), ...assignments(text), ...randomStrings(text)];
  for (const [type, pattern] of PATTERNS)
    for (const m of text.matchAll(pattern)) {
      const [start, end] = m.indices![1] ?? m.indices![0]!;
      if (!NOT_A_SECRET.test(text.slice(start, end))) matches.push({ type, start, end });
    }

  // Where matches overlap, one replacement covers them all, named after the more specific one.
  const generic = new Set(["Secret value", "High-entropy string"]);
  const merged: Match[] = [];
  for (const m of matches.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1);
    if (!last || m.start >= last.end) merged.push({ ...m });
    else {
      last.end = Math.max(last.end, m.end);
      if (generic.has(last.type) && !generic.has(m.type)) last.type = m.type;
    }
  }
  let out = "";
  let at = 0;
  for (const m of merged) {
    out += text.slice(at, m.start) + (m.with ?? replacement(text, m.start));
    at = m.end;
  }
  return { text: out + text.slice(at), findings: [...terraform.types, ...merged.map((m) => m.type)] };
}

/** `["Password", "Password", "JWT"]` → `Password ×2, JWT`. */
export function summarize(findings: string[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f, (counts.get(f) ?? 0) + 1);
  return [...counts].map(([type, n]) => (n > 1 ? `${type} ×${n}` : type)).join(", ");
}
