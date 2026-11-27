import { isMap, isNode, LineCounter, parseAllDocuments } from "yaml";

// Manifests are loosely typed; callers allow for missing fields.
export type Obj = Record<string, any>;

export interface YamlDoc {
  value: Obj | null;
  /** First and last line of the entry at `path`, or of the whole document for `[]`. */
  lines(path: string[]): { lineStart?: number; lineEnd?: number };
}

/** Every document of a YAML (or JSON) file, with line numbers. */
export function readYaml(text: string): YamlDoc[] {
  const counter = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: counter, merge: true });
  const line = (offset: number) => counter.linePos(offset).line;
  return (Array.isArray(docs) ? docs : []).map((doc) => {
    if (doc.errors.length) throw new Error(doc.errors[0].message.split("\n")[0]);
    return {
      value: doc.toJS({ maxAliasCount: 100 }) as Obj | null,
      lines(path) {
        let node: unknown = doc.contents;
        let start = isNode(node) ? node.range?.[0] : undefined;
        for (const key of path) {
          const pair = isMap(node) ? node.items.find((p) => String(p.key) === key) : undefined;
          if (!pair) return {};
          start = isNode(pair.key) ? pair.key.range?.[0] : start;
          node = pair.value;
        }
        const end = isNode(node) ? node.range?.[1] : undefined;
        if (start === undefined || end === undefined) return {};
        // The range may run over the line break that ends the entry.
        return { lineStart: line(start), lineEnd: line(start + text.slice(start, end).trimEnd().length - 1) };
      },
    };
  });
}
