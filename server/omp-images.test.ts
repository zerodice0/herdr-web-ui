import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { forgetTranscriptState, piTranscriptImage, transcriptPage } from "./conversation.ts";
import { MAX_IMAGE_BYTES } from "./image-bytes.ts";
import { ompTranscriptImage } from "./omp-images.ts";
import { parseOmpTranscript } from "./transcript-records.ts";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG = Buffer.from([255, 216, 255, 224]);
const lines = (records: unknown[]) => records.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const imageBlock = (data: string, mimeType = "image/png") => ({ type: "image", mimeType, data });
const user = (id: string, content: unknown, parentId: string | null = null) => ({ type: "message", id, parentId, message: { role: "user", content } });
const call = (id: string) => ({ type: "message", id: `a-${id}`, parentId: "user", message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }] } });
const result = (id: string, content: unknown[], details?: unknown) => ({ type: "message", id: `r-${id}`, parentId: `a-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "read", content, details } });
const sources = ["omp-transcript", "omo-transcript", "gjc-transcript", "pi-transcript"] as const;

let root: string;
let blobs: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-omp-images-"));
  blobs = join(root, "agent", "blobs");
  mkdirSync(blobs, { recursive: true });
});
afterEach(() => {
  forgetTranscriptState();
  rmSync(root, { recursive: true, force: true });
});
function transcript(records: unknown[], name = "session", nested = false): string {
  const path = join(root, "agent", "sessions", "work", ...(nested ? ["parent", "children"] : []), `${name}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines(records));
  return path;
}
function blob(bytes = PNG, extension = ""): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(blobs, `${digest}${extension}`), bytes);
  return digest;
}

describe("pi-family recorded user images", () => {
  it("keeps a blob before text and keeps an image-only prompt without carrying image bytes", () => {
    const digest = blob();
    const data = `blob:sha256:${digest}`;
    const path = transcript([user("one", [{ type: "text", text: "what is this?" }, imageBlock(data)]), user("two", [imageBlock(data)])]);
    const turns = transcriptPage("omp-transcript", path).turns;
    expect(turns.map((turn) => turn.parts)).toEqual([
      [{ kind: "image", media_type: "image/png", ref: `blob:${digest}` }, { kind: "text", text: "what is this?" }],
      [{ kind: "image", media_type: "image/png", ref: `blob:${digest}` }],
    ]);
    expect(JSON.stringify(turns)).not.toContain(data);
    expect(Buffer.from(ompTranscriptImage(path, `blob:${digest}`)!.bytes)).toEqual(PNG);
  });

  for (const source of sources) {
    it(`fetches a stable inline user ref for ${source}`, () => {
      const data = PNG.toString("base64");
      const path = transcript([user("stable-id", [imageBlock(data)])], source);
      const turns = transcriptPage(source, path).turns;
      expect(turns[0]?.parts).toEqual([{ kind: "image", media_type: "image/png", ref: "pi-user:stable-id:0" }]);
      expect(JSON.stringify(turns)).not.toContain(data);
      const image = source === "pi-transcript" ? piTranscriptImage(path, "pi-user:stable-id:0") : ompTranscriptImage(path, "pi-user:stable-id:0");
      expect(Buffer.from(image!.bytes)).toEqual(PNG);
    });
  }

  it("preserves skill-invocation unwrapping beside an image", () => {
    const prompt = '<skill name="review" location="/synthetic/review/SKILL.md">\nprivate skill instructions\n</skill>\n\nreview the screenshot';
    const turns = parseOmpTranscript(lines([user("user", [imageBlock(PNG.toString("base64")), { type: "text", text: prompt }])]));
    expect(turns[0]?.parts).toEqual([
      { kind: "image", media_type: "image/png", ref: "pi-user:user:0" },
      { kind: "text", text: "review the screenshot" },
      { kind: "skill", skill: { name: "review", path: "/synthetic/review/SKILL.md", evidence: "instructions", status: "loaded" } },
    ]);
    expect(JSON.stringify(turns)).not.toContain("private skill instructions");
  });

  it("omits unsupported, path-only, hidden and unaddressable inline carriers", () => {
    const turns = parseOmpTranscript(lines([
      user("user", [{ type: "image", blob: "path.png" }]),
      user("bad/id", [imageBlock(PNG.toString("base64"))]),
      { type: "message", message: { role: "user", content: [imageBlock(PNG.toString("base64"))] } },
      user("unsupported", [imageBlock("PHN2Zz4=", "image/svg+xml")]),
      user("path", [imageBlock("/synthetic/shot.png")]),
      { ...user("hidden", [imageBlock(PNG.toString("base64"))]), display: false },
      { ...user("hidden-message", [imageBlock(PNG.toString("base64"))]), message: { role: "user", display: false, content: [imageBlock(PNG.toString("base64"))] } },
      { type: "custom_message", display: false, content: "image attachment notice" },
    ]));
    expect(turns).toEqual([]);
  });

  it("counts supported images consistently and omits ordinals a fetcher rejects", () => {
    const content = [imageBlock("PHN2Zz4=", "image/svg+xml"), imageBlock(PNG.toString("base64")), imageBlock(JPEG.toString("base64"), "image/jpeg")];
    const path = transcript([user("user", content)]);
    expect(transcriptPage("omp-transcript", path).turns[0]?.parts.map((part) => part.kind === "image" ? part.ref : null)).toEqual(["pi-user:user:0", "pi-user:user:1"]);
    expect(ompTranscriptImage(path, "pi-user:user:1")?.mediaType).toBe("image/jpeg");
    const many = parseOmpTranscript(lines([user("many", Array.from({ length: 1001 }, () => imageBlock(PNG.toString("base64"))))]));
    expect(many[0]?.parts).toHaveLength(1000);
    expect(many[0]?.parts.at(-1)).toMatchObject({ ref: "pi-user:many:999" });
  });
});

