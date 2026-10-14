/**
 * Agent session transcripts -> structured conversation turns.
 *
 * The recognized stores are provider-native and read-only:
 * - Codex: native rollout JSONL, resolved by session metadata/open descriptors
 *   or a unique pane-text match for shared app-server TUIs (codex.ts).
 * - Claude Code: herdr's agent.get names the session id, the transcript lives
 *   at ~/.claude/projects/<project>/<session>.jsonl (claude-store.ts finds it).
 * - omp: herdr's agent.get hands us the session jsonl path outright under
 *   ~/.omp/agent/sessions/<cwd-slug>/, or ~/.omp/profiles/<name>/agent/sessions/<cwd-slug>/
 *   for `omp --profile <name>` — same shape of truth, one less hop. When herdr names none, the
 *   pane's omp process does, as gjc's does (omp.ts).
 * - omo: herdr knows nothing about its store and its label for the pane flips
 *   between `pi` and `claude` as omo spawns model CLIs, so the pane's process
 *   tree routes it and process/session evidence selects a unique transcript
 *   under <its agent dir>/sessions/<cwd-slug>/ (~/.omo/agent unless the process
 *   moved it with OMO_CODING_AGENT_DIR). It writes omp's session shape, so
 *   parseOmpTranscript (transcript-records.ts) reads it.
 * - gjc: an open session file or fresh native terminal breadcrumb belonging to
 *   its process (gjc-runtime.ts). It writes omp's session shape too.
 * - pi: herdr's agent.get names the session jsonl outright under
 *   ~/.pi/agent/sessions/<cwd-slug>/ (pi.ts). Its records are the session shape
 *   parseOmpTranscript reads, but its file is an entry tree, not a log: /tree
 *   moves the leaf and appends beside the path it left (pi-tree.ts), so the
 *   stream is projected onto the branch the leaf stands on before it is read.
 * - OpenCode: herdr's integration reports the session id, and OpenCode 2 keeps the
 *   session in its own SQLite store (opencode.ts), read by `seq` rather than by
 *   byte offset: its cursors name rows, and it pages and caches on its own.
 *
 * This module turns those files into the conversation the chat lens renders;
 * the pty stays the input path. Pure parsing lives in parseClaudeTranscript /
 * parseOmpTranscript (unit-tested); pane/session/file resolution is
 * integration and lives in paneTranscript.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import nodePath, { type PlatformPath } from "node:path";

import type { ConversationMetadata, ConversationPart, ConversationTurn, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { herdrRpc, paneRead, sessionSnapshot } from "./herdr/client.ts";
import { codexHistorySegments, createCodexTranscriptParser, codexOutputText, codexTranscriptPath, defaultCodexHome, forgetAllCodexState, forgetCodexStateFor, paneCodexHome, parseCodexTranscript, readRange } from "./codex.ts";
import { CODEX_IMAGE_REF, codexTranscriptImage, forgetCodexImageState } from "./codex-images.ts";
import { AmbiguousClaudeStore, claudeProcessSession, claudeTranscriptFile, defaultClaudeConfigDir, forgetClaudeSessionFile, forgetClaudeSessions, isClaudeProcess, processClaudeConfigDir } from "./claude-store.ts";
import { forgetGjcPane, forgetGjcState, gjcPidUnderShell, gjcTranscriptForPane, isGjcProcess, storeRelative } from "./gjc-runtime.ts";
import { isOmoProcess, omoSessionForPane } from "./omo.ts";
import { processStartedAt } from "./process-start.ts";
import { ompHeldTranscript } from "./omp.ts";
import { ompTranscriptImage, piImageInHistory } from "./omp-images.ts";
import { forgetOpencodeRead, forgetOpencodeState, OPENCODE_IMAGE_REF, opencodeConversation, opencodeDatabasePath, opencodeImage, opencodeReadKey, opencodeSessionId, opencodeToolOutput } from "./opencode.ts";
import { piTranscriptInStore, piTranscriptPath, unwrittenSession } from "./pi.ts";
import { forgetAllPiIndexes, forgetPiIndex, piAbandonedTurns, piBranchSegments, type TranscriptSegment } from "./pi-tree.ts";
import { defaultDevinDbPath, DevinHistoryUnavailable, devinConversation, forgetDevinState } from "./devin.ts";
import { forgetGrokState, grokProjection, grokToolOutput, parseGrokTranscript, GrokUnavailable } from "./grok.ts";
import { resolveGrokStore } from "./grok-store.ts";
import { AgyUnavailable, agyCatalog, agyToolOutput, forgetAgyState, parseAgyTranscript, withAgyHistory, type AgyProjection } from "./agy.ts";
import { resolveAgyStore, sameAgyStore, type AgyStore } from "./agy-store.ts";
import { trimOutput } from "./tool-output.ts";
import { base64Image } from "./image-bytes.ts";
import { parseConversationMetadata } from "./conversation-metadata.ts";
import { forgetHermesTranscriptState, hermesConversationPage, hermesToolOutput, hermesTranscriptForPane } from "./hermes.ts";

import { invokedSkill } from "./skill-activity.ts";
import { activeHistoryText, agentTaskResult, BLOB_IMAGE_REF, claudePeerId, claudePeerNotice, isContextClear, MAX_TURNS, parseOmpTranscript, PI_IMAGE_REF, PI_USER_IMAGE_REF, piMessage, piResults, piUserImageParts, toolSummary } from "./transcript-records.ts";
import { forgetSubagents, lineNotifications, subagentDetails, taskNotification, type SubagentDetail } from "./claude-subagents.ts";
import { launchedAgents } from "./launched-agents.ts";
import { readsStartScreen, startScreenMetadata } from "./start-screen.ts";

export { isOmoProcess } from "./omo.ts";

/**
 * A transcript is read a page at a time, the newest page re-read on every append
 * while an agent works: Codex rollouts reach hundreds of MB (a 400MB one took 1.1s
 * and 1.7GB of memory to parse whole). 16MB still holds dozens of turns of a
 * tool-heavy session; the chat asks for the pages before it as the reader scrolls up.
 */
export const TRANSCRIPT_WINDOW_BYTES = 16 * 1024 * 1024;

/** A page never holds more prompts than this (each opens a user + assistant pair). */
const MAX_PAGE_PROMPTS = MAX_TURNS / 2;

/** A single turn longer than a window still gets a page of its own, up to this. */
const MAX_PAGE_BYTES = 4 * TRANSCRIPT_WINDOW_BYTES;

/** Settings recorded once at the start (an omp thinking level) sit before a tail window. */
const METADATA_HEAD_BYTES = 64 * 1024;

/** Session ids are uuids; refusing anything else keeps the path traversal-free. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Slash-command and bookkeeping entries Claude logs as user turns — not conversations. */
function isCommandEntry(text: string): boolean {
  return text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("<task-");
}

/**
 * What a slash command printed, from the `local_command` entry Claude Code records it in. The
 * command's echo (`<command-name>…`) is a separate entry with no output tag, and reads as nothing.
 */
/** A command's answer is a notice, not a log: the rest of a long one stays in the terminal. */
const LOCAL_COMMAND_MAX_CHARS = 4000;

function localCommandOutput(content: unknown): string {
  if (typeof content !== "string") return "";
  // the whole entry is the output, one stream after another: a tag quoted inside an echo's
  // arguments is not an answer
  const streams: string[] = [];
  let at = 0;
  for (;;) {
    while (at < content.length && /\s/.test(content[at]!)) at++;
    if (at === content.length) break;
    const stream = content.startsWith("<local-command-stdout>", at) ? "stdout" : content.startsWith("<local-command-stderr>", at) ? "stderr" : null;
    if (stream === null) return "";
    const start = at + `<local-command-${stream}>`.length;
    // a closing tag the output prints itself ends nothing: the stream's own one is at the end of
    // the entry or before the next stream. Each candidate looks only at the whitespace after it.
    const close = `</local-command-${stream}>`;
    let end = content.indexOf(close, start);
    let next = 0;
    while (end !== -1) {
      next = end + close.length;
      while (next < content.length && /\s/.test(content[next]!)) next++;
      if (next === content.length || content.startsWith("<local-command-stdout>", next) || content.startsWith("<local-command-stderr>", next)) break;
      end = content.indexOf(close, end + close.length);
    }
    if (end === -1) return "";
    const text = stripTerminalControls(content.slice(start, end)).trim();
    if (text.length > 0) streams.push(text);
    at = next;
  }
  return capNotice(streams.join("\n"));
}

/** Lines of one notice Claude Code writes as separate entries, a moment apart. */
const NOTICE_JOIN_MS = 1000;

/** A notice Claude Code writes as plain text: no terminal codes, and not past a notice's length. */
function noticeText(raw: string): string {
  return capNotice(stripTerminalControls(raw).trim());
}

/** A notice is not a log: past the cap the rest stays in the terminal, also for lines joined into one. */
function capNotice(text: string): string {
  return text.length > LOCAL_COMMAND_MAX_CHARS ? `${text.slice(0, LOCAL_COMMAND_MAX_CHARS)}\u2026` : text;
}

/** The notice a turn is, when it is nothing else. */
function loneNotice(turn: ConversationTurn | undefined): Extract<ConversationPart, { kind: "notice" }> | null {
  const part = turn?.parts.length === 1 ? turn.parts[0] : undefined;
  return part?.kind === "notice" ? part : null;
}

/** Were these two entries written together? Never when either has no readable time. */
function writtenTogether(a: string | null | undefined, b: string | null | undefined): boolean {
  return a != null && b != null && Math.abs(Date.parse(a) - Date.parse(b)) <= NOTICE_JOIN_MS;
}

/**
 * Claude Code versions differ in where a refused command goes: a `local_command` answer, an
 * `informational` entry, and nothing says one never writes both. The same words from the other
 * kind, written together, are one answer; a notice repeating its own kind is kept.
 */
function saidByOtherKind(turn: ConversationTurn | undefined, text: string, ts: string | null, kind: "local-command" | "informational"): boolean {
  const said = loneNotice(turn);
  if (said === null || said.source === kind || (said.source !== "local-command" && said.source !== "informational")) return false;
  return writtenTogether(turn?.ts, ts) && (said.text === text || said.text.split("\n").includes(text));
}

/**
 * The text of terminal output without its escape codes (colours, links, cursor moves, charset
 * switches) and other controls, in one pass: a sequence cut off by the end swallows the rest,
 * and malformed input never makes it rescan what follows.
 */
function stripTerminalControls(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code !== 0x1b) {
      // tab and newline are text; every other C0 control and DEL is not
      if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) out += input[i];
      i++;
      continue;
    }
    const kind = input[i + 1];
    if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
      // a string (OSC, DCS, SOS, PM, APC) ends at BEL or ST; another ESC ends it too
      i += 2;
      while (i < input.length && input.charCodeAt(i) !== 0x07 && input.charCodeAt(i) !== 0x1b) i++;
      if (input.charCodeAt(i) === 0x07) i++;
      else if (input[i + 1] === "\\") i += 2;
    } else if (kind === "[") {
      // CSI: parameters, intermediates, one final byte
      i += 2;
      while (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x3f) i++;
      while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
      if (i < input.length && input.charCodeAt(i) >= 0x40 && input.charCodeAt(i) <= 0x7e) i++;
    } else {
      // ESC, intermediates (as in ESC ( B), then one final byte
      i++;
      while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
      if (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x7e) i++;
    }
  }
  return out;
}

