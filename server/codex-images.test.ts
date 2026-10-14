import { afterEach, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexImageParts, codexToolImageParts, codexTranscriptImage, forgetCodexImageState } from "./codex-images.ts";
import { codexHistorySegments, parseCodexTranscript } from "./codex.ts";
import { MAX_IMAGE_BYTES } from "./image-bytes.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", "base64");
const data = `data:image/png;base64,${png.toString("base64")}`;
const event = (message: string, local_images: string[]) => ({ type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload: { type: "user_message", message, local_images } });
const response = (text: string, image: string) => ({ type: "response_item", timestamp: "2026-09-27T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: image }] } });
const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");
const call = (name: string, call_id = "call", type = "custom_tool_call") => ({ type: "response_item", payload: { type, name, call_id, input: "{}", arguments: "{}" } });
const output = (images: string[], call_id = "call", type = "custom_tool_call_output") => ({ type: "response_item", payload: { type, call_id, output: [
  { type: "input_text", text: "image result" },
  ...images.map((image_url) => ({ type: "input_image", detail: "high", image_url })),
] } });

afterEach(() => forgetCodexImageState());

it("preserves image-only Codex turns and pairs event/response copies in either order", () => {
  for (const text of ["", "What is this?"]) {
    for (const records of [[event(text, ["/tmp/shot.png"]), response(text, data)], [response(text, data), event(text, ["/tmp/shot.png"])]]) {
      const turns = parseCodexTranscript(jsonl(...records));
      expect(turns).toHaveLength(1);
      expect(turns[0]!.parts.filter((part) => part.kind === "image")).toEqual(codexImageParts(event(text, ["/tmp/shot.png"])));
      expect(JSON.stringify(turns)).not.toContain(png.toString("base64"));
      expect(JSON.stringify(turns)).not.toContain("/tmp/shot.png");
    }
  }
  expect(parseCodexTranscript(jsonl(event("", ["one.png"]), event("", ["two.png"])))).toHaveLength(2);
  expect(parseCodexTranscript(jsonl(response("", data)))[0]?.parts).toEqual(codexImageParts(response("", data)));
});

it("does not turn remote URLs, unsupported data, or assistant content into user images", () => {
  expect(codexImageParts(event("", ["https://host/shot.png", "file:///tmp/a.png", "data:image/svg+xml;base64,PHN2Zz4=", "bad\0.png"]))).toEqual([]);
  expect(codexImageParts({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "input_image", image_url: data }] } })).toEqual([]);
  expect(codexImageParts(event("", ["a.png", "a.png"]))).toHaveLength(1);
});

