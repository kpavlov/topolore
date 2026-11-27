/** Reading what the user picks or drops, in the browser. Nothing is uploaded. */
import { wanted, type SourceFile } from "./index.ts";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 2000;
const SKIP_DIRECTORY = /^(\.git|node_modules|\.terraform)$/;

interface Picked {
  file: File;
  path: string;
}

async function read(picked: Picked[]): Promise<SourceFile[]> {
  // A single file was chosen on purpose, whatever it is called; from a folder, only likely ones are read.
  const chosen = picked.length === 1 && !picked[0].path.includes("/") ? picked : picked.filter((p) => wanted(p.path) && p.file.size <= MAX_BYTES);
  if (!chosen.length) throw new Error("No .tf, .json, .yaml or .yml files were found.");
  if (chosen.length > MAX_FILES) throw new Error(`That is ${chosen.length} files; choose a folder with at most ${MAX_FILES}.`);
  if (chosen[0].file.size > MAX_BYTES) throw new Error(`${chosen[0].path} is over 20 MB.`);
  const files = await Promise.all(chosen.map(async ({ file, path }) => ({ path, text: await file.text() })));
  return files.filter((f) => !f.text.includes("\u0000")); // binary
}

/** From a file input, with or without `webkitdirectory`. */
export const readPicked = (list: FileList | File[]) =>
  read(Array.from(list, (file) => ({ file, path: file.webkitRelativePath || file.name })));

async function walk(entry: FileSystemEntry, prefix: string, out: Picked[]): Promise<void> {
  if (out.length > MAX_FILES) return;
  const path = prefix + entry.name;
  if (entry.isFile) {
    if (prefix && !wanted(path)) return;
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, path });
  } else if (!SKIP_DIRECTORY.test(entry.name)) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // One call returns at most a batch; an empty one marks the end.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${path}/`, out);
    }
  }
}

/** From a drop, folders included. Call it inside the drop handler: the items are gone after it returns. */
export function readDropped(data: DataTransfer): Promise<SourceFile[]> {
  const entries = Array.from(data.items, (item) => item.webkitGetAsEntry?.()).filter((e) => !!e);
  if (!entries.length) return readPicked(data.files);
  return (async () => {
    const out: Picked[] = [];
    for (const entry of entries) await walk(entry, "", out);
    return read(out);
  })();
}