/**
 * Claude Code wraps a long paste in `<pasted_content id="…">` tags so the model can
 * tell it from typed text; its own TUI shows only the text, and so does the chat.
 */
export function unwrapPastes(text: string): string {
  let changed = false;
  const visible = text.replace(/<pasted_content id="([^"\r\n]+)">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="([^"\r\n]+)">/g,
    (whole: string, opening: string, body: string, closing: string) => {
      if (opening !== closing || opening.length > 64 || !/^[\w-]+$/.test(opening)) return whole;
      changed = true;
      return body;
    });
  return changed ? visible.replace(/^\n+|\n+$/g, "") : text;
}

/** A parsed JSONL line's message shape (only the fields we read). */
interface TranscriptEntry {
  type?: string;
  subtype?: string;
  operation?: string;
  /** a `system` entry's own text; a message's is under `message` */
  content?: unknown;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string | null;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { role?: string; content?: unknown; stop_reason?: unknown };
  attachment?: { type?: unknown; prompt?: unknown; commandMode?: unknown; origin?: { kind?: unknown } };
}

function claudeResultText(output: unknown): string {
  return typeof output === "string" ? output
    : Array.isArray(output) ? output.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "")).join("")
      : "";
}

/** The image types a chat shows; anything else stays out of the page. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Only inline bytes are image carriers; path-only tool output stays text. */
function claudeImageSource(block: unknown): { media_type: string; data: string } | null {
  if (typeof block !== "object" || block === null) return null;
  const image = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } };
  const source = image.source;
  if (image.type !== "image" || source?.type !== "base64" || typeof source.media_type !== "string" || !IMAGE_TYPES.has(source.media_type) || typeof source.data !== "string") return null;
  return source as { media_type: string; data: string };
}

/**
 * Splits one transcript file's contents into turns. Adjacent assistant entries
 * merge into a single turn (text parts + tool parts); each tool_use is followed
 * by a user tool_result entry, which is folded into the tool part it answers.
 *
 * A subagent that ended (its `<task-notification>`) is drawn as a task_result in the user's seat,
 * once however many records carry it; `options.subagents` holds what the subagents' own files say
 * of them, by agent id, since the parser reads no files. Other notifications stay hidden.
 */
export function parseClaudeTranscript(text: string, maxTurns = MAX_TURNS, options: { subagents?: ReadonlyMap<string, SubagentDetail>; noticed?: Set<string> } = {}): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  /** tool parts still waiting for their result, by tool_use id */
  const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();
  /** the agent's last entry called a tool: its turn is not over, whatever is written meanwhile */
  let atWork = false;
  /** where a notice goes: before the turn at work it was written in, else at the end */
  const noticeAt = (): number => atWork && turns.at(-1)?.role === "assistant" ? turns.length - 1 : turns.length;
  /** the notifications already drawn: a completion is recorded in up to three places */
  const noticed = options.noticed ?? new Set<string>();
  /** True when the block was a notification (shown or not): it is no turn of anyone's typing. */
  const notified = (block: string, ts: string | null): boolean => {
    const notice = taskNotification(block);
    if (notice === null) return false;
    const key = `${notice.taskId}\0${notice.toolUseId ?? ""}`;
    if (notice.agent && !noticed.has(key)) {
      noticed.add(key);
      turns.splice(noticeAt(), 0, { role: "user", ts, parts: [{ kind: "task_result", tasks: [agentTaskResult(notice, options.subagents?.get(notice.taskId))] }] });
    }
    return true;
  };

  const assistantTurn = (ts?: string): ConversationTurn => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === "assistant") return last;
    const turn: ConversationTurn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  /** the last human prompt and the entry it hangs from: a send Claude Code cancelled before
   *  any reply is re-sent as a sibling of it, and its own screen shows only the re-send */
  let lastPrompt: { turn: ConversationTurn; parent: string | null | undefined; answered: boolean } | null = null;
  const pushPrompt = (turn: ConversationTurn, entry: TranscriptEntry): void => {
    if (lastPrompt !== null && !lastPrompt.answered && typeof entry.parentUuid === "string" && entry.parentUuid === lastPrompt.parent) {
      const index = turns.indexOf(lastPrompt.turn);
      if (index !== -1) turns.splice(index, 1);
    }
    turns.push(turn);
    lastPrompt = { turn, parent: entry.parentUuid, answered: false };
  };
  const markPromptAnswered = (): void => {
    if (lastPrompt !== null) lastPrompt.answered = true;
  };
  // another session's deliveries seen in this text, by sender and message id: an echo is no second notice
  const peersSeen = new Set<string>();

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue; // a torn tail line while Claude is mid-append
    }
    if (entry === null || typeof entry !== "object") continue;
    // another session's message: its own turn, so the work it started is not appended to the answer before it
    const peer = claudePeerNotice(entry);
    if (peer !== null) {
      const id = claudePeerId(entry);
      if (id !== null) { if (peersSeen.has(id)) continue; peersSeen.add(id); }
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [peer] });
      continue;
    }
    if (entry.isMeta) continue;
    if (isContextClear(entry, "claude-transcript")) { turns.length = 0; pending.clear(); lastPrompt = null; continue; }
    const content = entry.message?.content;
    // a compaction's summary marks where the conversation was folded, readable on request
    if (entry.isCompactSummary) {
      const summary = typeof content === "string" ? content
        : Array.isArray(content) ? content.map((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "").join("\n") : "";
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "compact", text: summary }] });
      continue;
    }

    // A message sent while Claude is working is no `user` entry: it is queued, then recorded
    // as this attachment when the turn takes it in. Background task notices and other agents'
    // messages use the same record, so only a person's prompt counts. The `queue-operation`
    // lines around a prompt repeat it; a task completion can arrive only in its enqueue.
    if (entry.type === "queue-operation" && entry.operation === "enqueue" && typeof entry.content === "string" && notified(entry.content, entry.timestamp ?? null)) continue;
    const queued = entry.type === "attachment" ? entry.attachment : undefined;
    if (queued?.commandMode === "task-notification" && typeof queued.prompt === "string" && notified(queued.prompt, entry.timestamp ?? null)) continue;
    if (queued?.type === "queued_command" && queued.commandMode === "prompt" && queued.origin?.kind === "human") {
      if (typeof queued.prompt === "string" && queued.prompt.trim() && !isCommandEntry(queued.prompt.trim())) {
        turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: unwrapPastes(queued.prompt) }] });
      }
      continue;
    }

    // A slash command answers in the terminal, not through the model: a refused /goal says why
    // only here. It is the runtime speaking in the user's seat, so it reads as a notice.
    if (entry.type === "system" && entry.subtype === "local_command") {
      const output = localCommandOutput(entry.content);
      const at = noticeAt();
      if (output.length > 0 && !saidByOtherKind(turns[at - 1], output, entry.timestamp ?? null, "local-command")) turns.splice(at, 0, { role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "notice", text: output, source: "local-command" }] });
      continue;
    }

    // Claude Code's own notices: an unknown slash command and the arguments it dropped (2.1.29x
    // writes these here, not as a local_command), a usage limit reached or reset. The message
    // that drew one is not recorded, so without it a refused command just vanished from the chat.
    // Lines written together read as one notice.
    // Claude Code also writes them while the agent works (a message another session held, a
    // stopped response): about half of the real ones. Such a notice does not end the turn: it
    // goes before the turn it was written in, so the turn stays whole and stays the last one,
    // which is what the chat reads as the turn still running.
    if (entry.type === "system" && entry.subtype === "informational") {
      const text = typeof entry.content === "string" ? noticeText(entry.content) : "";
      if (text.length === 0) continue;
      const ts = entry.timestamp ?? null;
      const at = noticeAt();
      const before = turns[at - 1];
      if (saidByOtherKind(before, text, ts, "informational")) continue;
      const said = loneNotice(before);
      if (before && said?.source === "informational" && writtenTogether(before.ts, ts)) turns[at - 1] = { ...before, parts: [{ ...said, text: capNotice(`${said.text}\n${text}`) }] };
      else turns.splice(at, 0, { role: "user", ts, parts: [{ kind: "notice", text, source: "informational" }] });
      continue;
    }

    if (entry.type === "user" && typeof content === "string") {
      if (notified(content, entry.timestamp ?? null)) continue;
      if (isCommandEntry(content)) continue;
      pushPrompt({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: unwrapPastes(content) }] }, entry);
      continue;
    }

    if (entry.type === "user" && Array.isArray(content)) {
      const prompt = content.flatMap((block: unknown) => {
        if (block === null || typeof block !== "object") return [];
        const part = block as { type?: string; text?: unknown };
        // a notice can share an entry with a tool's result
        if (part.type === "text" && typeof part.text === "string" && notified(part.text, entry.timestamp ?? null)) return [];
        return part.type === "text" && typeof part.text === "string" && !isCommandEntry(part.text.trim()) ? [part.text] : [];
      }).join("\n");
      for (const [blockIndex, block] of content.entries()) {
        if (typeof block !== "object" || block === null) continue;
        const result = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: unknown };
        if (result.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
        const tool = pending.get(result.tool_use_id);
        if (tool === undefined) continue;
        pending.delete(result.tool_use_id);
        trimOutput(tool, claudeResultText(result.content), result.tool_use_id);
        if (typeof entry.uuid === "string" && Array.isArray(result.content)) {
          const images = result.content.flatMap((block: unknown, nestedIndex: number) => {
            const ref = `${entry.uuid}:${blockIndex}:${nestedIndex}`;
            const source = claudeImageSource(block);
            return source !== null && IMAGE_REF.test(ref) ? [{ media_type: source.media_type, ref }] : [];
          });
          if (images.length > 0) tool.images = images;
        }
        if (result.is_error === true) tool.error = true;
        if (tool.skill) tool.skill.status = result.is_error === true ? "failed" : "loaded";
      }
      // an image pasted into the prompt: named here, fetched only when shown
      const images: ConversationPart[] = typeof entry.uuid !== "string" ? [] : content.flatMap((block: unknown, index: number) => {
        const source = claudeImageSource(block);
        const ref = `${entry.uuid}:${index}`;
        return source !== null && IMAGE_REF.test(ref) ? [{ kind: "image" as const, media_type: source.media_type, ref }] : [];
      });
      if (prompt.trim() || images.length > 0) pushPrompt({ role: "user", ts: entry.timestamp ?? null, parts: [...images, ...(prompt.trim() ? [{ kind: "text" as const, text: unwrapPastes(prompt) }] : [])] }, entry);
      continue;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      markPromptAnswered();
      const turn = assistantTurn(entry.timestamp);
      // an entry that names no stop reason is still at work when it calls a tool
      const stop = entry.message?.stop_reason;
      atWork = stop === "tool_use" || (stop == null && content.some((block: unknown) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_use"));
      if (entry.timestamp) turn.end_ts = entry.timestamp;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text });
        } else if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          const input = (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>;
          const part: Extract<ConversationPart, { kind: "tool" }> = {
            kind: "tool",
            name: b.name,
            summary: toolSummary(b.name, input),
            input: JSON.stringify(input, null, 2),
            output: "",
          };
          const skill = invokedSkill(b.name, input);
          if (skill) { part.skill = skill; part.summary = skill.name; }
          turn.parts.push(part);
          pending.set(String((block as { id?: unknown }).id ?? ""), part);
        }
        // unsupported transcript blocks are intentionally ignored
      }
    }
  }

  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}

