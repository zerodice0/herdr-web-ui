/** Shared native-record rules keep paging, rendering and on-demand results consistent. */
import type { ConversationPart, ConversationTurn, OmoTaskResult } from "../shared/protocol.ts";
import type { SubagentDetail, TaskNotification } from "./claude-subagents.ts";
import { imageType, MAX_IMAGE_BYTES } from "./image-bytes.ts";
import { skillInvocationPrompt } from "./skill-activity.ts";
import { trimOutput } from "./tool-output.ts";

type Row = Record<string, unknown>;
export const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const string = (...values: unknown[]): string | undefined => values.find((value) => typeof value === "string") as string | undefined;
export const resultText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.map((part) => typeof record(part).text === "string" ? record(part).text : "").join("") : "";

export function isContextClear(value: unknown, source: string): boolean {
  const entry = record(value);
  if (source === "codex-transcript" || source === "scrollback") return false;
  if (source !== "claude-transcript") return entry.type === "custom" && entry.customType === "context_clear";
  const message = record(entry.message);
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary || message.role !== "user" || typeof message.content !== "string") return false;
  // Require a whole local-command envelope; quoting /clear in prose is not a reset.
  return /^\s*<command-name>\s*\/clear\s*<\/command-name>(?:\s*<command-message>clear<\/command-message>)?(?:\s*<command-args>\s*<\/command-args>)?\s*$/.test(message.content);
}

/** Asset reads share the reset boundary even when their ref predates /clear. */
export function activeHistoryText(text: string, source: string): string {
  if (source === "codex-transcript") return text;
  let start = 0, offset = 0;
  for (const line of text.split("\n")) {
    if (line.includes("context_clear") || line.includes("/clear")) {
      try { if (isContextClear(JSON.parse(line), source)) start = offset + line.length + 1; } catch { /* torn line */ }
    }
    offset += line.length + 1;
  }
  return text.slice(start);
}

/**
 * Another Claude session's message (Claude Code cross-session messaging). It starts the agent's
 * work like a prompt, but nobody typed it here: a notice, sourced `peer:<sender>`. Claude records it
 * as a meta `user` entry when it arrives between turns, and as a queued_command attachment when it
 * arrives mid-turn; both carry `origin: { kind: "peer", name, body }`.
 */
export function claudePeerNotice(value: unknown): Extract<ConversationPart, { kind: "notice" }> | null {
  const entry = record(value);
  const queued = entry.type === "attachment" ? record(entry.attachment) : null;
  if (queued !== null && queued.type !== "queued_command") return null;
  if (queued === null && !(entry.type === "user" && entry.isMeta === true)) return null;
  const origin = record(queued !== null ? queued.origin : entry.origin);
  if (origin.kind !== "peer") return null;
  const envelope = queued !== null ? queued.prompt : record(entry.message).content;
  const parsed = typeof envelope === "string" ? /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(envelope) : null;
  const body = typeof origin.body === "string" ? origin.body : parsed?.[2] ?? "";
  // an unnamed sender leaves the source bare (`peer:`); the chat says "another session" for it
  const name = typeof origin.name === "string" && origin.name.trim() ? origin.name.trim() : /\bfrom-name="([^"]+)"/.exec(parsed?.[1] ?? "")?.[1] ?? "";
  return body.trim() ? { kind: "notice", text: body, source: `peer:${name}` } : null;
}

/**
 * One delivery of another session's message, as Claude identifies it: the sender and its message id.
 * Claude can record the same delivery twice (queued mid-turn, then echoed as a meta entry); the second
 * record is the same notice. Null when the record does not carry both.
 */
export function claudePeerId(value: unknown): string | null {
  const entry = record(value);
  const queued = entry.type === "attachment" ? record(entry.attachment) : null;
  const origin = record(queued !== null ? queued.origin : entry.origin);
  return origin.kind === "peer" && typeof origin.from === "string" && typeof origin.msg_id === "string" && origin.from && origin.msg_id
    ? `${origin.from}|${origin.msg_id}` : null;
}