describe("omp-family tool images", () => {
  for (const source of sources.slice(0, 3)) {
    it(`returns user, tool and generated blobs for ${source}`, () => {
      const digest = blob();
      const data = `blob:sha256:${digest}`;
      const path = transcript([
        user("user", [imageBlock(data)]), call("read|one"),
        result("read|one", [imageBlock(data)], { xdev: { inner: { images: [{ data, mimeType: "image/png" }] } } }),
      ], source);
      const turns = transcriptPage(source, path).turns;
      expect(turns[0]?.parts).toEqual([{ kind: "image", media_type: "image/png", ref: `blob:${digest}` }]);
      const tool = turns[1]?.parts[0];
      expect(tool?.kind).toBe("tool");
      expect(tool?.kind === "tool" ? tool.images : undefined).toEqual([
        { media_type: "image/png", ref: `blob:${digest}` }, { media_type: "image/png", ref: `blob:${digest}` },
      ]);
      expect(Buffer.from(ompTranscriptImage(path, `blob:${digest}`)!.bytes)).toEqual(PNG);
      expect(JSON.stringify(turns)).not.toContain(data);
    });
  }

  it("reads inline results in linear history even when their parent ids do not form pi's active branch", () => {
    const path = transcript([
      user("user", "read it"), call("read|one"), result("read|one", [imageBlock(PNG.toString("base64"))]),
      user("later", "another prompt", null),
    ]);
    const tool = transcriptPage("omp-transcript", path).turns[1]?.parts[0];
    expect(tool?.kind).toBe("tool");
    expect(tool?.kind === "tool" ? tool.images : undefined).toEqual([{ media_type: "image/png", ref: "pi:read|one:0" }]);
    expect(Buffer.from(ompTranscriptImage(path, "pi:read|one:0")!.bytes)).toEqual(PNG);
    expect(piTranscriptImage(path, "pi:read|one:0")).toBeNull();
    expect(ompTranscriptImage(path, "pi:unknown:0")).toBeNull();
    expect(ompTranscriptImage(path, "pi:read|one:1")).toBeNull();
  });

  it("finds normalized nested inline results beside their calls", () => {
    const path = transcript([user("user", "read it"), { type: "message", id: "assistant", parentId: "user", message: { role: "assistant", content: [
      { type: "toolCall", callId: "nested|call", toolName: "read", input: {} },
      { type: "toolResult", callId: "nested|call", output: [imageBlock(PNG.toString("base64"))] },
    ] } }]);
    const tool = transcriptPage("omp-transcript", path).turns[1]?.parts[0];
    expect(tool?.kind).toBe("tool");
    expect(tool?.kind === "tool" ? tool.images : undefined).toEqual([{ media_type: "image/png", ref: "pi:nested|call:0" }]);
    expect(Buffer.from(ompTranscriptImage(path, "pi:nested|call:0")!.bytes)).toEqual(PNG);
  });

  it("only keeps supported blob entries from generated-image details, never preview text or paths", () => {
    const digest = blob();
    const data = `blob:sha256:${digest}`;
    const path = transcript([user("user", "generate"), call("generate"), result("generate", [{ type: "text", text: "![preview](/synthetic/image.png)" }], { xdev: { inner: { images: [
      { data, mimeType: "image/png" }, { data, mimeType: "image/svg+xml" }, { data: PNG.toString("base64"), mimeType: "image/png" },
      { savedPath: "/synthetic/image.png", mimeType: "image/png" },
    ] } } })]);
    const tool = transcriptPage("omp-transcript", path).turns[1]?.parts[0];
    expect(tool?.kind).toBe("tool");
    expect(tool?.kind === "tool" ? tool.images : undefined).toEqual([{ media_type: "image/png", ref: `blob:${digest}` }]);
  });

  it("keeps the first 1000 fetchable ordinals even after a result with a rejected call id", () => {
    const records = [
      user("user", "read the screenshots"),
      call("bad/id"), result("bad/id", [imageBlock(PNG.toString("base64"))]),
      call("many"), result("many", Array.from({ length: 1001 }, () => imageBlock(PNG.toString("base64")))),
    ];
    const path = transcript(records);
    const turns = parseOmpTranscript(lines(records), Infinity, { toolImages: true });
    expect(turns[1]?.parts).toHaveLength(2);
    const rejected = turns[1]?.parts[0];
    expect(rejected?.kind).toBe("tool");
    expect(rejected?.kind === "tool" ? rejected.images : null).toBeUndefined();
    const tool = turns[1]?.parts[1];
    expect(tool?.kind).toBe("tool");
    expect(tool?.kind === "tool" ? tool.images : undefined).toEqual(Array.from({ length: 1000 }, (_, index) => ({
      media_type: "image/png", ref: `pi:many:${index}`,
    })));
    expect(Buffer.from(ompTranscriptImage(path, "pi:many:999")!.bytes)).toEqual(PNG);
    expect(ompTranscriptImage(path, "pi:many:1000")).toBeNull();
  });
});