/** Read sessions by source and canonical path (Claude uses its unique session id): a removed file is not unwritten. */
const writtenSessions = new Set<string>();

/** Re-parse on file changes, including replacement and same-size rewrites. */
const cache = new Map<string, { signature: string; turns: ConversationTurn[]; metadata: ConversationMetadata; cursor: string | null; abandoned?: { count: number; branches: number; summary: string | null } }>();

export class ConversationUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ConversationUnavailable";
  }
}

/** The pane's agent holds a session it has not written yet: a conversation with no turns, not a missing one. */
export class ConversationNotStarted extends ConversationUnavailable {
  constructor(readonly sessionId: string, readonly source: RecognizedConversation["source"] = "omo-transcript", readonly identity: string = sessionId) {
    super("session_not_written");
    this.name = "ConversationNotStarted";
  }
}

/** A cursor from another transcript: the pane started a new session, or a Codex backtrack replaced the file. */
export class HistoryChanged extends Error {
  constructor() {
    super("the conversation's transcript changed; reload it from its newest turns");
    this.name = "HistoryChanged";
  }
}

/** What paneConversation resolved: which store the turns came from, and where they start. */
export type RecognizedConversation = {
  activity?: "thinking" | "working" | "idle";
  source: "grok-transcript" | "agy-transcript" | "claude-transcript" | "omp-transcript" | "omo-transcript" | "gjc-transcript" | "pi-transcript" | "codex-transcript" | "devin-transcript" | "opencode-transcript" | "hermes-transcript";
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  /** the first turn's position, for the page before it; null at the conversation's beginning */
  cursor: string | null;
  /**
   * Turns the file holds on paths a `/tree` walked away from, which no page of this conversation
   * can reach; absent for every agent that keeps no entry tree. pi moves its leaf without writing
   * anything, so the chat would otherwise drop those turns with no sign they were ever there.
   */
  abandoned?: { count: number; branches: number; summary: string | null };
  history_id: string;
  /** changes whenever the answer could: the route's ETag, so an unchanged poll costs no body */
  version: string;
};

/** The stores read as one append-only file: OpenCode's and Devin's databases are paged by opencode.ts and devin.ts. */
type StreamSource = Exclude<RecognizedConversation["source"], "opencode-transcript" | "devin-transcript" | "hermes-transcript">;

/** A restart may parse the same files differently: its answers never match an earlier ETag. */
const PROCESS_VERSION = randomUUID();

export function answerVersion(key: string, signature: string): string {
  return createHash("sha256").update(`${PROCESS_VERSION}\0${key}\0${signature}`).digest("base64url").slice(0, 22);
}

/**
 * Which turns: without `before`, the newest page (with `from`, from that held start
 * while it is still inside the newest page); with `before`, the page ending there,
 * never reaching back past `since`.
 */
export type ConversationPage = { before?: string; since?: string; from?: string };

/**
 * A transcript as one byte stream: for a paginated Codex rollout the history it
 * continues comes first (codexHistorySegments). Transcripts only grow at the end,
 * so a position in it keeps naming the same turn for as long as the file does.
 */
interface TranscriptStream {
  /** the live file's identity: cursors from any other file are refused */
  id: string;
  /** `offset` is where the segment starts in its file: equal to `start` for a whole prefix */
  files: { path: string; start: number; length: number; offset: number }[];
  length: number;
  floor: number;
  promptStarts?: number[];
  fd?: number;
}

// In-place rewrites keep the inode. Change the cursor generation when observed,
// invalidating settled turns and incremental parsers as well as the response cache.
const transcriptRevisions = new Map<string, { identity: string; size: number; changed: string; generation: string }>();
function transcriptGeneration(path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  const identity = `${stat.dev}:${stat.ino}`;
  const changed = `${stat.mtimeMs}:${stat.ctimeMs}`;
  const previous = transcriptRevisions.get(path);
  const rewritten = previous && previous.identity === identity && (stat.size < previous.size || (stat.size === previous.size && changed !== previous.changed));
  const generation = rewritten ? randomUUID() : previous?.identity === identity ? previous.generation : "";
  remember(transcriptRevisions, path, { identity, size: stat.size, changed, generation }, 64);
  return generation ? `-${generation}` : "";
}

function transcriptStream(source: StreamSource, path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, codexHome: string, agy?: AgyProjection, fd?: number): TranscriptStream {
  // (a chain whose parent was archived since comes back shorter: codexHistorySegments;
  // a pi branch skips the side paths a /tree left behind: piBranchSegments)
  const grok = source === "grok-transcript" ? grokProjection(path, stat) : null;
  const branch = source === "pi-transcript" ? piBranchSegments(path, stat.size) : null;
  if (source === "pi-transcript" && branch === null) throw new ConversationUnavailable("branch_unreadable");
  const segments: { path: string; start: number; end: number }[] = source === "codex-transcript"
    ? codexHistorySegments(path, codexHome).map((segment) => ({ path: segment.path, start: 0, end: segment.end }))
    : grok !== null ? grok.segments.map((segment) => ({ path, ...segment }))
    : agy ? agy.segments.map((segment) => ({ path, ...segment }))
    : branch !== null ? branch.map((segment) => ({ path, start: segment.start, end: segment.end }))
    : [{ path, start: 0, end: stat.size }];
  const files: TranscriptStream["files"] = [];
  let stream = 0;
  for (const segment of segments) {
    // the live file is read to the size it had when it was identified
    const end = segment.path === path ? Math.min(segment.end, stat.size) : segment.end;
    const length = end - segment.start;
    if (length <= 0) continue;
    files.push({ path: segment.path, start: stream, length, offset: segment.start });
    stream += length;
  }
  // Positions count from the start of the whole chain: a cursor names the live file AND
  // the rollouts before it, so one read against another chain (an earlier rollout found
  // later, a parent since archived) answers 409 instead of pointing at other turns.
  // A pi branch is laid out from one file, so its layout stands in for that chain: /tree
  // moves the conversation to other bytes while the file, its inode and its size all stay
  // put. Every range counts by where it starts, and by where it ends too except the last:
  // the last one grows with every append, and history_id must stay stable across appends.
  // Two /tree moves away from the same entry share their head ranges and differ only
  // where their tails begin, so the last range's start is what tells them apart.
  let chain = "";
  if (grok !== null) {
    chain = `-grok-${createHash("sha256").update(path).digest("base64url").slice(0, 10)}-${grok.revision}`;
  } else if (agy) {
    chain = `-agy-${agy.revision}`;
  } else if (branch !== null) {
    const layout = files.map((file, at) => (at === files.length - 1 ? `${file.offset}` : `${file.offset}\0${file.length}`)).join("\n");
    chain = `-${createHash("sha256").update(layout).digest("base64url").slice(0, 10)}`;
  } else if (source === "codex-transcript") {
    const earlier = files.slice(0, -1).map((file) => {
      const identity = statSync(file.path, { throwIfNoEntry: false });
      return `${file.path}\0${file.length}\0${identity ? `${identity.dev}:${identity.ino}` : "-"}`;
    });
    chain = earlier.length === 0 ? "" : `-${createHash("sha256").update(earlier.join("\n")).digest("base64url").slice(0, 10)}`;
  }
  return { id: `${stat.dev.toString(36)}-${stat.ino.toString(36)}${chain}${transcriptGeneration(path, stat)}`, files, length: stream, floor: 0, promptStarts: grok?.promptStarts ?? agy?.promptStarts, fd };
}

function readStream(stream: TranscriptStream, from: number, to: number): Buffer {
  const chunks: Buffer[] = [];
  for (const file of stream.files) {
    const low = Math.max(from, file.start);
    const high = Math.min(to, file.start + file.length);
    if (low >= high) continue;
    const fd = stream.fd ?? openSync(file.path, "r");
    try {
      const buffer = Buffer.alloc(high - low);
      chunks.push(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, file.offset + (low - file.start))));
    } finally {
      if (stream.fd === undefined) closeSync(fd);
    }
  }
  return Buffer.concat(chunks);
}

/** Reset markers are small native control records. Scan each appended byte once,
 * in bounded chunks; retain offsets, never a session-sized string.
 * The same pass keeps an omp-family transcript's latest model and thinking-level
 * records (small lines): a change between the metadata head and the newest page
 * is otherwise never read, and the chat showed the level the session started at. */
const SETTING_TYPES = ['"model_change"', '"thinking_level_change"'];
const clearScans = new Map<string, { id: string; scanned: number; floor: number; tail: string; settings: Partial<Record<"model_change" | "thinking_level_change", { offset: number; end: number; line: string }>> }>();
function applyHistoryBoundary(path: string, stream: TranscriptStream, source: RecognizedConversation["source"]): void {
  if (source === "codex-transcript" || source === "grok-transcript" || source === "agy-transcript") return;
  let scan = clearScans.get(path);
  if (!scan || scan.id !== stream.id || scan.scanned > stream.length || bytesBefore(stream, scan.scanned) !== scan.tail) {
    scan = { id: stream.id, scanned: 0, floor: 0, tail: "", settings: {} };
  }
  let position = scan.scanned;
  let carry = Buffer.alloc(0);
  let skipping = false;
  const isClear = (line: Buffer): boolean => {
    if (!line.includes(source === "claude-transcript" ? "/clear" : "context_clear")) return false;
    try { return isContextClear(JSON.parse(line.toString("utf8")), source); } catch { return false; }
  };
  while (position < stream.length) {
    const end = Math.min(stream.length, position + TRANSCRIPT_WINDOW_BYTES);
    const bytes = Buffer.concat([carry, readStream(stream, position, end)]);
    const base = position - carry.length;
    let offset = 0;
    for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, offset)) {
      const line = bytes.subarray(offset, newline);
      if (!skipping && isClear(line)) scan.floor = base + offset;
      else if (!skipping && source !== "claude-transcript" && SETTING_TYPES.some((type) => line.includes(type))) {
        try {
          const type: unknown = JSON.parse(line.toString("utf8"))?.type;
          if (type === "model_change" || type === "thinking_level_change") scan.settings[type] = { offset: base + offset, end: base + newline, line: line.toString("utf8") };
        } catch { /* not a record */ }
      }
      skipping = false;
      offset = newline + 1;
      scan.scanned = base + offset;
    }
    carry = bytes.subarray(offset);
    // An oversized data record cannot be a native clear control envelope.
    if (carry.length > METADATA_HEAD_BYTES) { carry = Buffer.alloc(0); skipping = true; }
    position = end;
  }
  scan.tail = bytesBefore(stream, scan.scanned);
  remember(clearScans, path, scan, 32);
  // A valid final JSON object is visible before its newline; rescan it on append.
  stream.floor = !skipping && carry.length > 0 && isClear(carry) ? stream.length - carry.length : scan.floor;
  if (stream.floor > 0) stream.id += `-clear-${stream.floor.toString(36)}`;
}

/** Bytes that every line opening a turn contains: a cheap filter before JSON.parse. */
/** the mark of another session's message in a Claude record, in either of its forms (claudePeerNotice) */
const PEER_MARK = Buffer.from('"kind":"peer"');
const TURN_MARK: Record<StreamSource, Buffer> = {
  "grok-transcript": Buffer.from('"user_message_chunk"'),
  "agy-transcript": Buffer.from('"USER_INPUT"'),
  "codex-transcript": Buffer.from('"task_started"'),
  "claude-transcript": Buffer.from('"user"'),
  "omp-transcript": Buffer.from('"user"'),
  "omo-transcript": Buffer.from('"user"'),
  "gjc-transcript": Buffer.from('"user"'),
  "pi-transcript": Buffer.from('"user"'),
};