/** Pi-family providers use several spellings for the same tool call/result fields. */
export function piMessage(value: unknown): Row | null {
  const entry = record(value);
  const message = record(entry.message);
  if (entry.type !== "message" || message.display === false || entry.display === false) return null;
  const raw = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
  const content = raw.map((value) => {
    const block = record(value);
    if (block.type === "toolCall") return { ...block, name: string(block.toolName, block.name), id: string(block.toolCallId, block.id, block.callId), arguments: block.toolInput ?? block.input ?? block.arguments };
    if (block.type === "toolResult") return { ...block, toolCallId: string(block.toolCallId, block.callId, block.id), content: block.output ?? block.content ?? block.result };
    return block;
  });
  return { ...message, toolCallId: string(message.toolCallId, message.callId), content };
}

/** Pi-family image refs are shared by the parser and the readers, including omp's `|` call ids. */
export const PI_IMAGE_REF = /^pi:([A-Za-z0-9_:.\-|]{1,128}):(\d{1,3})$/;
export const PI_USER_IMAGE_REF = /^pi-user:([A-Za-z0-9_:.\-|]{1,128}):(\d{1,3})$/;
export const BLOB_IMAGE_REF = /^blob:([0-9a-f]{64})$/;
const BLOB_IMAGE_DATA = /^blob:sha256:([0-9a-f]{64})$/;
type PiImage = { media_type: string; data: string };

/**
 * One entry's tool results, with its supported recorded images. Inline images are
 * addressed by their position among supported images; blobs have a content address.
 * Generated images live in xdev details, not the tool's inline-preview text.
 */
export function piResults(message: Row): { id: string; text: string; error: boolean; images: PiImage[] }[] {
  const blocks = message.role === "toolResult" ? [message] : Array.isArray(message.content) ? message.content.filter((block) => record(block).type === "toolResult") : [];
  return blocks.flatMap((value) => {
    const block = record(value);
    if (typeof block.toolCallId !== "string") return [];
    return [{ id: block.toolCallId, text: resultText(block.content), error: block.isError === true, images: piResultImages(block) }];
  });
}

/** The image types a chat shows; pi names the type `mimeType` where Claude names it `media_type`. */
const PI_IMAGE_TYPES: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true };
function piImageData(image: Row): PiImage | null {
  const type = typeof image.mimeType === "string" ? image.mimeType : typeof image.media_type === "string" ? image.media_type : null;
  if (type === null || PI_IMAGE_TYPES[type] !== true || typeof image.data !== "string") return null;
  // A short signature probe rejects path-only data without decoding the whole image
  // on each conversation poll. The reader checks the complete bytes and size again.
  if (!BLOB_IMAGE_DATA.test(image.data) && (image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4
    || imageType(Buffer.from(image.data.slice(0, 16), "base64")) === null)) return null;
  return { media_type: type, data: image.data };
}

function piImageOf(value: unknown): PiImage | null {
  const image = record(value);
  return image.type === "image" ? piImageData(image) : null;
}

function piResultImages(block: Row): PiImage[] {
  const images = (Array.isArray(block.content) ? block.content : []).map(piImageOf).filter((image): image is PiImage => image !== null);
  const generated = record(record(record(block.details).xdev).inner).images;
  for (const value of Array.isArray(generated) ? generated : []) {
    const image = piImageData(record(value));
    if (image !== null && BLOB_IMAGE_DATA.test(image.data)) images.push(image);
  }
  return images;
}

/** Only emit inline addresses the corresponding fetcher accepts. */
function piImageRef(image: PiImage, inlineRef: string): string | null {
  const blob = BLOB_IMAGE_DATA.exec(image.data);
  return blob !== null ? `blob:${blob[1]}` : PI_IMAGE_REF.test(inlineRef) || PI_USER_IMAGE_REF.test(inlineRef) ? inlineRef : null;
}

/** The image of a normalized result, using the same ordinal as the page's ref. */
export function piImageBlock(message: Row, toolCallId: string, index: number): PiImage | null {
  const blocks = message.role === "toolResult" ? [message] : Array.isArray(message.content) ? message.content : [];
  for (const value of blocks) {
    const block = record(value);
    if (block.toolCallId === toolCallId && (message.role === "toolResult" || block.type === "toolResult")) {
      return index >= 0 ? piResultImages(block)[index] ?? null : null;
    }
  }
  return null;
}

