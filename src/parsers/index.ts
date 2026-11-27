/** Turns the text of one or many files into one topology, whatever formats they are in. Runs in the browser only. */
import { hclToInfra, parseBlocks, type HclFile } from "../lib/hcl.ts";
import { normalize, type Infra, type InfraNode } from "../lib/model.ts";
import { readSnapshot, type Camera } from "../lib/snapshot.ts";
import { parseCompose } from "./compose.ts";
import { parseKubernetes } from "./kubernetes.ts";
import { configBlocks, findResource, parseTerraformJson, type Diff } from "./terraform-json.ts";

export interface SourceFile {
  path: string;
  text: string;
}

export type Format = "hcl" | "terraform-config" | "terraform-json" | "topolore" | "snapshot" | "compose" | "kubernetes" | "unknown";

export interface Loaded {
  infra: Infra;
  /** The files the topology came from; files that played no part are left out. */
  sources: SourceFile[];
  /** Set by a Terraform plan with changes: `infra` is then the target. */
  diff?: Diff;
  camera?: Camera;
  /** What could not be read, one line each. */
  warnings: string[];
}

const IGNORED = /(^|\/)(\.git|node_modules|\.terraform)\/|(^|\/)(\.terraform\.lock\.hcl|package-lock\.json)$/;

/** Whether a file found in a folder is worth reading. */
export const wanted = (path: string) => /\.(tf|hcl|json|jsonl|ya?ml)$/i.test(path) && !IGNORED.test(path);