/**
 * Does this line open a turn? Pages start at such lines, so a page never splits
 * a turn: a Codex task (its prompt, duplicate records and tool calls all follow
 * task_started), a Claude or omp prompt (tool results answer the turn before it),
 * and the same for pi, whose prompts are `message` records with a user role.
 */
function opensTurn(source: StreamSource, line: string): boolean {
  let entry: { type?: unknown; uuid?: unknown; isMeta?: unknown; isCompactSummary?: unknown; payload?: { type?: unknown }; message?: { role?: unknown; content?: unknown } };
  try { entry = JSON.parse(line); } catch { return false; }
  if (entry === null || typeof entry !== "object") return false;
  if (source === "codex-transcript") return entry.type === "event_msg" && entry.payload?.type === "task_started";
  if (source !== "claude-transcript") {
    const message = piMessage(entry);
    return message?.role === "user" && ((message.content as Record<string, unknown>[]).some((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0)
      || piUserImageParts(entry, message).length > 0);
  }
  // another session's message opens a turn in either of its forms, the meta entry and the queued attachment
  if (claudePeerNotice(entry) !== null) return true;
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return !isCommandEntry(content);
  return Array.isArray(content) && content.some((block: { type?: unknown; text?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } } | null, index: number) =>
    (block?.type === "text" && typeof block.text === "string" && !isCommandEntry(block.text.trim()))
    || (block?.type === "image" && block.source?.type === "base64" && typeof block.source.media_type === "string"
      && IMAGE_TYPES.has(block.source.media_type) && typeof block.source.data === "string"
      && typeof entry.uuid === "string" && IMAGE_REF.test(`${entry.uuid}:${index}`)));
}

/**
 * Where the last turn-opening Claude prompt hangs, and whether an assistant entry has
 * answered it since. A prompt Claude Code cancelled before any reply is written again as
 * the re-send's sibling (same parentUuid): it continues the cancelled prompt's turn rather
 * than opening a new one, so the cancelled record never settles into a page that reparses
 * without it — the same sibling rule parseClaudeTranscript applies to the bytes.
 */
interface PromptChain { parent: string | null; answered: boolean }

function turnStarts(bytes: Buffer, source: StreamSource, chain: PromptChain = { parent: null, answered: true }): number[] {
  const starts: number[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    if (source === "claude-transcript" && line.includes('"type":"assistant"')) chain.answered = true;
    // a queued attachment carrying another session's message has no "user" in it: its own mark
    const candidate = line.includes(TURN_MARK[source]) || (source === "claude-transcript" && line.includes(PEER_MARK));
    if (candidate && opensTurn(source, line.toString("utf8"))) {
      if (source === "claude-transcript") {
        let parent: string | null = null;
        let peer = false;
        try {
          const entry = JSON.parse(line.toString("utf8")) as TranscriptEntry | null;
          const uuid: unknown = entry?.parentUuid;
          parent = typeof uuid === "string" ? uuid : null;
          peer = claudePeerNotice(entry) !== null;
        } catch { /* opensTurn already read the line as JSON */ }
        // another session's message is never a re-send of this session's prompt: it opens a turn and
        // leaves the prompt chain as it was, so the human re-send rule below still sees its own prompts
        if (peer) { starts.push(offset); offset = end + 1; continue; }
        // a re-send of an unanswered prompt opens no turn of its own
        if (chain.answered || parent === null || parent !== chain.parent) starts.push(offset);
        chain.parent = parent;
        chain.answered = false;
      } else {
        starts.push(offset);
      }
    }
    offset = end + 1;
  }
  return starts;
}

/**
 * The page of turns ending at `to`: at most MAX_PAGE_PROMPTS prompts, starting on a
 * line that opens a turn, at `floor` (a held start) or at the very beginning. An
 * older page is read once, so for a turn longer than a window it reaches further
 * back, a new chunk at a time, up to MAX_PAGE_BYTES. The newest page is read on
 * every append, so it never does: with no turn start in its window it starts
 * mid-turn, at a whole line.
 */
function pageBefore(stream: TranscriptStream, source: StreamSource, to: number, { floor = stream.floor, widen }: { floor?: number; widen: boolean }): { start: number; bytes: Buffer } {
  let from = Math.max(floor, to - TRANSCRIPT_WINDOW_BYTES);
  let bytes = readStream(stream, from, to);
  for (;;) {
    const starts = stream.promptStarts ? stream.promptStarts.filter((at) => at >= from && at < to).map((at) => at - from) : turnStarts(bytes, source);
    const keep = starts.length > MAX_PAGE_PROMPTS ? starts[starts.length - MAX_PAGE_PROMPTS] : from === floor ? 0 : starts[0];
    if (keep !== undefined) return { start: from + keep, bytes: bytes.subarray(keep) };
    if (!widen || to - from >= MAX_PAGE_BYTES) {
      const firstLine = bytes.indexOf(0x0a) + 1;
      return { start: from + firstLine, bytes: bytes.subarray(firstLine) };
    }
    const next = Math.max(floor, from - TRANSCRIPT_WINDOW_BYTES);
    bytes = Buffer.concat([readStream(stream, next, from), bytes]);
    from = next;
  }
}

/**
 * The newest page is read again after each transcript change while an agent works (at most
 * every 2 s per chat), and between reads its file only grows. Rescanning its whole window
 * (16 MB on a long session) and reparsing the page each time held the event loop 50-110 ms
 * per read, so per live file:
 * - the turn starts found so far are kept, and only the bytes appended since are scanned;
 * - the turns before the page's last turn start are kept (a later append cannot change a
 *   turn that another has followed), and only the last turn is parsed again.
 */
interface LiveScan {
  id: string;
  source: StreamSource;
  /** complete lines up to here are scanned */
  scanned: number;
  /** turn starts in the scanned bytes, ascending, none before the window */
  starts: number[];
  /** the bytes just before `scanned`: a file rewritten rather than appended to no longer has them */
  tail: string;
  /** the prompt chain the scanned lines end on, which the next appended lines continue */
  chain: PromptChain;
}
const liveScans = new Map<string, LiveScan>();

interface SettledTurns {
  id: string;
  /** the page start these turns begin at, and the turn start they end at */
  start: number;
  end: number;
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  /** the bytes just before `end` (see LiveScan.tail) */
  tail: string;
  /** what OmO's `task` calls on the page called their tasks: a task can end in a later turn than the one that started it */
  taskTitles: Map<string, string>;
  /** Claude completion identities in this page's settled prefix only; never inherited from another page. */
  noticed: Set<string>;
  /** the titles it began with, from the pages before it */
  inherited: Map<string, string>;
  /** End of the live turn the last poll actually read; replay never scans unseen skipped history. */
  observedEnd: number;
}
const settledTurns = new Map<string, SettledTurns>();

function bytesBefore(stream: TranscriptStream, offset: number): string {
  return readStream(stream, Math.max(0, offset - 64), offset).toString("latin1");
}

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/**
 * What a pane's chat has read, so its parsed state can be released when the pane closes.
 *
 * Every cache below is keyed by file, not by pane, and a bridge runs for weeks: without
 * this, everything a pane ever read stays for the life of the process. The release is by
 * path (and by the written-session key), which is what the maps are keyed by, and each
 * reader keeps its own bound so an entry that outlives its pane is still capped.
 */
interface DevinPaneRead { sessionId: string; cwd: string; dbPath?: string }
interface PaneReads { paths: Set<string>; sessions: Set<string>; devin: Map<string, DevinPaneRead> }
const paneReads = new Map<string, PaneReads>();
/** panes remembered; past this a pane that closed long ago is the one whose release is lost */
const PANE_READS_MAX = 128;

function emptyPaneReads(): PaneReads { return { paths: new Set<string>(), sessions: new Set<string>(), devin: new Map<string, DevinPaneRead>() }; }

function rememberPaneRead(paneId: string, path: string): void {
  const reads = paneReads.get(paneId) ?? emptyPaneReads();
  reads.paths.add(path);
  remember(paneReads, paneId, reads, PANE_READS_MAX);
}

function rememberPaneSession(paneId: string, session: string): void {
  const reads = paneReads.get(paneId) ?? emptyPaneReads();
  reads.sessions.add(session);
  remember(paneReads, paneId, reads, PANE_READS_MAX);
}

function rememberPaneDevin(paneId: string, sessionId: string, cwd: string, dbPath?: string): void {
  const reads = paneReads.get(paneId) ?? emptyPaneReads();
  const key = JSON.stringify([dbPath ?? defaultDevinDbPath(), sessionId, cwd]);
  reads.devin.set(key, { sessionId, cwd, dbPath });
  remember(paneReads, paneId, reads, PANE_READS_MAX);
}

/** The newest page's start and every turn start in it (pageBefore without widening), or null when it starts mid-turn. */
function newestPage(path: string, stream: TranscriptStream, source: StreamSource): { start: number; starts: number[] } | null {
  const from = Math.max(stream.floor, stream.length - TRANSCRIPT_WINDOW_BYTES);
  if (stream.promptStarts) {
    const starts = stream.promptStarts.filter((at) => at >= from);
    const start = starts.length > MAX_PAGE_PROMPTS ? starts[starts.length - MAX_PAGE_PROMPTS] : from === stream.floor ? stream.floor : starts[0];
    return start === undefined ? null : { start, starts };
  }
  let scan = liveScans.get(path);
  // a window that slid past the scanned bytes starts over at its edge (a line may be cut
  // there, as in pageBefore, and never counts as a start)
  if (!scan || scan.id !== stream.id || scan.source !== source || scan.scanned > stream.length || scan.scanned < from
    || bytesBefore(stream, scan.scanned) !== scan.tail) {
    scan = { id: stream.id, source, scanned: from, starts: [], tail: bytesBefore(stream, from), chain: { parent: null, answered: true } };
  }
  let pending: number[] = [];
  if (scan.scanned < stream.length) {
    const bytes = readStream(stream, scan.scanned, stream.length);
    const complete = bytes.lastIndexOf(0x0a) + 1;
    for (const offset of turnStarts(bytes.subarray(0, complete), source, scan.chain)) scan.starts.push(scan.scanned + offset);
    // a last line still without its newline counts now, and is scanned again once
    // complete, so it is scanned on a copy that leaves the kept chain untouched
    pending = turnStarts(bytes.subarray(complete), source, { ...scan.chain }).map((offset) => scan!.scanned + complete + offset);
    scan.scanned += complete;
    scan.tail = bytesBefore(stream, scan.scanned);
  }
  const stale = scan.starts.findIndex((offset) => offset >= from);
  if (stale !== 0) scan.starts.splice(0, stale === -1 ? scan.starts.length : stale);
  remember(liveScans, path, scan, 32);
  const starts = pending.length > 0 ? [...scan.starts, ...pending] : scan.starts;
  const start = starts.length > MAX_PAGE_PROMPTS ? starts[starts.length - MAX_PAGE_PROMPTS] : from === stream.floor ? stream.floor : starts[0];
  return start === undefined ? null : { start, starts };
}

