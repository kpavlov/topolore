import { edgeId, normalize, type Edge, type Group, type Infra, type InfraNode } from "./model.ts";
import { terraformKind } from "./catalog.ts";

/*
 * A small HCL reader for infrastructure files. Two block styles, mixable in one file:
 *
 *   group "vpc" { label = "VPC"  kind = "aws.vpc"
 *     node "db" { kind = "aws.rds"  label = "orders" }
 *   }
 *   edge "api" "db" { protocol = "postgres" }
 *
 * and Terraform resources, whose references become edges:
 *
 *   resource "aws_lambda_function" "fn" { role = aws_iam_role.fn.arn  group = "vpc" }
 */

type Value = string | number | boolean | null | Ref | Value[] | { [key: string]: Value };
class Ref {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
}
interface Block {
  type: string;
  labels: string[];
  attrs: Record<string, Value>;
  blocks: Block[];
}

const TOKEN = /\s+|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|[A-Za-z_][\w.\-*[\]]*|[{}[\]=,:()]|<<-?(\w+)\n[\s\S]*?\n\s*\1/y;

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(source);
    if (!match) {
      const line = source.slice(0, at).split("\n").length;
      throw new Error(`Line ${line}: cannot read "${source.slice(at, at + 12)}".`);
    }
    const token = match[0];
    if (/^\s|^#|^\/\//.test(token) || token.startsWith("/*")) continue;
    if (token.includes("\n") && token.startsWith("\n")) continue;
    tokens.push(token);
  }
  return tokens;
}

export function parseHcl(source: string): Infra {
  const tokens = tokenize(source);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (token: string) => {
    if (next() !== token) throw new Error(`Expected "${token}" near "${tokens.slice(Math.max(0, i - 3), i + 2).join(" ")}".`);
  };

  function value(): Value {
    const token = next();
    if (token === undefined) throw new Error("The file ends in the middle of a value.");
    if (token.startsWith('"')) return JSON.parse(token);
    if (token.startsWith("<<")) return token.replace(/^<<-?\w+\n/, "").replace(/\n\s*\w+$/, "");
    if (/^-?\d/.test(token)) return Number(token);
    if (token === "true" || token === "false") return token === "true";
    if (token === "null") return null;
    if (token === "[") {
      const items: Value[] = [];
      while (peek() !== "]") {
        items.push(value());
        if (peek() === ",") next();
      }
      next();
      return items;
    }
    if (token === "{") return body(true).attrs;
    // A function call like jsonencode(...) keeps only the references inside it.
    if (peek() === "(") {
      next();
      const args: Value[] = [];
      while (peek() !== ")") {
        args.push(value());
        if (peek() === ",") next();
      }
      next();
      return args;
    }
    return new Ref(token);
  }

  function body(objectLiteral = false): Block {
    const block: Block = { type: "", labels: [], attrs: {}, blocks: [] };
    while (peek() !== "}") {
      if (peek() === undefined) throw new Error("A block is missing its closing }.");
      const key = next();
      const name = key.startsWith('"') ? JSON.parse(key) : key;
      if (peek() === "=" || peek() === ":") {
        next();
        block.attrs[name] = value();
      } else if (!objectLiteral) {
        const labels: string[] = [];
        while (peek()?.startsWith('"')) labels.push(JSON.parse(next()));
        expect("{");
        block.blocks.push({ ...body(), type: name, labels });
      } else throw new Error(`Expected "=" after "${name}".`);
      if (peek() === ",") next();
    }
    next();
    return block;
  }

  tokens.push("}");
  return toInfra(body());
}

function toInfra(root: Block): Infra {
  const groups: Group[] = [];
  const nodes: InfraNode[] = [];
  const edges: Edge[] = [];
  const resources: { node: InfraNode; attrs: Value[] }[] = [];
  const str = (v: Value | undefined) => (typeof v === "string" ? v : undefined);
  const num = (v: Value | undefined) => (typeof v === "number" ? v : undefined);
  const plain = (attrs: Record<string, Value>, skip: string[]) =>
    Object.fromEntries(Object.entries(attrs).filter(([k, v]) => !skip.includes(k) && !(v instanceof Ref)));

  const nested = (b: Block): Value[] => [...Object.values(b.attrs), ...b.blocks.flatMap(nested)];

  function walk(block: Block, parent?: string) {
    for (const child of block.blocks) {
      const a = child.attrs;
      switch (child.type) {
        case "group":
          groups.push({ id: child.labels[0], label: str(a.label) ?? child.labels[0], kind: str(a.kind), parent });
          walk(child, child.labels[0]);
          break;
        case "node":
          nodes.push({
            id: child.labels[0],
            label: str(a.label) ?? child.labels[0],
            kind: str(a.kind) ?? "generic",
            parent: str(a.group) ?? parent,
            state: str(a.state) as InfraNode["state"],
            props: (a.props as Record<string, unknown>) ?? plain(a, ["label", "kind", "group", "state"]),
          });
          for (const to of [a.calls ?? []].flat()) if (typeof to === "string") edges.push({ id: edgeId(child.labels[0], to), from: child.labels[0], to });
          break;
        case "edge": {
          const [from, to] = child.labels;
          edges.push({ id: edgeId(from, to), from, to, label: str(a.label), protocol: str(a.protocol), rps: num(a.rps), latencyMs: num(a.latency_ms) ?? num(a.latencyMs), speed: str(a.speed) as Edge["speed"], state: str(a.state) as Edge["state"] });
          break;
        }
        case "resource": {
          const [type, name] = child.labels;
          const node: InfraNode = {
            id: `${type}.${name}`,
            label: str(a.name) ?? str(a.function_name) ?? str(a.identifier) ?? name,
            kind: terraformKind(type),
            parent: str(a.group) ?? parent,
            props: { terraform: type, ...plain(a, ["group", "tags"]) },
          };
          nodes.push(node);
          resources.push({ node, attrs: nested(child) });
          break;
        }
        default:
          walk(child, parent); // module, locals, provider and other wrappers are looked through
      }
    }
  }
  walk(root);

  // Terraform: a resource that refers to another one depends on it, so traffic goes that way.
  const ids = new Set(resources.map((r) => r.node.id));
  for (const { node, attrs } of resources) {
    const refs = new Set<string>();
    const collect = (v: Value) => {
      if (v instanceof Ref) {
        const id = v.path.split(".").slice(0, 2).join(".").replace(/\[.*$/, "");
        if (ids.has(id) && id !== node.id) refs.add(id);
      } else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
      else if (typeof v === "string") for (const m of v.matchAll(/\$\{([\w.]+)/g)) collect(new Ref(m[1]));
    };
    attrs.forEach(collect);
    for (const to of refs) edges.push({ id: edgeId(node.id, to), from: node.id, to });
  }

  return normalize({ title: str(root.attrs.title), groups, nodes, edges });
}
