/** What leaves the app: the text a share link carries, and `.topolore.json` snapshots. */
import { redact } from "../security/secretScrubber.ts";
import { detectFormat, type Loaded, type SourceFile } from "../parsers/index.ts";
import { edgeId, normalize, type Infra } from "./model.ts";
import type { View } from "./scene.ts";

export interface Camera {
  view: View;
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
}

/** Past this, chat apps and some browsers cut a link short. */
export const URL_LIMIT = 4000;

export interface Outgoing {
  text: string;
  /** The types of the secrets found, whether or not they were redacted. */
  findings: string[];
}

/** Applies redaction file by file, so formats that need parsing (Secrets, Terraform JSON) are recognised. */
function scrubber(hide: boolean) {
  const findings: string[] = [];
  return {
    findings,
    clean(text: string): string {
      const result = redact(text);
      findings.push(...result.findings);
      return hide ? result.text : text;
    },
  };
}

/** The topology alone, without attributes, source positions or defaults. */
function compact(infra: Infra): string {
  return JSON.stringify({
    title: infra.title,
    groups: infra.groups,
    nodes: infra.nodes.map(({ props, sourceFile, lineStart, lineEnd, state, ...n }) => ({ ...n, state: state === "ok" ? undefined : state })),
    edges: infra.edges.map(({ id, state, ...e }) => ({ ...e, id: id === edgeId(e.from, e.to) ? undefined : id, state: state === "ok" ? undefined : state })),
  });
}

/** The text for a share link: the source files as they are, or with `layoutOnly` just the topology. */
export function sharePayload(infra: Infra, sources: SourceFile[], options: { redact: boolean; layoutOnly: boolean }): Outgoing {
  const { clean, findings } = scrubber(options.redact);
  if (options.layoutOnly || !sources.length) return { text: clean(compact(infra)), findings };
  const files = sources.map(({ path, text }) => ({ path, text: clean(text) }));
  // One file travels as plain text, as long as it is still recognised without its name.
  const [only] = files;
  const alone = files.length === 1 && detectFormat("", only.text) === detectFormat(only.path, only.text);
  return { text: alone ? only.text : JSON.stringify({ version: 1, rawSources: files }), findings };
}

export function writeSnapshot(infra: Infra, sources: SourceFile[], camera: Camera | undefined, hide: boolean): Outgoing {
  const { clean, findings } = scrubber(hide);
  const rawSources = sources.map(({ path, text }) => ({ path, text: clean(text) }));
  // The topology repeats what the sources say, so its findings are only new when there are no sources.
  const own = scrubber(hide);
  const topology = JSON.parse(own.clean(JSON.stringify(infra)));
  if (!sources.length) findings.push(...own.findings);
  return { text: JSON.stringify({ version: 1, timestamp: new Date().toISOString(), camera, topology, rawSources }, null, 2), findings };
}

const triple = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

function camera(value: unknown): Camera | undefined {
  const c = value as Camera | undefined;
  if (c && ["iso", "3d", "top"].includes(c.view) && triple(c.position) && triple(c.target) && c.zoom > 0 && Number.isFinite(c.zoom)) return c;
}

/** Opens a snapshot or a link's bundle of files. `ingest` reads the files when there is no stored topology. */
export function readSnapshot(text: string, ingest: (files: SourceFile[]) => Loaded): Loaded {
  const data = JSON.parse(text);
  if (data.version !== 1) throw new Error(`This snapshot has version ${data.version}; this Topolore reads version 1.`);
  const sources: SourceFile[] = (Array.isArray(data.rawSources) ? data.rawSources : []).filter(
    (s: SourceFile) => typeof s?.path === "string" && typeof s.text === "string",
  );
  if (data.topology) return { infra: normalize(data.topology), sources, camera: camera(data.camera), warnings: [] };
  // A bundle inside a bundle would recurse for ever.
  if (!sources.length || sources.some((s) => /"rawSources"/.test(s.text))) throw new Error("This snapshot holds no topology.");
  return { ...ingest(sources), camera: camera(data.camera) };
}
