import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeTranscript, transcriptImage } from "./conversation.ts";
import { MAX_IMAGE_BYTES } from "./image-bytes.ts";

const uuid = "11111111-2222-3333-4444-555555555555";
const nextUuid = "66666666-2222-3333-4444-555555555555";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpeg = Buffer.from([255, 216, 255]);
const lines = (...records: unknown[]): string => records.map((record) => JSON.stringify(record)).join("\n");
const imageBlock = (mediaType = "image/png", data = png.toString("base64")) => ({ type: "image", source: { type: "base64", media_type: mediaType, data } });
const toolResult = (content: unknown, id = "read") => ({ type: "tool_result", tool_use_id: id, content });
const userEntry = (content: unknown[], id: unknown = uuid) => ({ type: "user", uuid: id, message: { content } });
const toolCall = (id = "read", name = "Read") => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { file_path: "/synthetic/image.png" } }] } });
const toolsIn = (text: string) => parseClaudeTranscript(text).flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");

describe("Claude recorded tool images", () => {
  it("attaches nested images to the matching Read tool and preserves mixed result text", () => {
    const text = lines(
      toolCall("read"),
      toolCall("other", "mcp__preview"),
      {
        ...userEntry([
          toolResult([{ type: "text", text: "other result" }], "other"),
          toolResult([{ type: "text", text: "image read\n" }, imageBlock(), { type: "text", text: "done" }, imageBlock("image/jpeg", jpeg.toString("base64"))]),
        ]),
        toolUseResult: { file: { base64: png.toString("base64"), type: "image/png" } },
      },
    );
    const turns = parseClaudeTranscript(text);
    const tools = turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("Read");
    expect(tools[0]!.output).toBe("image read\ndone");
    expect(tools[0]!.images).toEqual([
      { media_type: "image/png", ref: `${uuid}:1:1` },
      { media_type: "image/jpeg", ref: `${uuid}:1:3` },
    ]);
    expect(tools[1]!.output).toBe("other result");
    expect(tools[1]!.images).toBeUndefined();
    expect(turns).toHaveLength(1);
    expect(JSON.stringify(turns)).not.toContain(png.toString("base64"));
    expect(JSON.stringify(turns)).not.toContain(jpeg.toString("base64"));
    expect(JSON.stringify(turns)).not.toContain("base64");
  });

  it("keeps images on error results and on image-only MCP results", () => {
    const tools = toolsIn(lines(
      toolCall("read"),
      toolCall("mcp", "mcp__screenshot"),
      userEntry([
        { ...toolResult([{ type: "text", text: "partial read failed" }, imageBlock()]), is_error: true },
        toolResult([imageBlock("image/webp", Buffer.from("RIFF0000WEBP").toString("base64"))], "mcp"),
      ]),
    ));
    expect(tools[0]!.error).toBe(true);
    expect(tools[0]!.output).toBe("partial read failed");
    expect(tools[0]!.images).toEqual([{ media_type: "image/png", ref: `${uuid}:0:1` }]);
    expect(tools[1]!.output).toBe("");
    expect(tools[1]!.images).toEqual([{ media_type: "image/webp", ref: `${uuid}:1:0` }]);
  });

  it("skips unsupported MIME, malformed sources, path-only carriers and duplicate file bytes", () => {
    const tools = toolsIn(lines(
      toolCall(),
      {
        ...userEntry([toolResult([
          imageBlock("image/svg+xml"),
          { type: "image", source: { type: "base64", media_type: "image/png" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: 1 } },
          { type: "image", source: { type: "url", media_type: "image/png", url: "/synthetic/image.png" } },
          { type: "text", text: "![preview](/synthetic/image.png)" },
        ])]),
        toolUseResult: { file: { base64: png.toString("base64"), type: "image/png" } },
      },
    ));
    expect(tools[0]!.images).toBeUndefined();
    expect(tools[0]!.output).toBe("![preview](/synthetic/image.png)");
    const duplicateOnly = toolsIn(lines(toolCall(), {
      ...userEntry([toolResult("read completed")]),
      toolUseResult: { file: { base64: png.toString("base64"), type: "image/png" } },
    }));
    expect(duplicateOnly[0]!.images).toBeUndefined();
  });

  it("names all supported recorded MIME types without exposing their data", () => {
    const blocks = [
      imageBlock(),
      imageBlock("image/jpeg", jpeg.toString("base64")),
      imageBlock("image/gif", Buffer.from("GIF89a").toString("base64")),
      imageBlock("image/webp", Buffer.from("RIFF0000WEBP").toString("base64")),
    ];
    const tools = toolsIn(lines(toolCall(), userEntry([toolResult(blocks)])));
    expect(tools[0]!.images).toEqual(blocks.map((block, index) => ({ media_type: block.source.media_type, ref: `${uuid}:0:${index}` })));
    for (const block of blocks) expect(JSON.stringify(tools)).not.toContain(block.source.data);
  });

  it("omits both nested and pasted images when the entry UUID cannot form a fetchable ref", () => {
    for (const id of [undefined, null, 123, "a".repeat(7), "a".repeat(65), "not-a-uuid", "11111111/path"]) {
      const turns = parseClaudeTranscript(lines(toolCall(), { ...userEntry([toolResult([imageBlock()]), imageBlock(), { type: "text", text: "prompt" }]), uuid: id }));
      const tools = turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
      expect(tools[0]!.images).toBeUndefined();
      expect(turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "image")).toEqual([]);
      expect(turns.at(-1)!.parts).toEqual([{ kind: "text", text: "prompt" }]);
    }
    for (const id of ["a".repeat(8), "A".repeat(64)]) {
      const tools = toolsIn(lines(toolCall(), userEntry([toolResult([imageBlock()])], id)));
      expect(tools[0]!.images).toEqual([{ media_type: "image/png", ref: `${id}:0:0` }]);
    }
  });

  it("accepts index 999 and omits 1000 in nested, result-block and pasted-image refs", () => {
    const nested = [...Array.from({ length: 999 }, () => null), imageBlock(), imageBlock()];
    const nestedTools = toolsIn(lines(toolCall(), userEntry([toolResult(nested)])));
    expect(nestedTools[0]!.images).toEqual([{ media_type: "image/png", ref: `${uuid}:0:999` }]);

    const resultBlocks = [...Array.from({ length: 999 }, () => null), toolResult([imageBlock()], "within"), toolResult([imageBlock()], "beyond")];
    const indexedTools = toolsIn(lines(toolCall("within"), toolCall("beyond"), userEntry(resultBlocks)));
    expect(indexedTools[0]!.images).toEqual([{ media_type: "image/png", ref: `${uuid}:999:0` }]);
    expect(indexedTools[1]!.images).toBeUndefined();

    const turns = parseClaudeTranscript(lines(userEntry(nested)));
    expect(turns[0]!.parts).toEqual([{ kind: "image", media_type: "image/png", ref: `${uuid}:999` }]);
  });

  it("does not emit pasted refs for missing bytes or unsupported image carriers", () => {
    const turns = parseClaudeTranscript(lines(userEntry([
      { type: "image", source: { type: "base64", media_type: "image/png" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: 123 } },
      { type: "image", source: { type: "url", media_type: "image/png", data: "/synthetic/image.png" } },
      imageBlock("image/svg+xml"),
    ])));
    expect(turns).toEqual([]);
  });
});

