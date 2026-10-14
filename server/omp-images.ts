/** Recorded pi-family images: omp/omo/gjc use linear history and content-addressed blobs. */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { base64Image, MAX_IMAGE_BYTES, rasterImage, type ImageBytes } from "./image-bytes.ts";
import { activeHistoryText, BLOB_IMAGE_REF, PI_IMAGE_REF, PI_USER_IMAGE_REF, piImageBlock, piMessage, piUserImages, record } from "./transcript-records.ts";

/** Linear readers must not project omp's records as pi's entry tree. */
export function ompTranscriptImage(path: string, ref: string): ImageBytes | null {
  if (!BLOB_IMAGE_REF.test(ref) && !PI_IMAGE_REF.test(ref) && !PI_USER_IMAGE_REF.test(ref)) return null;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  return piImageInHistory(path, ref, activeHistoryText(text, "omp-transcript"));
}

/** The caller supplies only visible history: linear after /clear, or pi's active branch after /clear. */
export function piImageInHistory(path: string, ref: string, text: string): ImageBytes | null {
  const blob = BLOB_IMAGE_REF.exec(ref);
  if (blob !== null) {
    const digest = blob[1]!;
    if (!text.includes(`blob:sha256:${digest}`)) return null;
    // Session children, including subagents, can be arbitrarily deep. The nearest
    // sessions ancestor identifies this transcript's own agent/profile store.
    let directory: string;
    try { directory = dirname(realpathSync(path)); } catch { return null; }
    while (basename(directory) !== "sessions") {
      const parent = dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
    let blobs: string;
    try { blobs = realpathSync(join(dirname(directory), "blobs")); } catch { return null; }
    for (const extension of ["", ".png", ".jpg", ".jpeg", ".gif", ".webp"]) {
      try {
        const candidate = realpathSync(resolve(blobs, `${digest}${extension}`));
        const inside = relative(blobs, candidate);
        if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
        const stat = statSync(candidate);
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) continue;
        const image = rasterImage(readFileSync(candidate));
        if (image !== null) return image;
      } catch { /* Missing extensionless blobs may have an image-extension sibling. */ }
    }
    return null;
  }
  const user = PI_USER_IMAGE_REF.exec(ref);
  const tool = PI_IMAGE_REF.exec(ref);
  const match = user ?? tool;
  if (match === null) return null;
  const id = match[1]!, index = Number(match[2]);
  for (const line of text.split("\n")) {
    if (!line.includes(id)) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = piMessage(entry);
    if (message === null) continue;
    const image = user !== null
      ? record(entry).id === id ? piUserImages(entry, message)[index] ?? null : null
      : piImageBlock(message, id, index);
    if (image !== null && !image.data.startsWith("blob:")) return base64Image(image.data);
  }
  return null;
}