/** User images use the record's stable id, never its position in a page. */
export function piUserImages(entry: unknown, message = piMessage(entry)): PiImage[] {
  return message?.role === "user" && Array.isArray(message.content)
    ? message.content.map(piImageOf).filter((image): image is PiImage => image !== null) : [];
}

export function piUserImageParts(entry: unknown, message = piMessage(entry)): Extract<ConversationPart, { kind: "image" }>[] {
  return piUserImages(entry, message).flatMap((image, index) => {
    const id = record(entry).id;
    const ref = piImageRef(image, typeof id === "string" ? `pi-user:${id}:${index}` : "");
    return ref === null ? [] : [{ kind: "image", media_type: image.media_type, ref }];
  });
}

/** Enough turns for a conversation. */
export const MAX_TURNS = 100;

/**
 * gjc wakes the agent with a `custom_message` (a background job's result, `display: true`)
 * in the user's seat: the answer before it is final and the work after it is a new turn.
 * Merging across it buried that answer in the work block. The envelope is chrome.
 */
export function piNotice(value: unknown): Extract<ConversationPart, { kind: "notice" }> | null {
  const entry = record(value);
  if (entry.type !== "custom_message" || entry.display === false || typeof entry.content !== "string") return null;
  const text = entry.content.trim().replace(/^<system-notice>\s*/, "").replace(/\s*<\/system-notice>$/, "").trim();
  if (text.length === 0) return null;
  return typeof entry.customType === "string" ? { kind: "notice", text, source: entry.customType } : { kind: "notice", text };
}

const OMO_TASK_RESULT_MAX = 16_000;
const label = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const amount = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * The summaries OmO's `task` calls gave their tasks, by task id: the call's result names the
 * task it started (`details.task_id`, or one `details.items` entry per task of a batch).
 */
export function omoTaskTitles(message: Row, titles: Map<string, string>): void {
  if (message.role !== "toolResult" || message.toolName !== "task") return;
  const details = record(message.details);
  for (const value of Array.isArray(details.items) ? details.items : [details]) {
    const item = record(value);
    const id = label(item.task_id);
    const title = label(item.task_summary) ?? label(item.description);
    if (id !== null && title !== null) titles.set(id, title);
  }
}

/**
 * OmO wakes its agent when a background task ends with a `custom_message` (`omo-senpi:wake`,
 * `display: false`) whose details hold one `senpi-task.completion` per task. It is the only
 * record that the task ended and what it found, so it is drawn in the user's seat as gjc's
 * notice is; a wake that carries no task result (a monitor's event) stays the runtime's.
 */
export function omoTaskResults(value: unknown, titles: ReadonlyMap<string, string>): OmoTaskResult[] | null {
  const entry = record(value);
  if (entry.type !== "custom_message" || entry.customType !== "omo-senpi:wake" || !Array.isArray(entry.details)) return null;
  // one row per task: a task reported twice in one wake is the later report (the rows are keyed by id)
  const tasks = new Map<string, OmoTaskResult>();
  for (const group of entry.details) {
    if (record(group).customType !== "senpi-task.completion" || !Array.isArray(record(group).details)) continue;
    for (const value of record(group).details as unknown[]) {
      const task = record(value);
      const id = label(task.task_id);
      const raw = label(task.status);
      if (id === null || raw === null) continue;
      const stats = record(task.run_stats);
      const agent = label(task.agent_type) ?? label(task.category) ?? label(task.subagent_type);
      const name = label(task.name);
      const result = label(task.final_response) ?? label(task.error) ?? "";
      tasks.set(id, {
        id,
        title: titles.get(id) ?? (name !== null && name !== id ? name : agent ?? id),
        agent,
        model: label(record(task.resolved_model).display) ?? label(task.model),
        status: raw === "completed" ? "completed" : raw === "cancelled" || raw === "canceled" || raw === "aborted" ? "cancelled" : "failed",
        duration_ms: amount(task.duration_ms) ?? amount(stats.runtime_ms),
        turns: amount(stats.turns),
        tool_calls: amount(stats.tool_calls),
        tokens: amount(stats.total_tokens) ?? amount(task.tokens),
        result: result.slice(0, OMO_TASK_RESULT_MAX),
        ...(result.length > OMO_TASK_RESULT_MAX ? { result_cut: true } : {}),
      });
    }
  }
  return tasks.size > 0 ? [...tasks.values()] : null;
}