describe("Claude transcript image bytes", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "herdr-claude-tool-image-"));
    path = join(dir, "session.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const save = (...records: unknown[]) => writeFileSync(path, lines(...records));

  it("resolves nested and top-level refs using the sniffed MIME rather than the recorded MIME", () => {
    save(userEntry([
      imageBlock("image/jpeg"),
      toolResult([{ type: "text", text: "read" }, imageBlock("image/png", jpeg.toString("base64"))]),
    ]));
    const pasted = transcriptImage(path, `${uuid}:0`);
    expect(pasted?.mediaType).toBe("image/png");
    expect(Buffer.from(pasted!.bytes)).toEqual(png);
    const nested = transcriptImage(path, `${uuid}:1:1`);
    expect(nested?.mediaType).toBe("image/jpeg");
    expect(Buffer.from(nested!.bytes)).toEqual(jpeg);
  });

  it("resolves emitted Read refs end to end", () => {
    const text = lines(toolCall(), userEntry([toolResult([imageBlock()])]));
    writeFileSync(path, text);
    const ref = toolsIn(text)[0]!.images![0]!.ref;
    const image = transcriptImage(path, ref);
    expect(image?.mediaType).toBe("image/png");
    expect(Buffer.from(image!.bytes)).toEqual(png);
  });

  it("rejects wrong block kinds, invalid indices and malformed refs", () => {
    save(userEntry([
      imageBlock(),
      toolResult([{ type: "text", text: "text" }, imageBlock()]),
      { type: "text", content: [imageBlock()] },
      { type: "tool_result", content: imageBlock() },
      null,
    ]));
    for (const ref of [
      `${uuid}:1`, `${uuid}:1:0`, `${uuid}:0:0`, `${uuid}:2:0`, `${uuid}:3:0`, `${uuid}:4`, `${uuid}:4:0`,
      `${uuid}:99`, `${uuid}:1:99`, `${uuid}:1000`, `${uuid}:1:1000`, `${uuid}:1000:0`,
      `${uuid}:-1`, `${uuid}:1:-1`, `${uuid}:1:1:0`, `${uuid}:NaN`, `${nextUuid}:1:1`,
      "../../etc/passwd:0", `${"a".repeat(7)}:0`, `${"a".repeat(65)}:0`,
    ]) expect(transcriptImage(path, ref)).toBeNull();
    expect(transcriptImage(join(dir, "missing.jsonl"), `${uuid}:0`)).toBeNull();
  });

  it("rejects unsupported MIME and sources without recorded base64 bytes in either form", () => {
    const blocks = [
      imageBlock("image/svg+xml"),
      { type: "image", source: { type: "base64", media_type: "image/png" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: 1 } },
      { type: "image", source: { type: "url", media_type: "image/png", data: png.toString("base64") } },
    ];
    save(userEntry([...blocks, toolResult(blocks)]));
    for (let index = 0; index < blocks.length; index++) {
      expect(transcriptImage(path, `${uuid}:${index}`)).toBeNull();
      expect(transcriptImage(path, `${uuid}:${blocks.length}:${index}`)).toBeNull();
    }
  });

  it("rejects invalid base64 raster signatures in both ref forms", () => {
    for (const data of ["", "not-base64", Buffer.from("not an image").toString("base64"), Buffer.from([137, 80, 78, 71]).toString("base64")]) {
      save(userEntry([imageBlock("image/png", data), toolResult([imageBlock("image/png", data)])]));
      expect(transcriptImage(path, `${uuid}:0`)).toBeNull();
      expect(transcriptImage(path, `${uuid}:1:0`)).toBeNull();
    }
  });

  it("rejects bytes over the shared 8 MiB cap in both ref forms", () => {
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    png.copy(oversized);
    const data = oversized.toString("base64");
    for (const [content, ref] of [
      [[imageBlock("image/png", data)], `${uuid}:0`],
      [[toolResult([imageBlock("image/png", data)])], `${uuid}:0:0`],
    ] as const) {
      save(userEntry([...content]));
      expect(transcriptImage(path, ref)).toBeNull();
    }
  });

  it("excludes pre-clear pasted and tool-result images while retaining current recorded images", () => {
    const text = lines(
      toolCall(),
      userEntry([imageBlock(), toolResult([imageBlock()])]),
      { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
      toolCall("current"),
      userEntry([imageBlock(), toolResult([imageBlock()], "current")], nextUuid),
    );
    writeFileSync(path, text);
    expect(transcriptImage(path, `${uuid}:0`)).toBeNull();
    expect(transcriptImage(path, `${uuid}:1:0`)).toBeNull();
    expect(transcriptImage(path, `${nextUuid}:0`)?.mediaType).toBe("image/png");
    expect(transcriptImage(path, `${nextUuid}:1:0`)?.mediaType).toBe("image/png");
    expect(JSON.stringify(parseClaudeTranscript(text))).not.toContain(uuid);
  });

  it("does not resolve images from entry kinds the Claude parser hides", () => {
    for (const record of [
      { ...userEntry([imageBlock(), toolResult([imageBlock()])]), type: "assistant" },
      { ...userEntry([imageBlock(), toolResult([imageBlock()])]), isMeta: true },
      { ...userEntry([imageBlock(), toolResult([imageBlock()])]), isCompactSummary: true },
    ]) {
      save(record);
      expect(transcriptImage(path, `${uuid}:0`)).toBeNull();
      expect(transcriptImage(path, `${uuid}:1:0`)).toBeNull();
    }
  });
});
