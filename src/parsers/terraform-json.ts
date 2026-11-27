/** `terraform show -json` of a state or a plan, and Terraform written as `.tf.json`. */
import { terraformKind } from "../lib/catalog.ts";
import { Ref, type Block, type Value } from "../lib/hcl.ts";
import { edgeId, normalize, type Edge, type Infra, type InfraNode } from "../lib/model.ts";

// Terraform's documents are deep and loosely typed; every access below allows for a missing field.
type Obj = Record<string, any>;

export interface Diff {
  base: Infra;
  target: Infra;
}

interface Resource {
  address: string;
  mode?: string;
  type: string;
  name: string;
  values?: unknown;
  depends_on?: string[];
}

const isObject = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const resourcesIn = (module: Obj | undefined): Resource[] =>
  module ? [...(module.resources ?? []), ...(module.child_modules ?? []).flatMap(resourcesIn)] : [];

/** `module.a[0].aws_x.y["k"]` → `module.a.aws_x.y`, the address as the configuration writes it. */
const unindexed = (address: string) => address.replace(/\[[^\]]*\]/g, "");
/** The module instance an address sits in: `module.a[0]`, or "" for the root. */
const moduleOf = (address: string) => address.replace(/(^|\.)(data\.)?[\w-]+\.[\w-]+(\[[^\]]*\])?$/, "");

/** Replaces what Terraform marks as sensitive. `sensitive` mirrors the value, with `true` at secret places. */
function mask(value: unknown, sensitive: unknown, replace: (secret: unknown) => string = () => "(sensitive)"): unknown {
  if (sensitive === true) return replace(value);
  if (Array.isArray(value)) return value.map((v, i) => mask(v, (sensitive as unknown[] | undefined)?.[i]));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, (sensitive as Obj | undefined)?.[k])]));
  return value;
}

/** Every `references` list anywhere inside a configuration expression. */
function referencesIn(expression: unknown): string[] {
  if (Array.isArray(expression)) return expression.flatMap(referencesIn);
  if (!isObject(expression)) return [];
  return Array.isArray(expression.references) ? expression.references : Object.values(expression).flatMap(referencesIn);
}

interface Context {
  module: Obj;
  prefix: string;
  inputs?: Obj;
  parent?: Context;
}

