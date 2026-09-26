import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JarvisError } from "@jarvis/shared";

/** An image or file sent with a message (12 §17.6 conversation.send attachments[]). */
export interface Attachment { name: string; media_type: string; data_base64: string }
export interface SavedAttachment { name: string; media_type: string; path: string; bytes: number; kind: "image" | "file"; data_base64?: string }

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_ATTACHMENTS = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;         // the model's per-image limit
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** A safe single file name: no directories, no reserved characters or Windows device names. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  let s = base.normalize("NFKC").replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120);
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `file_${s || "attachment"}`;
  return s;
}

/**
 * Validates and saves attachments under `inboxDir/<messageId>/` (inside the artifacts root,
 * so tasks can read them). Images keep their bytes for the model; files are referenced by path.
 * Attachment content is data, never instructions (04 §10.8).
 */
export function saveAttachments(inboxDir: string, messageId: string, list: Attachment[]): SavedAttachment[] {
  if (list.length > MAX_ATTACHMENTS) throw new JarvisError("invalid_input", `at most ${MAX_ATTACHMENTS} attachments per message`);
  const dir = join(inboxDir, messageId);
  const used = new Set<string>();
  const out: SavedAttachment[] = [];
  const total = list.reduce((n, a) => n + (typeof a?.data_base64 === "string" ? Math.floor(a.data_base64.length * 3 / 4) : 0), 0);
  if (total > MAX_TOTAL_BYTES) throw new JarvisError("invalid_input", "attachments in one message must total under 32 MB");
  for (const a of list) {
    if (typeof a?.data_base64 !== "string" || typeof a.name !== "string" || typeof a.media_type !== "string") throw new JarvisError("invalid_input", "attachment needs name, media_type and data_base64");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(a.data_base64)) throw new JarvisError("invalid_input", `${a.name}: not base64`);
    const buf = Buffer.from(a.data_base64, "base64");
    const image = IMAGE_TYPES.has(a.media_type);
    if (image && buf.length > MAX_IMAGE_BYTES) throw new JarvisError("invalid_input", `${a.name}: images must be under 5 MB`);
    if (buf.length > MAX_FILE_BYTES) throw new JarvisError("invalid_input", `${a.name}: files must be under 25 MB`);
    if (image && !sniffImage(buf, a.media_type)) throw new JarvisError("invalid_input", `${a.name}: content is not a valid ${a.media_type} image`);
    let name = safeName(a.name);
    for (let i = 2; used.has(name.toLowerCase()); i++) name = name.replace(/(\.[^.]*)?$/, m => `_${i}${m}`);
    used.add(name.toLowerCase());
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, buf, { mode: 0o600, flag: "wx" });
    out.push({ name, media_type: a.media_type, path, bytes: buf.length, kind: image ? "image" : "file", ...(image ? { data_base64: a.data_base64 } : {}) });
  }
  return out;
}

function sniffImage(b: Buffer, type: string): boolean {
  if (type === "image/png") return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/gif") return b.subarray(0, 4).toString("latin1") === "GIF8";
  if (type === "image/webp") return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}
