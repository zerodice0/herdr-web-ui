import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ConversationPart } from "../shared/protocol.ts";
import { MAX_IMAGE_BYTES, base64Image, rasterImage, type ImageBytes } from "./image-bytes.ts";

type ImagePart = Extract<ConversationPart, { kind: "image" }>;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" ? value as RecordValue : {};
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/;
export const CODEX_IMAGE_REF = /^codex-[a-f0-9]{64}$/;

/** Native user attachments may carry local paths as well as recorded data URLs. */
function userImageValues(entry: RecordValue): string[] {
  const payload = record(entry.payload);
  if (entry.type === "event_msg" && payload.type === "user_message" && (!payload.kind || payload.kind === "plain")) {
    return [payload.local_images, payload.images].flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  }
  if (entry.type !== "response_item" || payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) return [];
  return payload.content.flatMap((value) => {
    const part = record(value);
    const path = part.type === "input_image" ? part.image_url : part.type === "local_image" ? part.path : null;
    return typeof path === "string" ? [path] : [];
  });
}

/** Tool records supply bytes only: paths, remote URLs and Extension events are not attachments. */
function toolImageValues(entry: RecordValue): string[] {
  const payload = record(entry.payload);
  if (entry.type !== "response_item" || (payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output")) return [];
  const output = Array.isArray(payload.output) ? payload.output : record(payload.output).content;
  if (!Array.isArray(output)) return [];
  return output.flatMap((value) => {
    const part = record(value);
    return part.type === "input_image" && typeof part.image_url === "string" && part.image_url.startsWith("data:") ? [part.image_url] : [];
  });
}

function imagePart(value: string): ImagePart | null {
  if (!value || value.includes("\0") || value.length > MAX_IMAGE_BYTES * 4 / 3 + 128) return null;
  const inline = DATA_IMAGE.exec(value);
  if (!inline && /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  const mediaType = inline?.[1] ?? TYPES[extname(value).toLowerCase()];
  if (!mediaType) return null;
  return { kind: "image", media_type: mediaType, ref: `codex-${createHash("sha256").update(value).digest("hex")}` };
}

/** Hash references keep base64 blobs and filesystem paths out of conversation responses. */
export function codexImageParts(entry: RecordValue): ImagePart[] {
  return [...new Set(userImageValues(entry))].flatMap((value) => {
    const part = imagePart(value);
    return part === null ? [] : [part];
  });
}

/** Only validated inline raster bytes produce tool thumbnails; never serialize their data URL. */
export function codexToolImageParts(entry: RecordValue): NonNullable<Extract<ConversationPart, { kind: "tool" }>["images"]> {
  return [...new Set(toolImageValues(entry))].flatMap((value) => {
    if (value.length > MAX_IMAGE_BYTES * 4 / 3 + 128) return [];
    const inline = DATA_IMAGE.exec(value);
    const image = inline === null ? null : base64Image(inline[2]!);
    return image === null ? [] : [{ media_type: image.mediaType, ref: `codex-${createHash("sha256").update(value).digest("hex")}` }];
  });
}

async function imageBytes(value: string, cwd: string): Promise<ImageBytes | null> {
  const inline = DATA_IMAGE.exec(value);
  if (inline) return base64Image(inline[2]!);
  const file = await open(resolve(cwd, value), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return rasterImage(bytes.subarray(0, bytesRead));
  } finally { await file.close(); }
}

type ImageLine = { offset: number; length: number };
const indexedImages = new Map<string, Map<string, ImageLine>>();
const MAX_INDEXED_ROLLOUTS = 32;
const MAX_INDEXED_IMAGES = 512;

export function forgetCodexImageState(): void {
  indexedImages.clear();
}

function rememberImage(path: string, ref: string, line: ImageLine): void {
  const index = indexedImages.get(path) ?? new Map<string, ImageLine>();
  indexedImages.delete(path);
  indexedImages.set(path, index);
  if (indexedImages.size > MAX_INDEXED_ROLLOUTS) indexedImages.delete(indexedImages.keys().next().value!);
  // Keep the first copy: it remains visible when a later duplicate is backtracked.
  if (!index.has(ref)) index.set(ref, line);
  if (index.size > MAX_INDEXED_IMAGES) index.delete(index.keys().next().value!);
}

/** Byte offsets include the actual newline bytes, even for CRLF, UTF-8 and final tails. */
async function* transcriptLines(segment: { path: string; end: number }): AsyncGenerator<ImageLine & { text: string }> {
  const stream = createReadStream(segment.path, { end: segment.end - 1 });
  let offset = 0;
  let length = 0;
  let parts: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline === -1 ? bytes.length : newline + 1;
        parts.push(bytes.subarray(start, end));
        length += end - start;
        start = end;
        if (newline === -1) break;
        const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
        yield { offset, length, text: line.toString("utf8") };
        offset += length;
        length = 0;
        parts = [];
      }
    }
    if (length > 0) {
      const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
      yield { offset, length, text: line.toString("utf8") };
    }
  } finally { stream.destroy(); }
}

/** A cache hit is still checked against the current file and the exact recorded value. */
async function indexedImage(path: string, line: ImageLine, ref: string, cwd: string): Promise<{ image: ImageBytes | null } | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < line.offset + line.length) return null;
    const bytes = Buffer.alloc(line.length);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, line.offset);
    if (bytesRead !== bytes.length) return null;
    const entry = record(JSON.parse(bytes.toString("utf8")));
    for (const value of [...userImageValues(entry), ...toolImageValues(entry)]) {
      if (imagePart(value)?.ref === ref) return { image: await imageBytes(value, cwd) };
    }
    return null;
  } finally { await file.close(); }
}

/** Scan/index only bound history, including inherited rollouts but excluding backtracked bytes. */
export async function codexTranscriptImage(segments: { path: string; end: number }[], ref: string, cwd: string): Promise<ImageBytes | null> {
  if (!CODEX_IMAGE_REF.test(ref)) return null;
  for (const segment of segments) {
    if (segment.end === 0) continue;
    const indexed = indexedImages.get(segment.path)?.get(ref);
    if (indexed && indexed.offset + indexed.length <= segment.end) {
      try {
        const found = await indexedImage(segment.path, indexed, ref, cwd);
        if (found !== null) return found.image;
      } catch { /* A changed or unreadable line is rechecked by the bounded scan. */ }
      indexedImages.get(segment.path)?.delete(ref);
    }
    try {
      for await (const line of transcriptLines(segment)) {
        // Most rollout records cannot name an attachment, and need not be parsed at all.
        if (!line.text.includes('"user_message"') && !line.text.includes('"input_image"') && !line.text.includes('"local_image"')) continue;
        let entry: RecordValue;
        try { entry = record(JSON.parse(line.text)); } catch { continue; }
        let match: string | undefined;
        for (const value of [...userImageValues(entry), ...toolImageValues(entry)]) {
          const part = imagePart(value);
          if (part === null) continue;
          rememberImage(segment.path, part.ref, { offset: line.offset, length: line.length });
          if (part.ref === ref) match ??= value;
        }
        if (match !== undefined) return await imageBytes(match, cwd);
      }
    } catch { return null; }
  }
  return null;
}