/** What the meta files of the subagents a Claude page's notifications name say of them: read only when the page has one. */
function subagentsOnPage(path: string, text: string): ReadonlyMap<string, SubagentDetail> | undefined {
  if (!text.includes("<task-notification>")) return undefined;
  // ids come from notifications only: other text on the page (a fetched web page) can hold the tag too
  const ids = new Set<string>();
  for (const line of text.split("\n")) for (const notice of lineNotifications(line)) if (notice.agent) ids.add(notice.taskId);
  return ids.size === 0 ? undefined : subagentDetails(path, ids);
}

function parseTurns(source: RecognizedConversation["source"], path: string, text: string, taskTitles?: Map<string, string>, noticed?: Set<string>): ConversationTurn[] {
  if (source === "grok-transcript") {
    try { return parseGrokTranscript(text, path); } catch (error) {
      if (error instanceof GrokUnavailable) throw new ConversationUnavailable("transcript_missing");
      throw error;
    }
  }
  if (source === "agy-transcript") return parseAgyTranscript(text, path);
  return source === "codex-transcript" ? parseCodexTranscript(text, Infinity)
    : source === "claude-transcript" ? parseClaudeTranscript(text, Infinity, { subagents: subagentsOnPage(path, text), noticed })
      : parseOmpTranscript(text, Infinity, { toolImages: true, taskTitles });
}

interface LiveCodexTurn {
  id: string;
  start: number;
  scanned: number;
  boundary: string;
  parser: ReturnType<typeof createCodexTranscriptParser>;
  metadata: ConversationMetadata;
}
const codexTurns = new Map<string, LiveCodexTurn>();

/** Incremental within a long Codex task, including results for tools from earlier polls. */
function codexLiveTurn(path: string, stream: TranscriptStream, start: number, before: ConversationMetadata): { turns: ConversationTurn[]; metadata: ConversationMetadata } {
  let cached = codexTurns.get(path);
  if (!cached || cached.id !== stream.id || cached.start !== start || cached.scanned > stream.length
    || bytesBefore(stream, cached.scanned) !== cached.boundary) {
    cached = { id: stream.id, start, scanned: start, boundary: bytesBefore(stream, start), parser: createCodexTranscriptParser(), metadata: before };
  }
  const bytes = readStream(stream, cached.scanned, stream.length);
  const complete = bytes.lastIndexOf(0x0a) + 1;
  if (complete > 0) {
    const text = bytes.subarray(0, complete).toString("utf8");
    cached.parser.write(text);
    cached.metadata = parseConversationMetadata(text, "codex-transcript", cached.metadata);
    cached.scanned += complete;
    cached.boundary = bytesBefore(stream, cached.scanned);
  }
  const tail = bytes.subarray(complete).toString("utf8");
  // Both record count and retained source bytes are bounded, independent of session length.
  remember(codexTurns, path, cached, 8);
  let retained = [...codexTurns.values()].reduce((sum, turn) => sum + turn.scanned - turn.start, 0);
  for (const [key, turn] of codexTurns) {
    if (retained <= 2 * TRANSCRIPT_WINDOW_BYTES) break;
    codexTurns.delete(key);
    retained -= turn.scanned - turn.start;
  }
  return { turns: cached.parser.snapshot(tail), metadata: parseConversationMetadata(tail, "codex-transcript", cached.metadata) };
}

/** Codex settings belong to the live rollout; native clears bound other stores. A model or
 * thinking-level change after the head and before the page follows the head, in order. */
function metadataHead(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], start: number): string {
  if (source === "codex-transcript") return readRange(path, 0, METADATA_HEAD_BYTES);
  const end = Math.min(start, stream.floor + METADATA_HEAD_BYTES);
  const later = Object.values(clearScans.get(path)?.settings ?? {})
    // a record the head cuts in two is read whole here
    .filter((setting) => setting.end > end && setting.offset < start)
    .sort((a, b) => a.offset - b.offset)
    .map((setting) => setting.line);
  return [readStream(stream, stream.floor, end).toString("utf8"), ...later].join("\n");
}

/**
 * The newest page's turns from `start`: the settled ones (before the last turn start)
 * from memory, extended by any turn that has since been followed, plus the live last turn.
 */
function liveTurns(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], start: number, starts: number[]): { turns: ConversationTurn[]; metadata: ConversationMetadata } {
  // starts ascend: the last one, when it lies past the page start
  const last = Math.max(start, starts[starts.length - 1] ?? start);
  const key = `${path}\0${start}`;
  let settled = settledTurns.get(key);
  if (!settled || settled.id !== stream.id || settled.end > last || bytesBefore(stream, settled.end) !== settled.tail) {
    const head = start > stream.floor ? metadataHead(path, stream, source, start) : "";
    // a page that starts past the turn that started a task keeps the title that turn gave it,
    // as long as this stream was watched while the title was on a page (a cold read cannot).
    // Only this file's pages count: another file can come to have its inode once it is gone.
    let kept: SettledTurns | undefined;
    for (const [other, page] of settledTurns) {
      if (other.startsWith(`${path}\0`) && page.id === stream.id && page.start < start && page.start > (kept?.start ?? -1)) kept = page;
    }
    const inherited = new Map(kept === undefined ? [] : kept.end <= start ? kept.taskTitles : kept.inherited);
    // Replay the overlap, or the previously seen live turn when many prompts arrived between
    // polls. Only bytes already observed are needed, even if the file grew by gigabytes since.
    if (kept !== undefined) {
      const from = kept.end <= start ? kept.end : kept.start;
      const to = Math.min(start, kept.observedEnd);
      if (to > from) parseTurns(source, path, readStream(stream, from, to).toString("utf8"), inherited);
    }
    settled = { id: stream.id, start, end: start, turns: [], metadata: parseConversationMetadata(`${head}\n`, source), tail: bytesBefore(stream, start), taskTitles: new Map(inherited), noticed: new Set(), inherited, observedEnd: stream.length };
  }
  if (settled.end < last) {
    const text = readStream(stream, settled.end, last).toString("utf8");
    settled = { ...settled, end: last, turns: [...settled.turns, ...parseTurns(source, path, text, settled.taskTitles, settled.noticed)], metadata: parseConversationMetadata(text, source, settled.metadata), tail: bytesBefore(stream, last) };
  }
  settled.observedEnd = stream.length;
  remember(settledTurns, key, settled, 8);
  if (source === "codex-transcript") {
    const live = codexLiveTurn(path, stream, last, settled.metadata);
    return { turns: [...settled.turns, ...live.turns], metadata: live.metadata };
  }
  const text = readStream(stream, last, stream.length).toString("utf8");
  // the live turn is parsed again on every poll: its titles and completions are kept only
  // once it settles, so a read titles a task exactly as a cold read of the same bytes does
  return { turns: [...settled.turns, ...parseTurns(source, path, text, new Map(settled.taskTitles), new Set(settled.noticed))], metadata: parseConversationMetadata(text, source, settled.metadata) };
}

/** Forget every scan and parse kept between polls (tests compare against a cold read). */
export function forgetTranscriptState(): void {
  launchedAgents.clear();
  cache.clear();
  writtenSessions.clear();
  forgetClaudeSessions();
  forgetGjcState();
  forgetSubagents();
  forgetOpencodeState();
  liveScans.clear();
  settledTurns.clear();
  codexTurns.clear();
  transcriptRevisions.clear();
  clearScans.clear();
  paneReads.clear();
  forgetAllCodexState();
  forgetCodexImageState();
  forgetAllPiIndexes();
  forgetGrokState();
  forgetAgyState();
  forgetDevinState();
  forgetHermesTranscriptState();
}

/**
 * Drop everything one pane's chat parsed, the caches here and in the readers below.
 *
 * The maps are keyed by file, so the pane is remembered against what it read
 * (`rememberPaneRead`). Every delete is a memo of a file that still exists: the next read
 * of a live pane re-derives it, and a file nobody reads again costs nothing to forget.
 */
export function forgetPaneTranscriptState(paneId: string): void {
  const reads = paneReads.get(paneId);
  paneReads.delete(paneId);
  launchedAgents.forget(paneId);
  forgetGjcPane(paneId);
  if (reads === undefined) return;
  // two panes can read one transcript (a resumed session, a shared store): what another pane
  // still reads stays
  const shared = (pick: (other: PaneReads) => Set<string>, value: string): boolean => [...paneReads.values()].some((other) => pick(other).has(value));
  for (const session of reads.sessions) if (!shared((other) => other.sessions, session)) writtenSessions.delete(session);
  for (const [key, session] of reads.devin) {
    if (![...paneReads.values()].some((other) => other.devin.has(key))) forgetDevinState(session.sessionId, session.cwd, session.dbPath);
  }
  for (const path of reads.paths) {
    if (shared((other) => other.paths, path)) continue;
    for (const key of [...cache.keys()]) if (key.startsWith(`${path}\0`)) cache.delete(key);
    transcriptRevisions.delete(path);
    liveScans.delete(path);
    for (const key of [...settledTurns.keys()]) if (key.startsWith(`${path}\0`)) settledTurns.delete(key);
    codexTurns.delete(path);
    clearScans.delete(path);
    forgetCodexStateFor(path);
    forgetPiIndex(path);
    forgetGrokState(path);
    forgetAgyState(path);
    forgetClaudeSessionFile(path);
    forgetOpencodeRead(path);
    forgetHermesTranscriptState(path);
  }
}

function formatCursor(stream: TranscriptStream, offset: number): string | null {
  return offset > stream.floor ? `${stream.id}:${offset}` : null;
}

function parseCursor(stream: TranscriptStream, cursor: string): number {
  const separator = cursor.lastIndexOf(":");
  const offset = Number(cursor.slice(separator + 1));
  if (separator <= 0 || cursor.slice(0, separator) !== stream.id || !Number.isSafeInteger(offset) || offset < stream.floor || offset > stream.length) {
    throw new HistoryChanged();
  }
  return offset;
}

/** gjc's resolver answers null; the chat lens reports why it fell back to scrollback. */
export async function gjcTranscriptPath(paneId: string, cwd: string, home?: string): Promise<string> {
  const path = await gjcTranscriptForPane(paneId, cwd, home);
  if (!path) throw new ConversationUnavailable("no_session_path");
  return path;
}

/**
 * Is omo the agent in this pane, whatever herdr currently labels it? A probe
 * failure answers "no": the caller then reports why the labelled store failed,
 * which is the more useful error.
 */
export async function paneRunsOmo(paneId: string): Promise<boolean> {
  // pane.process_info wants `pane_id`; given `target` herdr answers for the
  // FOCUSED pane instead of erroring (live-verified 2026-09-21).
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: unknown }[] } }>(
    "pane.process_info",
    { pane_id: paneId },
  ).catch(() => null);
  return (info?.process_info?.foreground_processes ?? []).some((process) =>
    isOmoProcess(Array.isArray(process.argv) ? process.argv.map(String) : []),
  );
}

/**
 * herdr labels an omo pane `pi` while it waits and `claude` while omo's claude-sdk child
 * runs, so the sidebar showed another agent's mark, and one that changed as omo worked.
 * The snapshots the browser gets name such a pane `omo`, decided by its process tree
 * (paneRunsOmo), including panes herdr has not recognized as an agent.
 */
export async function labelOmoPanes(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  const candidates = snapshot.panes.filter((pane) => !pane.agent || pane.agent === "pi" || pane.agent === "claude");
  const omo = new Set<string>();
  await Promise.all(candidates.map(async (pane) => { if (await paneRunsOmo(pane.pane_id)) omo.add(pane.pane_id); }));
  if (omo.size === 0) return snapshot;
  return {
    ...snapshot,
    panes: snapshot.panes.map((pane) => omo.has(pane.pane_id) ? { ...pane, agent: "omo" } : pane),
    agents: snapshot.agents.map((agent) => omo.has(agent.pane_id) ? { ...agent, agent: "omo" } : agent),
  };
}