/**
 * The card for a Claude Code subagent that ended, from its `<task-notification>` alone and the
 * subagent's meta file (its description and agent type, which never change after it starts), so
 * that a page reads the same from a cold start as from a warm one. The turns, tool calls and
 * tokens a subagent's transcript holds grow with it, and the status line's list shows them.
 */
export function agentTaskResult(notice: TaskNotification, detail: SubagentDetail | undefined): OmoTaskResult {
  const result = notice.result;
  return {
    id: notice.taskId,
    title: detail?.title ?? /^Agent "(.*)"/.exec(notice.summary)?.[1]?.trim() ?? notice.taskId,
    agent: detail?.agent ?? null,
    model: null,
    status: notice.status,
    duration_ms: null,
    turns: null,
    tool_calls: null,
    tokens: null,
    result: result.slice(0, OMO_TASK_RESULT_MAX),
    ...(result.length > OMO_TASK_RESULT_MAX ? { result_cut: true } : {}),
  };
}

/** The one-line summary a collapsed tool chip shows. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  // an OmO or omp `task` call: the summary it gave the person, one per task of a batch
  if (name === "task") {
    const items = Array.isArray(input["tasks"]) ? input["tasks"].map(record) : [input];
    const titles = items.map((item) => label(item["task_summary"]) ?? label(item["description"])).filter((title) => title !== null);
    if (titles.length > 0) return titles.join(" · ").slice(0, 120);
  }
  // what the agent itself said the call is for: OmO's eval `summary`, the `description` Claude
  // gives a Bash command or a subagent's prompt. Another tool's `description` is its own data.
  const said = typeof input["code"] === "string" ? label(input["summary"])
    : typeof input["command"] === "string" || typeof input["prompt"] === "string" ? label(input["description"]) : null;
  if (said !== null) return said.slice(0, 120);
  // pi names a file `path` where Claude names it `file_path`, and a notebook `notebook_path`.
  const first = input["command"] ?? input["file_path"] ?? input["notebook_path"] ?? input["path"] ?? input["pattern"] ?? input["description"] ?? input["url"];
  return typeof first === "string" ? first.slice(0, 120) : name;
}

/**
 * Splits one omp session jsonl into turns. Same shape of result as the Claude
 * parser: adjacent assistant messages merge, toolCall parts adopt the output
 * of the toolResult entry that answers them (matched by toolCallId), thinking
 * stays private to the agent.
 *
 * An assistant message that stopped for good (`stopReason: "stop"`) ends its turn: the next one
 * was woken by something nobody typed, such as omo's hidden monitor or background-task
 * notification. Merging across it folded the answer before it into the next turn's work block.
 */