const HCL_BLOCK = /^[ \t]*(resource|node|group|edge|module|provider|terraform|variable|locals|data|output)\b[^\n:]*\{/m;

export function detectFormat(path: string, text: string): Format {
  if (/\.tf\.json$/i.test(path)) return "terraform-config";
  if (/\.(tf|hcl)$/i.test(path)) return "hcl";
  if (/^\s*[[{]/.test(text) || /\.json$/i.test(path)) {
    if (/^\s*\{\s*"@level"/.test(text))
      throw new Error("This is the log of `terraform plan -json`. Load the output of `terraform show -json <planfile>` instead.");
    const data = JSON.parse(text) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return "unknown";
    if (data.rawSources || (data.version && data.topology)) return "snapshot";
    if (data.format_version && ["values", "planned_values", "resource_changes", "prior_state", "terraform_version"].some((k) => k in data))
      return "terraform-json";
    if (["nodes", "groups", "edges"].some((k) => Array.isArray(data[k]))) return "topolore";
    if (data.apiVersion && data.kind) return "kubernetes";
    if (data.services && typeof data.services === "object") return "compose";
    if (["resource", "data", "module", "terraform"].some((k) => data[k] && typeof data[k] === "object")) return "terraform-config";
    return "unknown";
  }
  const yaml = /\.ya?ml$/i.test(path);
  if (!yaml && HCL_BLOCK.test(text)) return "hcl";
  if (/^services\s*:/m.test(text)) return "compose";
  if (/^apiVersion\s*:/m.test(text) && /^kind\s*:/m.test(text)) return "kubernetes";
  return yaml ? "unknown" : "hcl";
}

/** Joins topologies from different formats; a later id that is already taken gets a number. */
function merge(parts: Infra[]): Infra {
  if (parts.length === 1) return parts[0];
  const taken = new Set<string>();
  const out: Infra = { title: parts.find((p) => p.title)?.title, links: parts.flatMap((p) => p.links ?? []), groups: [], nodes: [], edges: [] };
  for (const part of parts) {
    const renamed = new Map<string, string>();
    for (const item of [...part.groups, ...part.nodes]) {
      let id = item.id;
      for (let n = 2; taken.has(id); n++) id = `${item.id}~${n}`;
      taken.add(id);
      renamed.set(item.id, id);
    }
    const id = (old: string) => renamed.get(old) ?? old;
    const move = <T extends { id: string; parent?: string }>(x: T) => ({ ...x, id: id(x.id), parent: x.parent && id(x.parent) });
    out.groups.push(...part.groups.map(move));
    out.nodes.push(...part.nodes.map(move));
    out.edges.push(...part.edges.map((e) => ({ ...e, id: `${id(e.from)}->${id(e.to)}`, from: id(e.from), to: id(e.to) })));
  }
  return normalize(out);
}

export function ingest(files: SourceFile[]): Loaded {
  const warnings: string[] = [];
  const single = files.length === 1;
  /** With one file an error is the answer; among many, one bad file must not hide the rest. */
  const attempt = <T>(file: SourceFile, read: () => T): T | undefined => {
    try {
      return read();
    } catch (e) {
      if (single) throw e;
      warnings.push(`${file.path}: ${(e as Error).message}`);
    }
  };

  const found: { file: SourceFile; format: Format }[] = [];
  for (const file of files) {
    const format = attempt(file, () => detectFormat(file.path, file.text));
    if (format && format !== "unknown") found.push({ file, format });
    else if (format && single)
      throw new Error("Topolore cannot tell what this is. It reads HCL, Terraform, `terraform show -json`, docker compose, Kubernetes YAML and Topolore JSON.");
  }

  const snapshots = found.filter((f) => f.format === "snapshot");
  if (snapshots.length && snapshots.length === found.length) {
    if (snapshots.length > 1) warnings.push("Only the first .topolore.json snapshot was opened.");
    const loaded = readSnapshot(snapshots[0].file.text, ingest);
    return { ...loaded, warnings: [...warnings, ...loaded.warnings] };
  }
  for (const s of snapshots) warnings.push(`${s.file.path}: a snapshot is only opened on its own.`);

  const parts: Infra[] = [];
  const sources: SourceFile[] = [];
  const diffs: Diff[] = [];
  const of = (...formats: Format[]) => found.filter((f) => formats.includes(f.format));

  const hcl: HclFile[] = [];
  for (const { file, format } of of("hcl", "terraform-config")) {
    const root = attempt(file, () => (format === "hcl" ? parseBlocks(file.text) : configBlocks(JSON.parse(file.text))));
    if (root) hcl.push({ path: file.path, root }), sources.push(file);
  }
  if (hcl.length) parts.push(hclToInfra(hcl));

  for (const [format, parse] of [["compose", parseCompose], ["kubernetes", parseKubernetes]] as const) {
    const readable: SourceFile[] = [];
    // Each file is checked alone first, so one broken file is reported and the others still load.
    for (const { file } of of(format)) if (attempt(file, () => parse([file]))) readable.push(file);
    if (!readable.length) continue;
    const result = parse(readable);
    warnings.push(...result.warnings);
    parts.push(result.infra);
    sources.push(...readable);
  }

  for (const { file } of of("terraform-json")) {
    const result = attempt(file, () => parseTerraformJson(JSON.parse(file.text), file.path));
    if (!result) continue;
    parts.push(result.infra);
    sources.push(file);
    if (result.diff) diffs.push(result.diff);
  }

  for (const { file } of of("topolore")) {
    const infra = attempt(file, () => normalize(JSON.parse(file.text)));
    if (infra) parts.push(infra), sources.push(file);
  }

  const useful = single ? parts : parts.filter((p) => p.nodes.length);
  if (!useful.length) throw new Error(warnings[0] ?? "No infrastructure found in these files.");
  const diff = diffs.length === 1 && useful.length === 1 ? diffs[0] : undefined;
  if (diffs.length && !diff) warnings.push("Plan changes are only compared when the plan is loaded on its own.");
  return { infra: merge(useful), sources, diff, warnings };
}

/** The part of a source file that declares a node, if it can be found. */
export function sourceBlock(node: InfraNode, sources: SourceFile[]): string | undefined {
  const file = sources.find((s) => s.path === node.sourceFile) ?? (sources.length === 1 && !node.sourceFile ? sources[0] : undefined);
  if (!file) return;
  if (node.lineStart) return file.text.split("\n").slice(node.lineStart - 1, node.lineEnd).join("\n");
  // JSON has no useful line numbers (Terraform writes it on one line): show the entry itself.
  try {
    const data = JSON.parse(file.text);
    const entry = data.format_version ? findResource(data, node.id) : data.nodes?.find((n: { id?: string }) => n.id === node.id);
    return entry && JSON.stringify(entry, null, 2);
  } catch {
    return;
  }
}