/** The Claude processes in a pane's foreground; none when herdr cannot say. */
async function claudeProcesses(paneId: string): Promise<{ pid: number; name?: string; argv0?: string; argv?: string[] }[]> {
  try {
    const processInfo = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; name?: string; argv0?: string; argv?: string[] }[] } }>(
      "pane.process_info", { pane_id: paneId },
    );
    return processInfo.process_info?.foreground_processes?.filter(isClaudeProcess) ?? [];
  } catch { return []; /* herdr busy: the default store */ }
}

/** The pid of the one Claude process in a pane's foreground, or null. */
export async function claudePanePid(pane: HerdrPane): Promise<number | null> {
  const processes = await claudeProcesses(pane.pane_id);
  return processes.length === 1 ? processes[0]!.pid : null;
}

/**
 * Claude's transcript: Herdr's hook, or a unique live Claude's native PID record, in the config dir
 * of the pane's Claude process (a launcher can give each environment its own CLAUDE_CONFIG_DIR).
 */
async function claudeTranscriptPath(paneId: string, cwds: readonly (string | null | undefined)[], onProcess?: (pid: number) => void): Promise<string> {
  const info = await herdrRpc<{ agent: { agent_session?: { value?: unknown } } }>("agent.get", { target: paneId });
  let session = info.agent.agent_session?.value;
  const home = process.env["HOME"] ?? "";
  const processes = await claudeProcesses(paneId);
  const only = processes.length === 1 ? processes[0] : undefined;
  if (only) onProcess?.(only.pid);
  let processDir: string | null = null;
  try {
    processDir = only ? await processClaudeConfigDir(only.pid, only.argv ?? [only.argv0 ?? only.name ?? ""], home) : null;
  } catch (error) {
    // two stores claim the process: ~/.claude would be a guess, maybe another account's session (#586)
    if (error instanceof AmbiguousClaudeStore) throw new ConversationUnavailable("no_session_id");
    throw error;
  }
  const configDir = processDir || defaultClaudeConfigDir(home);
  if ((typeof session !== "string" || !SESSION_ID.test(session)) && only) session = await claudeProcessSession(home, only.pid, configDir);
  if (typeof session !== "string" || !SESSION_ID.test(session)) throw new ConversationUnavailable("no_session_id");
  const path = await claudeTranscriptFile(home, session, cwds, configDir);
  // Claude writes the file with its first message: until then the session it reports holds nothing
  if (!path) throw new ConversationNotStarted(session, "claude-transcript");
  return path;
}

/** A Claude pane's transcript and when its Claude process started (null when it cannot be told), or null while it has no transcript. */
export async function claudePaneSession(pane: HerdrPane): Promise<{ path: string; startedAt: number | null; pid: number | null } | null> {
  let pid: number | null = null;
  try {
    const path = await claudeTranscriptPath(pane.pane_id, [pane.cwd, pane.foreground_cwd], (found) => { pid = found; });
    return { path, startedAt: pid === null ? null : processStartedAt(pid), pid };
  } catch (error) {
    if (error instanceof ConversationUnavailable) return null;
    throw error;
  }
}

/**
 * The store holding the omp session herdr reports, or null unless the path is a transcript
 * inside one of the user's own stores: ~/.omp/agent/sessions, or the one `omp --profile <name>`
 * keeps at ~/.omp/profiles/<name>/agent/sessions. A Windows PC reports it in its own form
 * (drive letter, backslashes).
 */
export function ompSessionStore(value: unknown, home: string, paths: PlatformPath = nodePath): string | null {
  if (typeof value !== "string" || !value.endsWith(".jsonl") || !paths.isAbsolute(value) || !paths.isAbsolute(home)) return null;
  const store = paths.join(home, ".omp", "agent", "sessions");
  if (storeRelative(store, value, paths)) return store;
  const profiles = paths.join(home, ".omp", "profiles");
  const parts = storeRelative(profiles, value, paths);
  if (!parts || parts.length < 4 || parts[1] !== "agent" || parts[2] !== "sessions") return null;
  return paths.join(profiles, parts[0]!, "agent", "sessions");
}

/**
 * omp's transcript: herdr hands over the absolute path, accepted only inside the user's own
 * stores. When herdr names none (or another agent's session), the pane's omp process does.
 */
async function ompTranscriptPath(paneId: string, cwd: string): Promise<string> {
  const info = await herdrRpc<{ agent: { agent_session?: { kind?: unknown; value?: unknown } } }>("agent.get", { target: paneId });
  const session = info.agent.agent_session;
  const path = session?.kind === "path" && typeof session.value === "string" ? session.value : null;
  // a Windows bridge starts with HOME set to the profile directory (remote-entry.ts)
  const store = ompSessionStore(path, process.env["HOME"] ?? "");
  if (path === null || store === null) {
    const held = await ompHeldTranscript(paneId, cwd);
    if (held === null) throw new ConversationUnavailable("no_session_path");
    return held;
  }
  // omp names its session file at start and writes it with the first answer
  const unwritten = unwrittenSession(path, store);
  if (unwritten !== null) throw new ConversationNotStarted(unwritten.id, "omp-transcript", unwritten.path);
  // the check above is lexical: a link out of the store is no transcript of this pane
  const inStore = piTranscriptInStore(path, store);
  if (inStore === null) throw new ConversationUnavailable("no_session_path");
  return inStore;
}

/** Where a pane's conversation is: a transcript file, or a session in OpenCode's database. */
type ResolvedTranscript =
  | { source: StreamSource; path: string; codexHome?: string; agy?: AgyStore }
  | { source: "opencode-transcript"; path: string; session: string }
  | { source: "hermes-transcript"; path: string; sessionId: string };

/** A native file or database session, resolved without parsing conversation turns. */
export type NativeTranscript =
  | ResolvedTranscript
  | { source: "devin-transcript"; path: string; session: string; cwd: string };

/**
 * The store a pane's transcript lives in. herdr's agent label follows the
 * pane's foreground processes, so an omo pane reads as `pi` while it waits and
 * as `claude` while its claude-sdk child runs (live-verified 2026-09-21) — the
 * label alone cannot route omo. Its process tree takes precedence over the child
 * label: omo's own store is read only when omo is really running
 * in that pane, never on a matching cwd alone.
 */
async function resolveTranscript(pane: HerdrPane, cwd: string, codexHome?: string, panes?: HerdrPane[], opencodeDb?: string, hermesHome?: string, grokHome?: string): Promise<ResolvedTranscript> {
  const paneId = pane.pane_id;
  let agent = pane.agent ?? pane.agent_session?.agent ?? "";
  // herdr names no agent for this pane: a session report an earlier agent left behind says
  // nothing about what runs now, so the pane's processes are asked before it is followed.
  // A pane herdr does label is not asked: the lookup would cost every transcript lookup an RPC (and
  // a process-table read on Windows), and a gjc below another agent would take its chat.
  if (!pane.agent) {
    const info = await herdrRpc<{ process_info?: { shell_pid?: number; foreground_processes?: { argv?: unknown }[] } }>(
      "pane.process_info", { pane_id: paneId },
    ).catch(() => null);
    const running = (info?.process_info?.foreground_processes ?? []).some((process) =>
      isGjcProcess(Array.isArray(process.argv) ? process.argv.map(String) : []),
    );
    if (running || await gjcPidUnderShell(info?.process_info?.shell_pid)) agent = "gjc";
  }
  if ((agent === "omo" || agent === "pi" || agent === "claude") && await paneRunsOmo(paneId)) {
    return { source: "omo-transcript", path: await omoTranscriptPath(paneId, cwd, panes) };
  }
  // omp and GJC can change their own cwd without changing the pane's shell directory; their
  // session headers name the one they run in
  const sessionCwd = typeof pane.foreground_cwd === "string" && pane.foreground_cwd.length > 0 ? pane.foreground_cwd : cwd;
  try {
    if (agent === "grok") {
      const found = await resolveGrokStore(pane, grokHome);
      if (!found) throw new ConversationUnavailable("no_session_path");
      return { source: "grok-transcript", path: found };
    }
    if (agent === "agy") {
      const found = await resolveAgyStore(pane);
      if (!found) throw new ConversationUnavailable("no_session_path");
      let transcriptExists: boolean;
      try { transcriptExists = !!statSync(found.path, { throwIfNoEntry: false }); }
      catch { throw new ConversationUnavailable("transcript_missing"); }
      if (!transcriptExists) {
        if (agyCatalog(found.path).size !== 0 || !sameAgyStore(found, await resolveAgyStore(pane))) throw new ConversationUnavailable("transcript_missing");
        throw new ConversationNotStarted(found.session, "agy-transcript", found.path);
      }
      return { source: "agy-transcript", path: found.path, agy: found };
    }
    if (agent === "codex") {
      // the pane's own store: the rollout, its history and its images are all read from there
      const home = await paneCodexHome(paneId, codexHome);
      const path = await codexTranscriptPath(paneId, cwd, home, panes);
      if (!path) throw new ConversationUnavailable("no_session_path");
      return { source: "codex-transcript", path, codexHome: home };
    }
    // Claude's project is the directory it started in, the process's own cwd more often than the pane's
    if (agent === "claude") return { source: "claude-transcript", path: await claudeTranscriptPath(paneId, [cwd, pane.foreground_cwd]) };
    if (agent === "omp") return { source: "omp-transcript", path: await ompTranscriptPath(paneId, sessionCwd) };
    if (agent === "gjc") return { source: "gjc-transcript", path: await gjcTranscriptPath(paneId, sessionCwd) };
    // pi's own label only routes pi: an omo pane was taken above, by its process tree.
    if (agent === "pi") {
      const found = await piTranscriptPath(paneId);
      if (found === null) throw new ConversationUnavailable("no_session_path");
      if ("unwritten" in found) throw new ConversationNotStarted(found.unwritten.id, "pi-transcript", found.unwritten.path);
      return { source: "pi-transcript", path: found.path };
    }
    if (agent === "opencode") {
      // herdr's integration names the session the TUI shows; at its home screen there is none
      const session = opencodeSessionId(pane);
      if (session === null) throw new ConversationUnavailable("no_session_id");
      const path = opencodeDb ?? opencodeDatabasePath();
      if (path === null) throw new ConversationUnavailable("no_session_path");
      return { source: "opencode-transcript", path, session };
    }
    if (agent === "hermes") {
      const resolved = await hermesTranscriptForPane(pane, cwd, hermesHome);
      return { source: "hermes-transcript", path: resolved.dbPath, sessionId: resolved.sessionId };
    }
    throw new ConversationUnavailable("no_recognized_transcript");
  } catch (error) {
    if (error instanceof AgyUnavailable) throw new ConversationUnavailable("transcript_missing");
    if (!(error instanceof ConversationUnavailable) || !(await paneRunsOmo(paneId))) throw error;
    return { source: "omo-transcript", path: await omoTranscriptPath(paneId, cwd, panes) };
  }
}

async function omoTranscriptPath(paneId: string, cwd: string, panes?: HerdrPane[]): Promise<string> {
  const session = await omoSessionForPane(paneId, cwd, panes ?? (await sessionSnapshot()).panes);
  if (session.pending !== null) throw new ConversationNotStarted(session.pending);
  if (!session.path) throw new ConversationUnavailable("no_session_path");
  return session.path;
}