describe("blob-store isolation and byte validation", () => {
  it("finds the nearest sessions ancestor for a deeply nested subagent, including extension siblings", () => {
    const digest = blob(PNG, ".webp");
    const path = transcript([user("user", [imageBlock(`blob:sha256:${digest}`, "image/webp")])], "child", true);
    const image = ompTranscriptImage(path, `blob:${digest}`);
    expect(image?.mediaType).toBe("image/png");
    expect(Buffer.from(image!.bytes)).toEqual(PNG);
  });

  it("rejects unknown digests and bytes present in the store but absent from visible history", () => {
    const digest = blob();
    const unknown = "a".repeat(64);
    const path = transcript([user("user", [imageBlock(`blob:sha256:${unknown}`)])]);
    expect(ompTranscriptImage(path, `blob:${unknown}`)).toBeNull();
    expect(ompTranscriptImage(path, `blob:${digest}`)).toBeNull();
    expect(ompTranscriptImage(join(root, "missing.jsonl"), `blob:${digest}`)).toBeNull();
  });

  it("rejects pre-clear blob and inline references while keeping later images", () => {
    const digest = blob();
    const current = blob(JPEG);
    const path = transcript([
      user("old", [imageBlock(`blob:sha256:${digest}`), imageBlock(PNG.toString("base64"))]), call("old-call"), result("old-call", [imageBlock(PNG.toString("base64"))]),
      { type: "custom", id: "clear", customType: "context_clear" },
      user("new", [imageBlock(`blob:sha256:${current}`, "image/jpeg")]),
    ]);
    expect(ompTranscriptImage(path, `blob:${digest}`)).toBeNull();
    expect(ompTranscriptImage(path, "pi-user:old:1")).toBeNull();
    expect(ompTranscriptImage(path, "pi:old-call:0")).toBeNull();
    expect(ompTranscriptImage(path, `blob:${current}`)?.mediaType).toBe("image/jpeg");
    expect(transcriptPage("omp-transcript", path).turns[0]?.parts).toEqual([{ kind: "image", media_type: "image/jpeg", ref: `blob:${current}` }]);
  });

  it("rejects traversal, uppercase or overlong digests and symlinks escaping blobs", () => {
    const digest = createHash("sha256").update(PNG).digest("hex");
    const path = transcript([user("user", [imageBlock(`blob:sha256:${digest}`)])]);
    const outside = join(root, "outside.png");
    writeFileSync(outside, PNG);
    symlinkSync(outside, join(blobs, digest));
    for (const ref of [`blob:../${digest}`, `blob:${digest}/../outside.png`, `blob:${digest.toUpperCase()}`, `blob:${digest}0`, "blob:sha256:" + digest]) {
      expect(ompTranscriptImage(path, ref)).toBeNull();
    }
    expect(ompTranscriptImage(path, `blob:${digest}`)).toBeNull();
    const outsideTranscript = join(root, "outside.jsonl");
    writeFileSync(outsideTranscript, lines([user("user", [imageBlock(`blob:sha256:${digest}`)])]));
    expect(ompTranscriptImage(outsideTranscript, `blob:${digest}`)).toBeNull();
  });

  it("rejects oversized blobs before reading, non-raster bytes and oversized or bad-signature inline data", () => {
    const oversize = blob();
    truncateSync(join(blobs, oversize), MAX_IMAGE_BYTES + 1);
    const bad = blob(Buffer.from("not an image"));
    const path = transcript([user("user", [imageBlock(`blob:sha256:${oversize}`), imageBlock(`blob:sha256:${bad}`), imageBlock("bm90IGFuIGltYWdl"), imageBlock(PNG.toString("base64") + "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4))])]);
    expect(ompTranscriptImage(path, `blob:${oversize}`)).toBeNull();
    expect(ompTranscriptImage(path, `blob:${bad}`)).toBeNull();
    expect(ompTranscriptImage(path, "pi-user:user:2")).toBeNull();
    expect(ompTranscriptImage(path, "pi-user:user:3")).toBeNull();
  });
});

describe("pi active-branch image visibility", () => {
  it("fetches pi blobs only from its active branch after the latest context clear", () => {
    const digest = blob();
    const current = blob(JPEG);
    const path = transcript([user("root", "start"), user("old", [imageBlock(`blob:sha256:${digest}`)], "root")]);
    expect(piTranscriptImage(path, `blob:${digest}`)?.mediaType).toBe("image/png");
    appendFileSync(path, lines([user("new", [imageBlock(`blob:sha256:${current}`, "image/jpeg")], "root")]));
    expect(piTranscriptImage(path, `blob:${digest}`)).toBeNull();
    expect(piTranscriptImage(path, `blob:${current}`)?.mediaType).toBe("image/jpeg");
    appendFileSync(path, lines([{ type: "custom", id: "clear", parentId: "new", customType: "context_clear" }, user("after", [imageBlock(PNG.toString("base64"))], "clear")]));
    expect(piTranscriptImage(path, `blob:${current}`)).toBeNull();
  });

  it("keeps user images off abandoned branches and behind the latest context clear", () => {
    const data = PNG.toString("base64");
    const path = transcript([user("root", "start"), user("old", [imageBlock(data)], "root")]);
    expect(piTranscriptImage(path, "pi-user:old:0")?.mediaType).toBe("image/png");
    appendFileSync(path, lines([user("new", [imageBlock(data)], "root")]));
    expect(piTranscriptImage(path, "pi-user:old:0")).toBeNull();
    expect(piTranscriptImage(path, "pi-user:new:0")?.mediaType).toBe("image/png");
    appendFileSync(path, lines([{ type: "custom", id: "clear", parentId: "new", customType: "context_clear" }, user("after", [imageBlock(data)], "clear")]));
    expect(piTranscriptImage(path, "pi-user:new:0")).toBeNull();
    expect(piTranscriptImage(path, "pi-user:after:0")?.mediaType).toBe("image/png");
  });
});

describe("image-only prompts open conversation pages", () => {
  for (const source of sources) {
    it(`pages image-only user turns for ${source} and ignores hidden image entries`, () => {
      const records = Array.from({ length: 51 }, (_, index) => user(`user-${index}`, [imageBlock(PNG.toString("base64"))], index === 0 ? null : `user-${index - 1}`));
      const hidden = { ...user("hidden", [imageBlock(PNG.toString("base64"))], "user-50"), display: false };
      const path = transcript([...records, hidden], source);
      const page = transcriptPage(source, path);
      expect(page.turns).toHaveLength(50);
      expect(page.turns[0]?.parts[0]).toMatchObject({ kind: "image", ref: "pi-user:user-1:0" });
      expect(page.cursor).not.toBeNull();
    });
  }

  it("pages Claude image-only prompts without counting meta or command-only entries", () => {
    const records = Array.from({ length: 51 }, (_, index) => ({
      type: "user", uuid: `12345678-1234-1234-1234-${index.toString().padStart(12, "0")}`,
      message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } }] },
    }));
    const path = transcript([...records,
      { ...records[50], uuid: "12345678-1234-1234-1234-999999999999", isMeta: true },
      { type: "user", message: { content: [{ type: "text", text: "<command-name>/help</command-name>" }] } },
    ], "claude");
    const page = transcriptPage("claude-transcript", path);
    expect(page.turns).toHaveLength(50);
    expect(page.turns[0]?.parts[0]).toMatchObject({ kind: "image", ref: `${records[1]!.uuid}:0` });
    expect(page.cursor).not.toBeNull();
  });
});