export function parseOmpTranscript(text: string, maxTurns = MAX_TURNS, options: { toolImages?: boolean; taskTitles?: Map<string, string> } = {}): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  /** tool parts still waiting for their result, by toolCall id */
  const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();
  /** what OmO's `task` calls called their tasks, by task id: the caller's, when it parses a page in stretches */
  const taskTitles = options.taskTitles ?? new Map<string, string>();
  /** the last assistant message stopped for good: the next one starts a turn of its own */
  let settled = false;

  const assistantTurn = (ts?: string): ConversationTurn => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === "assistant" && !settled) return last;
    const turn: ConversationTurn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  const contentParts = (content: unknown): { type?: string; text?: unknown }[] =>
    Array.isArray(content) ? content.filter((part) => typeof part === "object" && part !== null) : [];

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn tail line while omp is mid-append
    }
    if (entry === null || typeof entry !== "object") continue;
    if (isContextClear(entry, "omp-transcript")) { turns.length = 0; pending.clear(); continue; }
    const timestamp = (entry as { timestamp?: string }).timestamp;
    const notice = piNotice(entry);
    if (notice !== null) {
      turns.push({ role: "user", ts: timestamp ?? null, parts: [notice] });
      continue;
    }
    const results = omoTaskResults(entry, taskTitles);
    if (results !== null) {
      turns.push({ role: "user", ts: timestamp ?? null, parts: [{ kind: "task_result", tasks: results }] });
      continue;
    }
    // pi folds old context into a summary of its own accord and on /compact. The entry is a
    // tree entry, not a message, so it reaches the chat only through this branch: the card
    // says where the conversation was cut, and pi keeps answering from the summary onward.
    // piNotice above only claims `custom_message`, so a compaction entry always reaches here.
    if ((entry as { type?: unknown }).type === "compaction") {
      const summary = (entry as { summary?: unknown }).summary;
      if (typeof summary === "string" && summary.trim().length > 0) {
        turns.push({ role: "user", ts: timestamp ?? null, parts: [{ kind: "compact", text: summary }] });
      }
      continue;
    }
    const message = piMessage(entry);
    if (message === null) continue;
    const applyResults = () => {
      for (const result of piResults(message)) {
        const tool = pending.get(result.id);
        if (!tool) continue;
        pending.delete(result.id);
        trimOutput(tool, result.text, result.id);
        if (result.error) tool.error = true;
        if (options.toolImages === true) {
          const images = result.images.flatMap((image, index) => {
            const ref = piImageRef(image, `pi:${result.id}:${index}`);
            return ref === null ? [] : [{ media_type: image.media_type, ref }];
          });
          if (images.length > 0) tool.images = images;
        }
      }
    };
    if (message.role !== "assistant") applyResults();
    omoTaskTitles(message, taskTitles);

    if (message.role === "user") {
      const prompt =
        typeof message.content === "string"
          ? message.content
          : contentParts(message.content)
              .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
              .filter((part) => part.length > 0)
              .join("\n");
      const images = piUserImageParts(entry, message);
      if (prompt.length === 0 && images.length === 0) continue;
      // a skill invocation reads as what the user asked, the skill as a chip on it: not as the
      // SKILL.md the runtime put before it. Kept on this record, so no page boundary can part them
      const invocation = skillInvocationPrompt(prompt);
      const asked = invocation === null ? prompt : invocation.request || invocation.skills.map((skill) => `/skill:${skill.name}`).join(" ");
      turns.push({ role: "user", ts: timestamp ?? null, parts: [...images, ...(asked.length > 0 ? [{ kind: "text" as const, text: asked }] : []), ...(invocation?.skills ?? []).map((skill) => ({ kind: "skill" as const, skill }))] });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const turn = assistantTurn(timestamp);
      if (timestamp) turn.end_ts = timestamp;
      for (const block of message.content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; id?: unknown; arguments?: unknown; intent?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text });
        } else if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
        } else if (b.type === "toolCall" && typeof b.name === "string") {
          const input = (typeof b.arguments === "object" && b.arguments !== null ? b.arguments : {}) as Record<string, unknown>;
          const summary = typeof b.intent === "string" && b.intent.length > 0 ? b.intent : toolSummary(b.name, input);
          const part: Extract<ConversationPart, { kind: "tool" }> = {
            kind: "tool",
            name: b.name,
            summary: summary.slice(0, 120),
            input: JSON.stringify(input, null, 2),
            output: "",
          };
          turn.parts.push(part);
          if (typeof b.id === "string") pending.set(b.id, part);
        }
        // unsupported transcript parts are intentionally ignored
      }
      // A provider can place a result beside its call in the same assistant record.
      applyResults();
      // a failed request (a 401, an overloaded provider) leaves an empty message: without its
      // error the chat showed the prompt with no answer at all
      if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
        turn.parts.push({ kind: "text", text: `Error: ${message.errorMessage}` });
      }
      settled = message.stopReason === "stop";
    }
  }

  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}
