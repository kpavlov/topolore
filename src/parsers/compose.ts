/** docker compose: services become nodes; `depends_on`, `links` and shared networks become links. */
import { edgeId, normalize, type Edge, type Infra, type InfraNode } from "../lib/model.ts";
import { readYaml, type Obj } from "./yaml.ts";
import type { SourceFile } from "./index.ts";

const DATA_IMAGE = /^(postgres|postgresql|postgis|mysql|mariadb|redis|mongo|mongodb|kafka|cp-kafka|elasticsearch)$/;
const KIND: Record<string, string> = {
  postgres: "db.postgresql", postgresql: "db.postgresql", postgis: "db.postgresql", mysql: "db.mysql", mariadb: "db.mysql",
  redis: "db.redis", mongo: "db.mongodb", mongodb: "db.mongodb", kafka: "db.kafka", "cp-kafka": "db.kafka", elasticsearch: "db.elasticsearch",
};

/** `registry:5000/bitnami/postgresql:15@sha256:…` → `postgresql`. */
const imageName = (image: string) => image.split("@")[0].replace(/:[^/:]*$/, "").split("/").at(-1)!;

/** Compose allows both a list and a map for most keys. */
const names = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v && typeof v === "object" ? Object.keys(v) : []);
const envKeys = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).split("=")[0]) : names(v));
const port = (p: unknown) =>
  p && typeof p === "object" ? `${(p as Obj).published ?? ""}:${(p as Obj).target ?? ""}`.replace(/^:/, "") : String(p);

export function parseCompose(files: SourceFile[]): { infra: Infra; warnings: string[] } {
  // Later files override earlier ones key by key, as `docker compose -f a -f b` does.
  const services = new Map<string, { def: Obj; at: Partial<InfraNode> }>();
  for (const file of files)
    for (const doc of readYaml(file.text)) {
      for (const [name, def] of Object.entries((doc.value?.services ?? {}) as Obj)) {
        const old = services.get(name);
        const lines = doc.lines(["services", name]);
        services.set(name, { def: { ...old?.def, ...(def as Obj) }, at: old?.at ?? { sourceFile: file.path || undefined, ...lines } });
      }
    }
  if (!services.size) throw new Error("This compose file has no services.");

  const nodes: InfraNode[] = [];
  const edges = new Map<string, Edge>();
  const networks = new Map<string, string[]>();
  for (const [name, { def, at }] of services) {
    const image = typeof def.image === "string" ? def.image : undefined;
    const short = image ? imageName(image) : "";
    const props: Obj = {};
    if (image) props.image = image;
    if (def.build) props.build = typeof def.build === "string" ? def.build : def.build.context;
    if (def.ports) props.ports = [def.ports].flat().map(port);
    // Only the names: values are where passwords live.
    if (def.environment) props.environment = envKeys(def.environment);
    if (def.networks) props.networks = names(def.networks);
    nodes.push({ id: name, label: name, kind: DATA_IMAGE.test(short) ? KIND[short] : "docker", props, ...at });

    const targets = [...names(def.depends_on), ...names(def.links).map((l) => l.split(":")[0])];
    for (const to of targets)
      if (to !== name && services.has(to)) edges.set(edgeId(name, to), { id: edgeId(name, to), from: name, to });
    for (const network of names(def.networks))
      if (network !== "default") networks.set(network, [...(networks.get(network) ?? []), name]);
  }
  // Sharing a network says two services can talk, not which one calls: those links have no direction.
  // shortcut: one link per pair, so a network of many services is dense; draw networks as plates if that gets unreadable.
  for (const [network, members] of networks)
    for (const [i, from] of members.entries())
      for (const to of members.slice(i + 1))
        if (!edges.has(edgeId(from, to)) && !edges.has(edgeId(to, from)))
          edges.set(edgeId(from, to), { id: edgeId(from, to), from, to, label: network, protocol: "network", state: "idle", undirected: true });

  return { infra: normalize({ nodes, edges: [...edges.values()] }), warnings: [] };
}
