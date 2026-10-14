import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexImageParts, codexTranscriptImage } from "./codex-images.ts";
import { matchCodexFirstExchange, parseCodexTranscript } from "./codex.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", "base64");
const data = `data:image/png;base64,${png.toString("base64")}`;
const event = (message: string, local_images: string[]) => ({ type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload: { type: "user_message", message, local_images } });
const userContent = (content: unknown[]) => ({ type: "response_item", timestamp: "2026-09-27T00:00:00Z", payload: { type: "message", role: "user", content } });
const response = (text: string, image: string) => userContent([{ type: "input_text", text }, { type: "input_image", image_url: image }]);
const envelopePaths = ["/tmp/codex-envelope-fixture/one.png", "/tmp/codex-envelope-fixture/two.gif"];
const envelopedResponse = (text: string) => userContent([
  { type: "input_text", text: `<image name=[Image #1] path="${envelopePaths[0]}">` },
  { type: "input_image", image_url: data, detail: "high" },
  { type: "input_text", text: "</image>" },
  { type: "input_text", text: `<image name=[Image #2] path="${envelopePaths[1]}">` },
  { type: "input_image", image_url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", detail: "high" },
  { type: "input_text", text: "</image>" },
  { type: "input_text", text },
]);
const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");

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

it("hides native image envelopes but keeps both images and the typed placeholders", () => {
  const text = "[Image #1] [Image #2] describe";
  const record = envelopedResponse(text);
  const images = codexImageParts(record);
  expect(images).toHaveLength(2);
  const turns = parseCodexTranscript(jsonl(record));
  expect(turns).toEqual([
    { role: "user", ts: record.timestamp, parts: [...images, { kind: "text", text }] },
  ]);
  expect(JSON.stringify(turns)).not.toContain("<image");
  expect(JSON.stringify(turns)).not.toContain("/tmp/codex-envelope-fixture/");
});

it("preserves ordinary image markup unless the entire input_text is adjacent in the native direction", () => {
  const opening = '<image name=[Image #1] path="x">';
  const image = { type: "input_image", image_url: data };
  const input = (text: string) => ({ type: "input_text", text });
  const examples = [
    { content: [input(opening)], text: opening },
    { content: [input(opening), input("Ordinary prose"), image], text: `${opening}\nOrdinary prose` },
    { content: [image, input("Ordinary prose"), input("</image>")], text: "Ordinary prose\n</image>" },
    { content: [image, input(opening)], text: opening },
    { content: [input("</image>"), image], text: "</image>" },
    ...[
      `${opening}\nExplain this tag.`,
      `Explain ${opening}`,
      `${opening}</image>`,
      '<image name=[Image #1] path="x" extra="value">',
      "<image name=[Image #1] path='x'>",
      "</image>\nExplain this tag.",
    ].map((text) => ({ content: [input(text), image], text })),
    { content: [{ type: "output_text", text: opening }, image], text: opening },
  ];
  for (const { content, text } of examples) {
    const parts = parseCodexTranscript(jsonl(userContent(content)))[0]!.parts;
    expect(parts.filter((part) => part.kind === "text")).toEqual([{ kind: "text", text }]);
  }
});

it("accepts trimmed pathless envelopes around local images without dropping surrounding prose", () => {
  const record = userContent([
    { type: "input_text", text: "Before" },
    { type: "input_text", text: " \n<image name=[Image #3]>\t" },
    { type: "local_image", path: "/tmp/codex-envelope-fixture/three.png" },
    { type: "input_text", text: "\t</image>\n " },
    { type: "input_text", text: "After" },
  ]);
  expect(parseCodexTranscript(jsonl(record))[0]!.parts).toEqual([
    ...codexImageParts(record), { kind: "text", text: "Before\nAfter" },
  ]);
});

it("pairs cleaned image responses with older display events in either order", () => {
  const text = "[Image #1] [Image #2] describe";
  const display = event(text, envelopePaths);
  for (const records of [[display, envelopedResponse(text)], [envelopedResponse(text), display]]) {
    expect(parseCodexTranscript(jsonl(...records))).toEqual([
      { role: "user", ts: display.timestamp, parts: [...codexImageParts(display), { kind: "text", text }] },
    ]);
  }
});

it("matches a first exchange using the displayed prose rather than native image envelopes", () => {
  const prompt = "[Image #1] [Image #2] describe";
  const answer = "The fixture contains two tiny images.";
  const record = envelopedResponse(prompt);
  const started = Date.parse(record.timestamp);
  const screen = `OpenAI Codex (v1.0)\n\n› ${prompt}\n\n• ${answer}\n\n› `;
  const text = jsonl(record, {
    type: "response_item", timestamp: record.timestamp,
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }], phase: "final_answer" },
  });
  expect(matchCodexFirstExchange(screen, [
    { path: "fixture", text, firstUserMessage: prompt, createdAtMs: started },
  ], started)).toBe("fixture");
});

it("does not turn remote URLs, unsupported data, or assistant/tool content into images", () => {
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
