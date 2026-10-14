/** The bytes a Chat thumbnail may carry, whichever agent recorded them. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ImageBytes = { mediaType: string; bytes: Uint8Array<ArrayBuffer> };

/** The raster type the bytes themselves declare; a recorded MIME type is never trusted. */
export function imageType(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 12));
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(head.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/** Bytes within the cap whose signature is a supported raster, else null. */
export function rasterImage(bytes: Uint8Array): ImageBytes | null {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const mediaType = imageType(bytes);
  return mediaType === null ? null : { mediaType, bytes: new Uint8Array(bytes) };
}

/** Recorded base64, checked for size before it is decoded. */
export function base64Image(data: string): ImageBytes | null {
  if (data.length === 0 || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) return null;
  return rasterImage(Buffer.from(data, "base64"));
}