/** `[from, to]` pairs of configuration addresses, following module inputs, outputs and data sources. */
function configEdges(root: Obj | undefined): [string, string][] {
  const pairs: [string, string][] = [];
  const child = (ctx: Context, name: string): Context | undefined => {
    const call = ctx.module.module_calls?.[name];
    return call?.module && { module: call.module, prefix: `${ctx.prefix}module.${name}.`, inputs: call.expressions, parent: ctx };
  };
  const resolve = (reference: string, ctx: Context, seen: Set<string>): string[] => {
    const key = `${ctx.prefix}|${reference}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const parts = unindexed(reference).split(".");
    const through = (expression: unknown, where: Context) => referencesIn(expression).flatMap((r) => resolve(r, where, seen));
    switch (parts[0]) {
      case "var":
        return ctx.parent ? through(ctx.inputs?.[parts[1]], ctx.parent) : [];
      case "module": {
        const inner = child(ctx, parts[1]);
        return inner && parts[2] ? through(inner.module.outputs?.[parts[2]]?.expression, inner) : [];
      }
      case "data": {
        const data = ctx.module.resources?.find((r: Obj) => r.address === parts.slice(0, 3).join("."));
        return through(data?.expressions, ctx);
      }
      case "local":
      case "each":
      case "count":
      case "path":
      case "self":
      case "terraform":
        return [];
      default:
        return parts.length > 1 ? [`${ctx.prefix}${parts[0]}.${parts[1]}`] : [];
    }
  };
  const visit = (ctx: Context) => {
    for (const r of ctx.module.resources ?? []) {
      if (r.mode === "data") continue;
      const references = [...referencesIn([r.expressions, r.count_expression, r.for_each_expression]), ...(r.depends_on ?? [])];
      const seen = new Set<string>();
      for (const to of references.flatMap((x) => resolve(x, ctx, seen))) pairs.push([ctx.prefix + r.address, to]);
    }
    for (const name of Object.keys(ctx.module.module_calls ?? {})) {
      const inner = child(ctx, name);
      if (inner) visit(inner);
    }
  };
  if (root) visit({ module: root, prefix: "" });
  return pairs;
}

/** Instance-level links from configuration-level pairs: `count` and `for_each` give one address many instances. */
function linker(addresses: string[]) {
  const instances = new Map<string, string[]>();
  for (const address of addresses) {
    const key = unindexed(address);
    const list = instances.get(key);
    if (list) list.push(address);
    else instances.set(key, [address]);
  }
  return (pairs: [string, string][]): [string, string][] =>
    pairs.flatMap(([a, b]) =>
      (instances.get(unindexed(a)) ?? []).flatMap((from) => {
        const all = instances.get(unindexed(b)) ?? [];
        const near = all.filter((to) => moduleOf(to) === moduleOf(from));
        return (near.length ? near : all).map((to): [string, string] => [from, to]);
      }),
    );
}

const dependencies = (resources: Resource[]): [string, string][] =>
  resources.flatMap((r) => (r.depends_on ?? []).map((to): [string, string] => [r.address, to]));

function toInfra(resources: Resource[], links: [string, string][], path: string): Infra {
  const nodes: InfraNode[] = resources.map((r) => {
    const values = isObject(r.values) ? r.values : {};
    const label = [values.name, values.function_name, values.identifier].find((v) => typeof v === "string" && v);
    return {
      id: r.address,
      label: label ?? r.address.slice(r.address.lastIndexOf(`${r.type}.`) + r.type.length + 1),
      kind: terraformKind(r.type),
      props: { terraform: r.type, ...Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== null && k !== "tags_all")) },
      sourceFile: path || undefined,
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = new Map<string, Edge>();
  for (const [from, to] of links)
    if (from !== to && ids.has(from) && ids.has(to)) edges.set(edgeId(from, to), { id: edgeId(from, to), from, to });
  return normalize({ nodes, edges: [...edges.values()] });
}

const isManaged = (r: { mode?: string }) => r.mode !== "data";

export function parseTerraformJson(data: Obj, path = ""): { infra: Infra; diff?: Diff } {
  const priorValues = data.prior_state?.values?.root_module;
  const config = configEdges(data.configuration?.root_module);
  const changes: Obj[] = (data.resource_changes ?? []).filter((c: Obj) => isManaged(c) && !c.change?.actions?.includes("read"));

  if (!changes.some((c) => c.change.actions.some((a: string) => a !== "no-op"))) {
    const current = data.values?.root_module ?? data.planned_values?.root_module ?? priorValues;
    const resources = resourcesIn(current)
      .filter(isManaged)
      .map((r: Obj) => ({ ...(r as Resource), values: mask(r.values, r.sensitive_values) }));
    if (!resources.length) throw new Error("This Terraform file holds no resources.");
    const links = linker(resources.map((r) => r.address))([...config, ...dependencies(resources)]);
    return { infra: toInfra(resources, links, path) };
  }

  const prior = new Map(resourcesIn(priorValues).map((r) => [r.address, r]));
  const planned = new Map(resourcesIn(data.planned_values?.root_module).map((r) => [r.address, r]));
  const common = (c: Obj) => ({ address: c.address as string, type: c.type as string, name: c.name as string });

  const before: Resource[] = changes
    .filter((c) => c.change.before)
    .map((c) => ({ ...common(c), values: mask(c.change.before, c.change.before_sensitive), depends_on: prior.get(c.address)?.depends_on }));
  const after: Resource[] = changes
    .filter((c) => c.change.after)
    .map((c) => {
      const { before, after, after_sensitive, after_unknown } = c.change;
      // A secret stays hidden, but a plan that changes it must still say so.
      const values = mask(after, after_sensitive) as Obj;
      for (const key of Object.keys(after)) {
        const changed = before && JSON.stringify(before[key]) !== JSON.stringify(after[key]);
        if (changed && JSON.stringify(values[key]) !== JSON.stringify(after[key])) values[key] = mask(after[key], after_sensitive?.[key], () => "(sensitive, changed)");
      }
      for (const [key, unknown] of Object.entries(after_unknown ?? {})) if (unknown === true) values[key] = "(known after apply)";
      return { ...common(c), values, depends_on: planned.get(c.address)?.depends_on };
    });

  const targetLinks = linker(after.map((r) => r.address))([...config, ...dependencies(after)]);
  // A plan holds only the new configuration, so old links are worked out: an unchanged resource keeps its links, a
  // changed one keeps those its old state already depended on, and a removed one has only its old dependencies.
  // shortcut: a link dropped between two surviving resources is not seen; compare two `terraform show -json` states for that.
  const noop = new Set(changes.filter((c) => c.change.actions.every((a: string) => a === "no-op")).map((c) => c.address));
  const survivors = new Set(after.map((r) => r.address));
  const priorLinks = linker(before.map((r) => r.address))(dependencies(before));
  const priorKeys = new Set(priorLinks.map(([a, b]) => edgeId(a, b)));
  const kept = targetLinks.filter(([a, b]) => noop.has(a) || priorKeys.has(edgeId(a, b)));
  const removed = priorLinks.filter(([a, b]) => !survivors.has(a) || !survivors.has(b));

  const target = toInfra(after, targetLinks, path);
  return { infra: target, diff: { base: toInfra(before, [...kept, ...removed], path), target } };
}

/** The raw entry for one resource, wherever the document keeps it. */
export function findResource(data: Obj, address: string): unknown {
  const modules = [data.values, data.planned_values, data.prior_state?.values].map((v) => v?.root_module);
  return (
    data.resource_changes?.find((c: Obj) => c.address === address) ??
    modules.flatMap(resourcesIn).find((r) => r.address === address)
  );
}

/** `.tf.json` configuration as the same blocks the HCL reader makes, so both resolve references together. */
export function configBlocks(data: Obj): Block {
  const block = (type: string, labels: string[], attrs: unknown): Block => ({
    type,
    labels,
    attrs: (isObject(attrs) ? attrs : {}) as Record<string, Value>,
    blocks: [],
  });
  const each = (v: unknown): [string, any][] => [v ?? {}].flat().flatMap((x) => Object.entries(x as Obj));
  const blocks: Block[] = [];
  for (const type of ["resource", "data"])
    for (const [kind, named] of each(data[type]))
      for (const [name, body] of each(named)) {
        const attrs = { ...[body].flat()[0] };
        // In JSON, `depends_on` holds bare addresses as strings.
        if (Array.isArray(attrs.depends_on)) attrs.depends_on = attrs.depends_on.map((d: unknown) => (typeof d === "string" ? new Ref(d) : d));
        blocks.push(block(type, [kind, name], attrs));
      }
  for (const [, locals] of each({ locals: data.locals })) for (const x of [locals ?? {}].flat()) blocks.push(block("locals", [], x));
  for (const [name, body] of each(data.variable)) blocks.push(block("variable", [name], [body].flat()[0]));
  return { type: "", labels: [], attrs: {}, blocks };
}