/** A live Devin executable, not a command line which happens to mention one. */
export function isDevinProcess(argv: readonly string[]): boolean {
  const executable = argv[0] ?? "";
  const exact = /(?:^|[\\/])devin(?:\.exe)?$/;
  return process.platform === "win32" ? exact.test(executable.toLowerCase()) : exact.test(executable);
}

/** Resolves only a session explicitly named by this live Devin pane, never by directory contents. */
export function devinSessionForPane(pane: HerdrPane, panes: HerdrPane[], argv: string[]): string {
  if (pane.agent !== "devin") throw new ConversationUnavailable("no_session_id");
  const reported = pane.agent_session?.agent === "devin" && pane.agent_session.kind === "id"
    && typeof pane.agent_session.value === "string" && pane.agent_session.value.length > 0
    ? pane.agent_session.value : null;
  const resumed: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") break;
    if (arg.startsWith("--resume=")) {
      const id = arg.slice("--resume=".length);
      if (!id || id.startsWith("-")) throw new ConversationUnavailable("no_session_id");
      resumed.push(id);
    } else if (arg === "--resume" || arg === "-r") {
      const id = argv[index + 1];
      if (!id || id.startsWith("-")) throw new ConversationUnavailable("no_session_id");
      resumed.push(id);
      index++;
    }
  }
  const named = resumed[0] ?? null;
  if (resumed.some((id) => id !== named) || (reported !== null && named !== null && reported !== named)) {
    throw new ConversationUnavailable("no_session_id");
  }
  const explicit = reported ?? named;
  if (explicit === null) throw new ConversationUnavailable("no_session_id");
  if (panes.some((other) => other.pane_id !== pane.pane_id && other.agent === "devin"
    && other.agent_session?.agent === "devin" && other.agent_session.kind === "id" && other.agent_session.value === explicit)) {
    throw new ConversationUnavailable("no_session_id");
  }
  return explicit;
}

/** Resolve the native live file or database session without reading conversation turns. */
export async function paneTranscript(paneId: string, codexHome?: string, snapshot?: SessionSnapshot, devinDbPath?: string, opencodeDb?: string, hermesHome?: string, grokHome?: string): Promise<NativeTranscript> {
  const panes = (snapshot ?? await sessionSnapshot()).panes;
  const pane = panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined) throw new ConversationUnavailable("pane_not_found");
  if (typeof pane.cwd !== "string" || pane.cwd.length === 0) throw new ConversationUnavailable("no_recognized_transcript");

  if (pane.agent === "devin") {
    const cwd = pane.foreground_cwd || pane.cwd;
    const storePath = devinDbPath ?? defaultDevinDbPath();
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: unknown }[] } }>(
      "pane.process_info", { pane_id: paneId },
    ).catch(() => null);
    const processes = (info?.process_info?.foreground_processes ?? []).filter((process) =>
      Array.isArray(process.argv) && process.argv.every((arg) => typeof arg === "string") &&
      isDevinProcess(process.argv as string[]) && process.argv[1] !== "acp",
    );
    if (processes.length > 1) throw new ConversationUnavailable("transcript_missing");
    // No Devin runs under the label: what does run is resolved below, as it was before this
    // reader (an omo is found by its process tree, whatever herdr calls the pane).
    if (processes.length === 1) {
      const session = devinSessionForPane(pane, panes, processes[0]!.argv as string[]);
      return { source: "devin-transcript", path: storePath, session, cwd };
    }
  }

  return resolveTranscript(pane, pane.cwd, codexHome, panes, opencodeDb, hermesHome, grokHome);
}

/**
 * pane -> agent session -> transcript turns. Read-only, same-user files only.
 * Claude sessions are looked up by id under ~/.claude/projects; omp sessions
 * come from herdr or the pane's omp process (ompTranscriptPath); omo sessions are resolved from its own store by
 * process/session evidence (omoTranscriptForPane). Throws ConversationUnavailable when the pane has
 * no recognized agent store (the caller falls back to the scrollback
 * transcript view, like chatmux).
 *
 * Without `page` this is the newest page. `before` is the page ending at a
 * returned cursor; `from` is every turn after one, for a chat that already
 * shows the pages before it. A cursor from another file throws HistoryChanged.
 * `opencodeDb` is OpenCode's store, unset where OpenCode itself would find it.
 */
export async function paneConversation(paneId: string, codexHome?: string, page: ConversationPage = {}, devinDbPath?: string, opencodeDb?: string, hermesHome?: string, grokHome?: string): Promise<RecognizedConversation> {
  const snapshot = await sessionSnapshot();
  let resolved: NativeTranscript;

  // no transcript states the model yet: the agent's own screen does (start-screen.ts). A screen
  // that cannot be read leaves it unknown, as it was
  const notBegun = async (source: RecognizedConversation["source"], id: string): Promise<RecognizedConversation> => {
    const screen = readsStartScreen(source) ? await paneRead({ paneId, source: "visible", format: "text", timeoutMs: 2_000 }).then((read) => read.text, () => "") : "";
    const metadata = startScreenMetadata(source, screen);
    return { source, turns: [], metadata, cursor: null, history_id: id, version: answerVersion(id, `${metadata.model}\0${metadata.reasoning_effort}`) };
  };

  const onNotStarted = (error: ConversationNotStarted): Promise<RecognizedConversation> => {
    // a file read before and gone since is no conversation not begun: the terminal stands in for it
    if (writtenSessions.has(`${error.source}\0${error.identity}`)) throw new ConversationUnavailable("transcript_missing");
    // nothing comes before a conversation not begun: a cursor into it is another one's
    if (page.before !== undefined || page.since !== undefined || page.from !== undefined) throw new HistoryChanged();
    // an agent at work on its first turn has written nothing yet, but its terminal shows the turn
    const status = snapshot.panes.find((pane) => pane.pane_id === paneId)?.agent_status;
    if (status === "working" || status === "blocked") throw error;
    // the chat says there is nothing yet; the session's first prompt writes the file and
    // the next refresh's history_id differs, so the chat takes it whole
    return notBegun(error.source, `unwritten:${error.sessionId}`);
  };

  try {
    resolved = await paneTranscript(paneId, codexHome, snapshot, devinDbPath, opencodeDb, hermesHome, grokHome);
    launchedAgents.forget(paneId);
  } catch (error) {
    if (error instanceof ConversationNotStarted) { launchedAgents.forget(paneId); return await onNotStarted(error); }
    if (!(error instanceof ConversationUnavailable)) throw error;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
    if (pane === undefined) { launchedAgents.forget(paneId); throw error; }
    // an agent this server started writes no session before its first message (launched-agents.ts)
    const launch = launchedAgents.notBegun(paneId, pane.agent_status);
    if (launch === null) throw error;
    if (page.before !== undefined || page.since !== undefined || page.from !== undefined) throw new HistoryChanged();
    return await notBegun(launch.source, launch.historyId);
  }
  if (resolved.source === "devin-transcript") {
    try {
      const answer = devinConversation(resolved.session, resolved.cwd, page, resolved.path);
      rememberPaneDevin(paneId, resolved.session, resolved.cwd, resolved.path);
      return answer;
    } catch (error) {
      if (error instanceof DevinHistoryUnavailable) throw new ConversationUnavailable("transcript_missing");
      throw error;
    }
  }
  if (resolved.source === "opencode-transcript") {
    // its caches are keyed by store and session, which is what the pane is remembered against
    rememberPaneRead(paneId, opencodeReadKey(resolved.path, resolved.session));
    const answer = opencodeConversation(resolved.path, resolved.session, page);
    if (answer.kind === "history_changed") throw new HistoryChanged();
    if (answer.kind === "unavailable") throw new ConversationUnavailable(answer.reason);
    const { kind: _kind, signature, ...conversation } = answer;
    const key = `opencode\0${resolved.path}\0${resolved.session}\0${page.before ?? ""}\0${page.since ?? ""}\0${page.from ?? ""}`;
    return { source: resolved.source, ...conversation, version: answerVersion(key, signature) };
  }
  if (resolved.source === "hermes-transcript") {
    rememberPaneRead(paneId, resolved.path);
    try {
      const answer = hermesConversationPage(resolved.sessionId, resolved.path, page);
      writtenSessions.add(`${resolved.source}\0${resolved.sessionId}`);
      rememberPaneSession(paneId, `${resolved.source}\0${resolved.sessionId}`);
      return answer;
    } catch (error) {
      if (error instanceof ConversationNotStarted) return await onNotStarted(error);
      throw error;
    }
  }
  const identity = resolved.source === "agy-transcript" ? resolved.path
    : resolved.source === "claude-transcript" ? nodePath.basename(resolved.path, ".jsonl")
    : resolved.source === "pi-transcript" || resolved.source === "omp-transcript" ? realpathSync(resolved.path) : null;
  rememberPaneRead(paneId, resolved.path);
  const answer = transcriptPage(resolved.source, resolved.path, page, resolved.codexHome ?? codexHome);
  const status = snapshot.panes.find((pane) => pane.pane_id === paneId)?.agent_status;
  if (resolved.source === "grok-transcript" && answer.turns.length === 0 && page.before === undefined
    && (status === "working" || status === "blocked")) {
    // the file can change or go between the page and this check: either way the terminal answers
    let revision: string | null = null;
    try { revision = grokProjection(resolved.path, statSync(resolved.path)).revision; } catch { /* unreadable now */ }
    if (revision === null || revision === "0") throw new ConversationUnavailable("transcript_missing");
  }
  if (resolved.agy && !sameAgyStore(resolved.agy, await resolveAgyStore(snapshot.panes.find((pane) => pane.pane_id === paneId)!))) throw new ConversationUnavailable("no_session_path");
  if (identity !== null) { writtenSessions.add(`${resolved.source}\0${identity}`); rememberPaneSession(paneId, `${resolved.source}\0${identity}`); }
  if (resolved.source === "grok-transcript") {
    try { return { ...answer, activity: grokProjection(resolved.path, statSync(resolved.path)).activity }; }
    catch { throw new ConversationUnavailable("transcript_missing"); }
  }
  return answer;
}

/** One page of a resolved transcript (paneConversation's `page`). */
export function transcriptPage(source: StreamSource, path: string, page: ConversationPage = {}, codexHome?: string): RecognizedConversation {
  if (source === "agy-transcript") {
    try { return withAgyHistory(path, (projection, fd) => ({ ...transcriptPageRead(source, path, page, codexHome, projection, fd), activity: projection.activity })); }
    catch (error) {
      if (error instanceof HistoryChanged || error instanceof ConversationUnavailable) throw error;
      throw new ConversationUnavailable("transcript_missing");
    }
  }
  return transcriptPageRead(source, path, page, codexHome);
}

