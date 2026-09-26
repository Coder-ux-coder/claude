import { JarvisError } from "@jarvis/shared";

/** RFC 6902 subset (add, replace, remove, test) used for contract revisions (02 §7.9 step 2). */
export type PatchOp =
  | { op: "add" | "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "test"; path: string; value: unknown };

function parsePath(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new JarvisError("invalid_input", `bad JSON pointer: ${path}`);
  return path.slice(1).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function applyPatch<T>(doc: T, ops: PatchOp[]): T {
  const out = structuredClone(doc) as unknown;
  for (const op of ops) {
    const parts = parsePath(op.path);
    if (parts.length === 0) throw new JarvisError("invalid_input", "cannot patch the document root");
    let parent: any = out;
    for (const p of parts.slice(0, -1)) {
      if (parent === null || typeof parent !== "object" || !(p in parent)) throw new JarvisError("invalid_input", `path not found: ${op.path}`);
      parent = parent[p];
    }
    const key = parts[parts.length - 1]!;
    const isArr = Array.isArray(parent);
    const idx = isArr ? (key === "-" ? parent.length : Number(key)) : -1;
    if (isArr && (!Number.isInteger(idx) || idx < 0 || idx > parent.length)) throw new JarvisError("invalid_input", `bad array index in ${op.path}`);
    switch (op.op) {
      case "test":
        if (JSON.stringify(isArr ? parent[idx] : parent[key]) !== JSON.stringify(op.value)) throw new JarvisError("conflict", `test failed at ${op.path}`);
        break;
      case "add":
        if (isArr) parent.splice(idx, 0, structuredClone(op.value)); else parent[key] = structuredClone(op.value);
        break;
      case "replace":
        if (isArr ? idx >= parent.length : !(key in parent)) throw new JarvisError("invalid_input", `replace target missing: ${op.path}`);
        if (isArr) parent[idx] = structuredClone(op.value); else parent[key] = structuredClone(op.value);
        break;
      case "remove":
        if (isArr ? idx >= parent.length : !(key in parent)) throw new JarvisError("invalid_input", `remove target missing: ${op.path}`);
        if (isArr) parent.splice(idx, 1); else delete parent[key];
        break;
    }
  }
  return out as T;
}