it("fetches only referenced raster images within the retained history and bounds local reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-images-"));
  try {
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "shot.png"), png);
    const path = join(root, "rollout.jsonl");
    const record = event("", ["assets/shot.png"]);
    const first = `${jsonl(record)}\n`;
    writeFileSync(path, first + jsonl(response("", data)));
    const ref = codexImageParts(record)[0]!.ref;
    const inlineRef = codexImageParts(response("", data))[0]!.ref;
    const segment = { path, end: Buffer.byteLength(first) };
    const found = await codexTranscriptImage([segment], ref, root);
    expect(found?.mediaType).toBe("image/png");
    expect(Buffer.from(found!.bytes)).toEqual(png);
    expect(await codexTranscriptImage([segment], inlineRef, root)).toBeNull();
    expect(await codexTranscriptImage([{ path, end: Buffer.byteLength(first + jsonl(response("", data))) }], inlineRef, root)).toEqual(found);
    expect(await codexTranscriptImage([segment], "../../etc/passwd", root)).toBeNull();
    expect(await codexTranscriptImage([segment], `codex-${"0".repeat(64)}`, root)).toBeNull();
    writeFileSync(join(root, "assets", "shot.png"), "<html>not an image</html>");
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
    writeFileSync(join(root, "assets", "shot.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
    rmSync(join(root, "assets", "shot.png"));
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("attaches deduplicated tool-output images by call ID without filtering tool names or exposing base64", () => {
  const ref = `codex-${createHash("sha256").update(data).digest("hex")}`;
  for (const name of ["view_image", "image_generation", "exec_command", "write_stdin", "apply_patch", "another_tool"]) {
    for (const type of ["custom_tool_call", "function_call"]) {
      const result = output([data, data], "picture", `${type}_output`);
      const turns = parseCodexTranscript(jsonl(call("other", "text", type), call(name, "picture", type), result, output([], "text", `${type}_output`)));
      const tools = turns[0]!.parts.filter((part) => part.kind === "tool");
      expect(tools).toHaveLength(2);
      expect(tools[0]!.images).toBeUndefined();
      expect(tools[1]!.images).toEqual([{ media_type: "image/png", ref }]);
      expect(tools[1]!.output).toBe("image result");
      expect(tools[1]!.images).toEqual(codexToolImageParts(result));
      expect(JSON.stringify(turns)).not.toContain(png.toString("base64"));
      expect(JSON.stringify(turns)).not.toContain("data:image/");
    }
  }
  expect(parseCodexTranscript(jsonl(output([data], "missing")))).toEqual([]);
});

it("resolves tool data URLs and sniffs bytes instead of trusting the recorded MIME", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-tool-images-"));
  try {
    const path = join(root, "rollout.jsonl");
    for (const mediaType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      const value = data.replace("image/png", mediaType);
      const result = output([value]);
      const images = codexToolImageParts(result);
      expect(images).toEqual([{ media_type: "image/png", ref: `codex-${createHash("sha256").update(value).digest("hex")}` }]);
      const text = jsonl(call("view_image"), result);
      writeFileSync(path, text);
      const found = await codexTranscriptImage([{ path, end: Buffer.byteLength(text) }], images[0]!.ref, root);
      expect(found?.mediaType).toBe("image/png");
      expect(Buffer.from(found!.bytes)).toEqual(png);
    }
    const wrapped = { type: "response_item", payload: { type: "function_call_output", call_id: "call", output: { content: [{ type: "input_image", image_url: data }] } } };
    expect(parseCodexTranscript(jsonl(call("view_image", "call", "function_call"), wrapped))[0]!.parts[0]).toMatchObject({ images: codexToolImageParts(wrapped) });
    const text = jsonl(wrapped);
    writeFileSync(path, text);
    expect(await codexTranscriptImage([{ path, end: Buffer.byteLength(text) }], codexToolImageParts(wrapped)[0]!.ref, root)).toEqual({ mediaType: "image/png", bytes: new Uint8Array(png) });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("ignores tool image paths, remote URLs, local_image copies and Markdown paths even when files exist", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-tool-paths-"));
  try {
    writeFileSync(join(root, "shot.png"), png);
    const values = ["shot.png", join(root, "shot.png"), "file:///tmp/shot.png", "https://host/shot.png", "data:image/svg+xml;base64,PHN2Zz4="];
    const plain = output(values);
    const result = { ...plain, payload: { ...plain.payload, output: [
      ...plain.payload.output, { type: "local_image", path: "shot.png" }, { type: "input_text", text: "![picture](shot.png)" },
    ] } };
    const turns = parseCodexTranscript(jsonl(call("view_image"), result));
    expect(codexToolImageParts(result)).toEqual([]);
    expect(turns[0]!.parts[0]).toMatchObject({ kind: "tool", output: "image result\n![picture](shot.png)" });
    expect(turns[0]!.parts[0]).not.toHaveProperty("images");
    const path = join(root, "rollout.jsonl");
    const text = jsonl(result);
    writeFileSync(path, text);
    for (const value of values) {
      expect(await codexTranscriptImage([{ path, end: Buffer.byteLength(text) }], `codex-${createHash("sha256").update(value).digest("hex")}`, root)).toBeNull();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("ignores duplicate image-generation Extension events, including base64 and savedPath", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-extension-images-"));
  try {
    const extension = { type: "event_msg", payload: { type: "item_completed", item: {
      type: "Extension", id: "generated", base64: png.toString("base64"), savedPath: "generated.png",
      output: [{ type: "input_image", image_url: data }],
    } } };
    writeFileSync(join(root, "generated.png"), png);
    expect(codexImageParts(extension)).toEqual([]);
    expect(codexToolImageParts(extension)).toEqual([]);
    expect(parseCodexTranscript(jsonl(extension))).toEqual([]);
    const path = join(root, "rollout.jsonl");
    const text = jsonl(extension);
    writeFileSync(path, text);
    for (const value of [data, "generated.png"]) {
      expect(await codexTranscriptImage([{ path, end: Buffer.byteLength(text) }], `codex-${createHash("sha256").update(value).digest("hex")}`, root)).toBeNull();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("rejects oversized and bad-signature tool data before emitting refs or serving bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-invalid-tool-images-"));
  try {
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    png.copy(oversized);
    const values = [`data:image/png;base64,${oversized.toString("base64")}`, `data:image/png;base64,${Buffer.from("not a raster image").toString("base64")}`, "data:image/png;base64,%%%%"];
    const path = join(root, "rollout.jsonl");
    for (const value of values) {
      const result = output([value]);
      expect(codexToolImageParts(result)).toEqual([]);
      expect(parseCodexTranscript(jsonl(call("view_image"), result))[0]!.parts[0]).not.toHaveProperty("images");
      const text = jsonl(result);
      writeFileSync(path, text);
      expect(await codexTranscriptImage([{ path, end: Buffer.byteLength(text) }], `codex-${createHash("sha256").update(value).digest("hex")}`, root)).toBeNull();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("indexes all passed image lines and reuses exact byte offsets without exposing backtracked bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-indexed-images-"));
  try {
    const path = join(root, "rollout.jsonl");
    const filler = `${jsonl({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "🦉".repeat(20_000) }] } })}\r\n`;
    const first = output([data]);
    const last = output([data.replace("image/png", "image/jpeg")]);
    const text = `${filler}${jsonl(first)}\r\n${jsonl(last)}`;
    writeFileSync(path, text);
    const segment = { path, end: Buffer.byteLength(text) };
    const firstRef = codexToolImageParts(first)[0]!.ref;
    const lastRef = codexToolImageParts(last)[0]!.ref;
    const found = await codexTranscriptImage([segment], lastRef, root);
    expect(found?.mediaType).toBe("image/png");
    const streams = spyOn(fs, "createReadStream");
    try {
      expect(await codexTranscriptImage([segment], firstRef, root)).toEqual(found);
      expect(await codexTranscriptImage([segment], lastRef, root)).toEqual(found);
      expect(streams).not.toHaveBeenCalled();
      expect(await codexTranscriptImage([{ path, end: Buffer.byteLength(filler) }], firstRef, root)).toBeNull();
    } finally { streams.mockRestore(); }
    // Rewriting or truncating the indexed record never serves the previously recorded bytes.
    const changed = `${filler}${jsonl(output([data.replace("image/png", "image/gif")]))}\r\n${jsonl(last)}`;
    writeFileSync(path, changed);
    expect(await codexTranscriptImage([{ path, end: Buffer.byteLength(changed) }], firstRef, root)).toBeNull();
    writeFileSync(path, filler);
    expect(await codexTranscriptImage([segment], lastRef, root)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("does not fetch indexed images from discarded or unrelated rollout segments", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-backtracked-images-"));
  try {
    const home = join(root, "codex");
    const directory = join(home, "sessions", "2026", "10", "14");
    mkdirSync(directory, { recursive: true });
    const thread = "01a13777-ade2-7b30-86aa-d7c8ee487ff1";
    const original = join(directory, `rollout-2026-10-14T07-00-00-${thread}.jsonl`);
    const current = join(directory, `rollout-2026-10-14T08-00-00-${thread}_01a13777-ade2-7b30-86aa-d7c8ee487ff2.jsonl`);
    const unrelated = join(directory, "rollout-2026-10-14T09-00-00-01a13777-ade2-7b30-86aa-d7c8ee487ff3.jsonl");
    const header = { type: "session_meta", payload: { source: "cli", thread_source: "user" } };
    const kept = output([data]);
    const discarded = output([data.replace("image/png", "image/jpeg")], "discarded");
    const outside = output([data.replace("image/png", "image/gif")]);
    const prefix = `${jsonl(header, call("view_image"), kept)}\n`;
    const originalText = prefix + jsonl(call("view_image", "discarded"), discarded);
    writeFileSync(original, originalText);
    writeFileSync(unrelated, jsonl(header, outside));
    writeFileSync(current, `${jsonl({ type: "session_meta", payload: { source: "cli", thread_source: "user", history_base: {
      thread_id: thread, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(prefix),
    } } })}\n`);
    const keptRef = codexToolImageParts(kept)[0]!.ref;
    const discardedRef = codexToolImageParts(discarded)[0]!.ref;
    const outsideRef = codexToolImageParts(outside)[0]!.ref;
    // Populate the index from histories which were previously visible.
    expect(await codexTranscriptImage([{ path: original, end: Buffer.byteLength(originalText) }], discardedRef, root)).not.toBeNull();
    expect(await codexTranscriptImage([{ path: unrelated, end: Buffer.byteLength(jsonl(header, outside)) }], outsideRef, root)).not.toBeNull();
    const retained = codexHistorySegments(current, home);
    expect(retained).toEqual([{ path: original, end: Buffer.byteLength(prefix) }, { path: current, end: fs.statSync(current).size }]);
    expect(await codexTranscriptImage(retained, keptRef, root)).not.toBeNull();
    expect(await codexTranscriptImage(retained, discardedRef, root)).toBeNull();
    expect(await codexTranscriptImage(retained, outsideRef, root)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
