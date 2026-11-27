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
 *
 * Several files read together: each directory is one Terraform module, so a reference reaches resources, locals and
 * data sources declared in any file next to it.
 */

export type Value = string | number | boolean | null | Ref | Expr | Value[] | { [key: string]: Value };
export class Ref {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
}
/** Anything computed (a call, a ternary, a `for`): kept as its text, plus the values inside it to find references. */
export class Expr {
  text: string;
  parts: Value[];
  constructor(text: string, parts: Value[]) {
    this.text = text;
    this.parts = parts;
  }
}
export interface Block {
  type: string;
  labels: string[];
  attrs: Record<string, Value>;
  blocks: Block[];
  lineStart?: number;
  lineEnd?: number;
}
export interface HclFile {
  path: string;
  root: Block;
}

interface Token {
  text: string;
  at: number;
  end: number;
  line: number;
}

const TOKEN =
  /\s+|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|<<-?(\w+)\r?\n[\s\S]*?\n[ \t]*\1(?!\w)|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_][\w-]*(?:\.(?:\*|[\w-]+))*|\.\.\.|==|!=|<=|>=|&&|\|\||=>|[{}[\]=,:()?!<>+\-*/%.]/y;

/** The index after the string that starts at `at`; `${...}` may hold quotes of its own. */
function stringEnd(source: string, at: number): number {
  let depth = 0;
  for (let i = at + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i++;
    else if (!depth && c === '"') return i + 1;
    else if (!depth && c === "\n") return -1;
    else if (depth && c === '"') {
      const end = stringEnd(source, i);
      if (end < 0) return -1;
      i = end - 1;
    } else if ((c === "$" || c === "%") && source[i + 1] === "{" && source[i - 1] !== c) depth++, i++;
    else if (depth && c === "{") depth++;
    else if (depth && c === "}") depth--;
  }
  return -1;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let counted = 0;
  for (let at = 0; at < source.length; ) {
    for (; counted < at; counted++) if (source[counted] === "\n") line++;
    let end: number;
    if (source[at] === '"') end = stringEnd(source, at);
    else {
      TOKEN.lastIndex = at;
      end = TOKEN.exec(source) ? TOKEN.lastIndex : -1;
    }
    if (end < 0) throw new Error(`Line ${line}: cannot read "${source.slice(at, at + 12)}".`);
    const text = source.slice(at, end);
    if (!/^(\s|#|\/\/|\/\*)/.test(text)) tokens.push({ text, at, end, line });
    at = end;
  }
  return tokens;
}

const OPERATORS = new Set(["==", "!=", "<=", ">=", "&&", "||", "<", ">", "+", "-", "*", "/", "%", "?"]);

const unquote = (token: string): string => {
  try {
    return JSON.parse(token);
  } catch {
    return token.slice(1, -1); // interpolation with its own quotes is not valid JSON
  }
};

/** Reads one file into blocks. */
export function parseBlocks(source: string): Block {
  const tokens = tokenize(source);
  let i = 0;
  const peek = () => tokens[i]?.text;
  const next = () => tokens[i++]?.text;
  const near = () => `line ${tokens[Math.min(i, tokens.length - 1)]?.line ?? 1}`;
  const expect = (token: string) => {
    if (next() !== token) throw new Error(`Expected "${token}" on ${near()}.`);
  };
  /** The source text of the tokens from `from` up to here. */
  const textSince = (from: number) => source.slice(tokens[from].at, tokens[i - 1].end);

  function value(): Value {
    const from = i;
    const first = unary();
    if (!OPERATORS.has(peek()!)) return first;
    const parts = [first];
    while (OPERATORS.has(peek()!)) {
      if (next() === "?") {
        parts.push(value());
        expect(":");
        parts.push(value());
      } else parts.push(unary());
    }
    return new Expr(textSince(from), parts);
  }

  function unary(): Value {
    if (peek() !== "!" && peek() !== "-") return postfix(primary());
    const from = i;
    const sign = next();
    const operand = unary();
    return sign === "-" && typeof operand === "number" ? -operand : new Expr(textSince(from), [operand]);
  }

  /** `[0]`, `[count.index]`, `[*]` and the `.attr` after them. */
  function postfix(base: Value): Value {
    let result = base;
    while (peek() === "[" || peek() === ".") {
      if (next() === ".") next();
      else if (peek() === "*") next(), expect("]");
      else {
        const index = value();
        expect("]");
        if (index instanceof Ref || index instanceof Expr)
          result = new Expr(result instanceof Ref ? result.path : "…", [result, index]);
      }
    }
    return result;
  }

  /** A `for` expression: skip to its closing bracket, keeping what it refers to. */
  function comprehension(from: number): Value {
    const parts: Value[] = [];
    for (let depth = 1; depth; ) {
      const token = next();
      if (token === undefined) throw new Error("A for expression is not closed.");
      if (token === "[" || token === "{" || token === "(") depth++;
      else if (token === "]" || token === "}" || token === ")") depth--;
      else if (token.startsWith('"')) parts.push(unquote(token));
      else if (/^[A-Za-z_]/.test(token)) parts.push(new Ref(token));
    }
    return new Expr(textSince(from), parts);
  }

  function list(close: string): Value[] {
    const items: Value[] = [];
    while (peek() !== close) {
      if (peek() === undefined) throw new Error(`A list is missing its closing ${close}.`);
      items.push(value());
      if (peek() === "," || peek() === "...") next();
    }
    next();
    return items;
  }

  function primary(): Value {
    const from = i;
    const token = next();
    if (token === undefined) throw new Error("The file ends in the middle of a value.");
    if (token.startsWith('"')) return unquote(token);
    if (token.startsWith("<<")) return token.replace(/^<<-?\w+\r?\n/, "").replace(/\r?\n[ \t]*\w+$/, "");
    if (/^\d/.test(token)) return Number(token);
    if (token === "true" || token === "false") return token === "true";
    if (token === "null") return null;
    if (token === "(") {
      const inner = value();
      expect(")");
      return inner;
    }
    if (token === "[") return peek() === "for" ? comprehension(from) : list("]");
    if (token === "{") return peek() === "for" ? comprehension(from) : body(true).attrs;
    if (!/^[A-Za-z_]/.test(token)) throw new Error(`Unexpected "${token}" on ${near()}.`);
    if (peek() === "(") {
      next();
      const args = list(")");
      return new Expr(textSince(from), args);
    }
    return new Ref(token);
  }

  function body(objectLiteral = false): Block {
    const block: Block = { type: "", labels: [], attrs: {}, blocks: [] };
    while (peek() !== "}") {
      if (peek() === undefined) throw new Error("A block is missing its closing }.");
      const line = tokens[i].line;
      const key = next()!;
      let name = key.startsWith('"') ? unquote(key) : key;
      if (objectLiteral && key === "(") {
        const computed = value();
        expect(")");
        name = computed instanceof Ref ? `(${computed.path})` : "(computed)";
      }
      if (peek() === "=" || peek() === ":") {
        next();
        block.attrs[name] = value();
      } else if (!objectLiteral) {
        const labels: string[] = [];
        while (peek()?.startsWith('"')) labels.push(unquote(next()!));
        expect("{");
        const inner = body();
        block.blocks.push({ ...inner, type: name, labels, lineStart: line, lineEnd: tokens[i - 1].line });
      } else throw new Error(`Expected "=" after "${name}" on ${near()}.`);
      if (peek() === ",") next();
    }
    next();
    return block;
  }

  const end = tokens.at(-1);
  tokens.push({ text: "}", at: source.length, end: source.length, line: end?.line ?? 1 });
  const root = body();
  if (i < tokens.length) throw new Error(`Unexpected "}" on ${near()}.`);
  return root;
}

export const parseHcl = (source: string, path = ""): Infra => hclToInfra([{ path, root: parseBlocks(source) }]);

/** Attribute values as plain data, for display and comparison: references and expressions become their text. */
function plain(v: Value): unknown {
  if (v instanceof Ref) return v.path;
  if (v instanceof Expr) return v.text;
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

const attrsOf = (block: Block, skip: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(block.attrs).filter(([k]) => !skip.includes(k)).map(([k, v]) => [k, plain(v)]),
  );
  // Nested blocks count as attributes too; one that repeats (two `ingress` blocks) becomes a list.
  for (const child of block.blocks) {
    const key = [child.type, ...child.labels].join(".");
    const value = attrsOf(child, []);
    out[key] = key in out ? [out[key], value].flat() : value;
  }
  return out;
};

/** What one directory of `.tf` files declares, so references resolve across its files. */
interface Scope {
  resources: Map<string, string>; // `type.name` → node id
  locals: Map<string, Value>;
  variables: Map<string, Value>;
  data: Map<string, Value[]>;
}

const directory = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nested = (b: Block): Value[] => [...Object.values(b.attrs), ...b.blocks.flatMap(nested)];

export function hclToInfra(files: HclFile[]): Infra {
  const groups: Group[] = [];
  const nodes: InfraNode[] = [];
  const edges: Edge[] = [];
  const scopes = new Map<string, Scope>();
  const resources: { node: InfraNode; block: Block; address: string; dir: string; scope: Scope }[] = [];
  let title: string | undefined;

  for (const { path, root } of files) {
    const dir = directory(path);
    const scope: Scope = scopes.get(dir) ?? { resources: new Map(), locals: new Map(), variables: new Map(), data: new Map() };
    scopes.set(dir, scope);
    const at = (b: Block) => (path ? { sourceFile: path, lineStart: b.lineStart, lineEnd: b.lineEnd } : {});
    if (typeof root.attrs.title === "string") title ??= root.attrs.title;

    const walk = (block: Block, parent?: string) => {
      for (const child of block.blocks) {
        const a = child.attrs;
        const str = (v: Value | undefined) => (typeof v === "string" ? v : undefined);
        const num = (v: Value | undefined) => (typeof v === "number" ? v : undefined);
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
              props: (a.props && (plain(a.props) as Record<string, unknown>)) || attrsOf(child, ["label", "kind", "group", "state"]),
              ...at(child),
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
              label: name,
              kind: terraformKind(type),
              parent: str(a.group) ?? parent,
              props: { terraform: type, ...attrsOf(child, ["group", "tags"]) },
              ...at(child),
            };
            nodes.push(node);
            resources.push({ node, block: child, address: `${type}.${name}`, dir, scope });
            break;
          }
          // Not drawn, but references go through them to the resources behind.
          case "data":
            scope.data.set(`data.${child.labels.join(".")}`, nested(child));
            break;
          case "locals":
            for (const [k, v] of Object.entries(a)) scope.locals.set(k, v);
            break;
          case "variable":
            if (a.default !== undefined) scope.variables.set(child.labels[0], a.default);
            break;
          case "output":
            break;
          default:
            walk(child, parent); // module, provider and other wrappers are looked through
        }
      }
    };
    walk(root);
  }

  // The same `type.name` in two directories is two resources: their ids carry the directory.
  const count = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of resources)
    if (!seen.has(`${r.dir}|${r.address}`)) seen.add(`${r.dir}|${r.address}`), count.set(r.address, (count.get(r.address) ?? 0) + 1);
  for (const r of resources) {
    if (count.get(r.address)! > 1 && r.dir) r.node.id = `${r.dir}/${r.address}`;
    r.scope.resources.set(r.address, r.node.id);
  }

  // Terraform: a resource that refers to another one depends on it, so traffic goes that way.
  for (const { node, block, scope } of resources) {
    const a = block.attrs;
    const text = (v: Value | undefined): string | undefined => {
      if (typeof v === "string") return v;
      if (!(v instanceof Ref)) return undefined;
      const [root, name] = v.path.split(".");
      const target = root === "var" ? scope.variables.get(name) : root === "local" ? scope.locals.get(name) : undefined;
      return typeof target === "string" ? target : undefined;
    };
    node.label = text(a.name) ?? text(a.function_name) ?? text(a.identifier) ?? node.label;

    const refs = new Set<string>();
    const visited = new Set<string>(); // locals and data sources already followed, so a cycle ends
    const follow = (path: string) => {
      const parts = path.split(".");
      const symbol = parts[0] === "local" ? parts.slice(0, 2).join(".") : parts[0] === "data" ? parts.slice(0, 3).join(".") : undefined;
      if (!symbol) {
        const id = scope.resources.get(parts.slice(0, 2).join("."));
        if (id && id !== node.id) refs.add(id);
        return;
      }
      if (visited.has(symbol)) return;
      visited.add(symbol);
      if (parts[0] === "data") scope.data.get(symbol)?.forEach(collect);
      else if (scope.locals.has(parts[1])) collect(scope.locals.get(parts[1])!);
    };
    const collect = (v: Value) => {
      if (v instanceof Ref) follow(v.path);
      else if (v instanceof Expr) v.parts.forEach(collect);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
      else if (typeof v === "string" && v.includes("${")) for (const m of v.matchAll(/[A-Za-z_][\w-]*(?:\.[\w-]+)+/g)) follow(m[0]);
    };
    nested(block).forEach(collect);
    for (const to of refs) edges.push({ id: edgeId(node.id, to), from: node.id, to });
  }

  return normalize({ title, groups, nodes, edges });
}