function transcriptPageRead(source: StreamSource, path: string, page: ConversationPage, codexHome?: string, agy?: AgyProjection, fd?: number): RecognizedConversation {
  let stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
  try {
    stat = statSync(path);
  } catch {
    throw new ConversationUnavailable("transcript_missing");
  }
  let stream: TranscriptStream;
  try {
    stream = transcriptStream(source, path, stat, codexHome ?? defaultCodexHome(), agy, fd);
    applyHistoryBoundary(path, stream, source);
  } catch (error) {
    // a branch that cannot be walked says so; a file that went unreadable mid-read has
    // one answer, and an unreadable branch has its own
    if (error instanceof ConversationUnavailable) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }
  // an older page never changes while its file and the rollouts before it stay the same
  // (the stream's id names both); the newest one changes with every append
  const key = page.before !== undefined ? `${path}\0before:${page.before}:${page.since ?? ""}` : `${path}\0from:${page.from ?? ""}`;
  const signature = page.before !== undefined ? stream.id : `${stream.id}:${stream.length}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = cache.get(key);
  // the answer is a function of the page asked for and the file's state, so they name it
  const version = answerVersion(key, signature);
  if (cached?.signature === signature) {
    return { source, turns: cached.turns, metadata: cached.metadata, cursor: cached.cursor, abandoned: cached.abandoned, history_id: stream.id, version };
  }

  let start: number;
  let text: string;
  let head = "";
  let cursor: string | null;
  let live: { turns: ConversationTurn[]; metadata: ConversationMetadata } | null = null;
  try {
    if (page.before !== undefined) {
      const before = parseCursor(stream, page.before);
      const floor = page.since === undefined ? stream.floor : parseCursor(stream, page.since);
      if (floor > before) throw new HistoryChanged();
      const older = before === floor ? { start: floor, bytes: Buffer.alloc(0) } : pageBefore(stream, source, before, { floor, widen: true });
      start = older.start;
      text = older.bytes.toString("utf8");
    } else {
      const held = page.from === undefined ? null : parseCursor(stream, page.from);
      const newest = newestPage(path, stream, source);
      // A chat that shows older pages holds the start of its newest turns and keeps
      // every turn after it while they are inside the newest page. Once the newest
      // page has moved past it, the chat gets the newest page and fetches the turns
      // in between with `before` + `since`: no poll reads more than a page.
      if (newest !== null) {
        start = held !== null && held >= newest.start ? held : newest.start;
        live = liveTurns(path, stream, source, start, newest.starts);
        text = "";
      } else {
        // no turn starts in the window: the page begins mid-turn, read whole as before
        const whole = pageBefore(stream, source, stream.length, { widen: false });
        start = held !== null && held >= whole.start ? held : whole.start;
        text = whole.bytes.subarray(start - whole.start).toString("utf8");
      }
    }
    if (live === null && page.before === undefined && start > stream.floor) head = metadataHead(path, stream, source, start);
    cursor = formatCursor(stream, start);
  } catch (error) {
    if (error instanceof HistoryChanged) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }

  // the store decides the parser, not the pane's label: omo writes omp's
  // session shape while herdr may be calling that same pane `claude`. The page
  // bounds the turns, so none are cut: they must meet the next page exactly.
  const turns = live?.turns ?? parseTurns(source, path, text);
  const metadata = live?.metadata ?? parseConversationMetadata(`${head}\n${text}`, source);
  // Record the stat from BEFORE the read: an append during parsing must cause
  // another read on the next poll, not permanently cache a torn tail.
  cache.delete(key);
  // the abandoned turns live outside the branch's byte ranges, so the page cannot see them: a
  // straight line answers { count: 0 }, which is most sessions and costs the client nothing
  const abandoned = source === "pi-transcript" ? piAbandonedTurns(path, stat.size) ?? undefined : undefined;
  cache.set(key, { signature, turns, metadata, cursor, abandoned });
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return { source, turns, metadata, cursor, abandoned, history_id: stream.id, version };
}

/** A recorded user/tool image, fetched only from the pane's bound, visible native history. */
export async function conversationImage(paneId: string, ref: string, codexHome?: string, opencodeDb?: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  if (!IMAGE_REF.test(ref) && !CODEX_IMAGE_REF.test(ref) && !PI_IMAGE_REF.test(ref) && !PI_USER_IMAGE_REF.test(ref)
    && !BLOB_IMAGE_REF.test(ref) && !OPENCODE_IMAGE_REF.test(ref)) return null;
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined || typeof pane.cwd !== "string" || pane.cwd.length === 0) return null;
  let resolved: ResolvedTranscript;
  try { resolved = await resolveTranscript(pane, pane.cwd, codexHome, snapshot.panes, opencodeDb); }
  catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
  // OpenCode's store is read per request and keeps nothing for the pane to release
  if (resolved.source === "opencode-transcript") return opencodeImage(resolved.path, resolved.session, ref);
  rememberPaneRead(paneId, resolved.path);
  if (resolved.source === "codex-transcript") return codexTranscriptImage(codexHistorySegments(resolved.path, resolved.codexHome ?? codexHome), ref, pane.cwd);
  if (resolved.source === "pi-transcript") return piTranscriptImage(resolved.path, ref);
  if (resolved.source === "omp-transcript" || resolved.source === "omo-transcript" || resolved.source === "gjc-transcript") return ompTranscriptImage(resolved.path, ref);
  return resolved.source === "claude-transcript" ? transcriptImage(resolved.path, ref) : null;
}

/** A prompt block, or an image nested inside a tool-result block, in the same recorded entry. */
const IMAGE_REF = /^([0-9a-f-]{8,64}):(\d{1,3})(?::(\d{1,3}))?$/i;

/** The image an image part's ref names in a Claude transcript file, decoded; null when there is none. */
export function transcriptImage(path: string, ref: string): { mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const match = IMAGE_REF.exec(ref);
  if (match === null) return null;
  const [, uuid, index, nestedIndex] = match;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  text = activeHistoryText(text, "claude-transcript");
  const needle = JSON.stringify(uuid);
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    let entry: TranscriptEntry;
    try { entry = JSON.parse(line) as TranscriptEntry; } catch { continue; }
    if (entry?.type !== "user" || entry.isMeta || entry.isCompactSummary || entry.uuid !== uuid || !Array.isArray(entry.message?.content)) continue;
    let block: unknown = entry.message.content[Number(index)];
    if (nestedIndex !== undefined) {
      if (typeof block !== "object" || block === null) return null;
      const result = block as { type?: unknown; content?: unknown };
      if (result.type !== "tool_result" || !Array.isArray(result.content)) return null;
      block = result.content[Number(nestedIndex)];
    }
    const source = claudeImageSource(block);
    return source === null ? null : base64Image(source.data);
  }
  return null;
}

const TOOL_REF = /^[A-Za-z0-9_:.-]{1,128}$/;
/** A whole output is still bounded: a page of it, not a log file. */
const TOOL_OUTPUT_MAX = 2_000_000;

/** The whole output of a tool call whose page output was cut, by its id; null when there is none. */
export async function toolOutput(paneId: string, ref: string, codexHome?: string, opencodeDb?: string, hermesHome?: string, grokHome?: string): Promise<string | null> {
  if (!TOOL_REF.test(ref)) return null;
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined || typeof pane.cwd !== "string" || pane.cwd.length === 0) return null;
  let resolved: ResolvedTranscript;
  try { resolved = await resolveTranscript(pane, pane.cwd, codexHome, snapshot.panes, opencodeDb, hermesHome, grokHome); }
  catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
  if (resolved.source === "opencode-transcript") {
    const output = opencodeToolOutput(resolved.path, resolved.session, ref);
    return output !== null && output.length > TOOL_OUTPUT_MAX ? `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : output;
  }
  rememberPaneRead(paneId, resolved.path);
  if (resolved.source === "hermes-transcript") return hermesToolOutput(resolved.sessionId, resolved.path, ref, TOOL_OUTPUT_MAX);
  const output = transcriptToolOutput(resolved.source, resolved.path, ref, resolved.codexHome ?? codexHome);
  if (resolved.agy && !sameAgyStore(resolved.agy, await resolveAgyStore(pane))) return null;
  return output;
}

/** The output a transcript file holds for one tool call id, whole (up to TOOL_OUTPUT_MAX). */
export function transcriptToolOutput(source: StreamSource, path: string, ref: string, codexHome?: string): string | null {
  if (!TOOL_REF.test(ref)) return null;
  if (source === "codex-transcript") {
    let segments: ReturnType<typeof codexHistorySegments>;
    try { segments = codexHistorySegments(path, codexHome); } catch { return null; }
    for (const segment of segments) {
      let text: string;
      // a rollout may have been archived since resolution: the others still hold theirs
      try { text = readRange(segment.path, 0, segment.end); } catch { continue; }
      const output = outputInText(source, text, ref);
      if (output !== null) return output;
    }
    return null;
  }
  if (source === "grok-transcript") return grokToolOutput(path, ref);
  if (source === "agy-transcript") return agyToolOutput(path, ref);
  if (source === "pi-transcript") return piToolOutput(path, ref);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  return outputInText(source, text, ref);
}

/**
 * One whole tool output by ref. A pi output lives on the active branch only: reading the
 * file whole would answer a ref from a branch a /tree abandoned, whose output the chat
 * never showed, so the branch is read the way the conversation is.
 */
function piToolOutput(path: string, ref: string): string | null {
  let size: number;
  let branch: ReturnType<typeof piBranchSegments>;
  try { size = statSync(path).size; branch = piBranchSegments(path, size); } catch { return null; }
  if (branch === null) return null;
  const fd = openSync(path, "r");
  try {
    for (const segment of branch) {
      const buffer = Buffer.alloc(segment.end - segment.start);
      if (readSync(fd, buffer, 0, buffer.length, segment.start) !== buffer.length) continue;
      const output = outputInText("pi-transcript", buffer.toString("utf8"), ref);
      if (output !== null) return output;
    }
  } finally { closeSync(fd); }
  return null;
}

/**
 * A recorded pi user/tool image is read on the active branch only. The complete
 * projected history shares /clear's boundary before either inline or blob bytes
 * are fetched, so neither abandoned branches nor earlier context remain exposed.
 */
export function piTranscriptImage(path: string, ref: string): { mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  if (!PI_IMAGE_REF.test(ref) && !PI_USER_IMAGE_REF.test(ref) && !BLOB_IMAGE_REF.test(ref)) return null;
  let branch: TranscriptSegment[] | null;
  try { branch = piBranchSegments(path, statSync(path).size); } catch { return null; }
  if (branch === null) return null;
  const chunks: string[] = [];
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    for (const segment of branch) {
      const buffer = Buffer.alloc(segment.end - segment.start);
      if (readSync(fd, buffer, 0, buffer.length, segment.start) !== buffer.length) return null;
      chunks.push(buffer.toString("utf8"));
    }
  } catch { return null; }
  finally { closeSync(fd); }
  return piImageInHistory(path, ref, activeHistoryText(chunks.join("\n"), "pi-transcript"));
}

function outputInText(source: RecognizedConversation["source"], text: string, ref: string): string | null {
  text = activeHistoryText(text, source);
  const needle = JSON.stringify(ref);
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    let output: string | null = null;
    if (source === "claude-transcript") {
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      const result = Array.isArray(content) ? content.find((block) => (block as { type?: unknown; tool_use_id?: unknown } | null)?.type === "tool_result" && (block as { tool_use_id?: unknown }).tool_use_id === ref) : undefined;
      if (result !== undefined) output = claudeResultText((result as { content?: unknown }).content);
    } else if (source === "codex-transcript") {
      const payload = entry.payload as { type?: unknown; call_id?: unknown; output?: unknown } | undefined;
      if ((payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output") && payload.call_id === ref) output = codexOutputText(payload.output);
    } else {
      const message = piMessage(entry);
      if (message) output = piResults(message).find((result) => result.id === ref)?.text ?? null;
    }
    if (output !== null) return output.length > TOOL_OUTPUT_MAX ? `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : output;
  }
  return null;
}

