/** Native Codex rollouts contain both display events and model context. Only
 * conversation records belong in chat; developer prompts and terminal chrome do not. */
import { Database } from "bun:sqlite";
import { closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import nodePath, { isAbsolute, join, type PlatformPath } from "node:path";
import type { ConversationPart, ConversationTurn, HerdrPane } from "../shared/protocol.ts";
import { patchFiles, patchText } from "../shared/patch.ts";
import { processStartedAt } from "./process-start.ts";
import { codexImageParts } from "./codex-images.ts";
import { codexReadCall, codexReadSkills, selectedSkill } from "./skill-activity.ts";
import { trimOutput } from "./tool-output.ts";
import { agentGet, paneProcessInfo, paneRead, sessionSnapshot } from "./herdr/client.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contextOnly(text: string): boolean {
  const value = text.trim();
  return (/^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>(?:\s*<environment_context>[\s\S]*<\/environment_context>)?$/.test(value))
    || /^<(environment_context|permissions instructions|turn_aborted|subagent_notification)>[\s\S]*<\/\1>$/.test(value);
}

/**
 * An answer to Codex's queued questions (request_user_input_async) reaches the model as
 * a user message: a JSON list of {answer, question, questionItemId} inside
 * `<send_user_message_question_reply>`. The chat shows what was answered, not the envelope.
 */
function questionReply(text: string): string | null {
  const match = text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
  if (!match) return null;
  try {
    const items: unknown = JSON.parse(match[1]!);
    if (!Array.isArray(items)) return null;
    const answers = items.map((item) => string(record(item).answer).trim()).filter(Boolean);
    return answers.length > 0 ? answers.join("\n") : null;
  } catch {
    return null;
  }
}

/** The questions of a request_user_input(_async) call: `title` (async) or `question` (plan mode). */
function questionTitles(args: RecordValue): string[] {
  return Array.isArray(args.questions)
    ? args.questions.map((question) => string(record(question).title) || string(record(question).question)).filter(Boolean)
    : [];
}

/** A tool call's output as Codex recorded it, as text. */
export function codexOutputText(value: unknown): string {
  return contentText(value);
}

function contentText(value: unknown, user = false): string {
  if (typeof value === "string") return user && contextOnly(value) ? "" : value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((raw) => {
    const part = record(raw);
    return ["input_text", "output_text", "text", "summary_text"].includes(string(part.type))
      && typeof part.text === "string" && !(user && contextOnly(part.text)) ? [part.text] : [];
  }).join("\n");
}

/** Native image wrappers are metadata only when the entire input_text borders an image block. */
function nativeImageEnvelope(content: unknown[], index: number): boolean {
  const part = record(content[index]);
  if (part.type !== "input_text" || typeof part.text !== "string") return false;
  const text = part.text.trim();
  const adjacent = text === "</image>" ? content[index - 1]
    : /^<image name=\[Image #\d+\](?: path="[^"]*")?>$/.test(text) ? content[index + 1] : undefined;
  const type = record(adjacent).type;
  return type === "input_image" || type === "local_image";
}

function entries(text: string): RecordValue[] {
  return text.split("\n").flatMap((line) => {
    try { return [record(JSON.parse(line))]; } catch { return []; }
  });
}

/** Memory blocks are metadata unless the answer quotes them in Markdown code. */
function withoutMemoryCitations(text: string): string {
  const opening = "<oai-mem-citation>";
  const closing = "</oai-mem-citation>";
  if (!text.includes(opening)) return text.trimEnd();

  type Line = { kind: "line"; index: number; quoteDepth: number; indent: number; listIndent?: number; blank: boolean };
  type Token = Line | { kind: "fence"; index: number; marker: string; info: string; line: Line }
    | { kind: "ticks"; index: number; size: number } | { kind: "citation"; index: number };
  const tokens: Token[] = [];
  const quote = /[ \t]*>[ \t]?/y;
  for (const match of text.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/g)) {
    const source = match[1]!;
    let offset = 0;
    let quoteDepth = 0;
    quote.lastIndex = 0;
    while (quote.exec(source)) { offset = quote.lastIndex; quoteDepth++; }
    const indent = /^[ \t]*/.exec(source.slice(offset))![0].length;
    const content = source.slice(offset + indent);
    const list = /^(?:[-+*]|\d+[.)])[ \t]+/.exec(content);
    const line: Line = { kind: "line", index: match.index!, quoteDepth, indent,
      ...(list ? { listIndent: indent + list[0].length } : {}), blank: content.trim() === "" };
    tokens.push(line);
    const body = content.slice(list?.[0].length ?? 0);
    const marker = /^(`{3,}|~{3,})/.exec(body)?.[0];
    const info = marker ? body.slice(marker.length) : "";
    // A backtick fence's info string cannot contain backticks.
    if (marker && (marker[0] !== "`" || !info.includes("`"))) tokens.push({ kind: "fence",
      index: match.index! + offset + indent + (list?.[0].length ?? 0), marker, info, line });
    for (const token of source.matchAll(/`+|<oai-mem-citation>/g)) {
      tokens.push(token[0] === opening ? { kind: "citation", index: match.index! + token.index! }
        : { kind: "ticks", index: match.index! + token.index!, size: token[0].length });
    }
  }
  const closes = new Map<number, number>();
  const pairs: number[] = [];
  // Index matching runs once: unmatched delimiters must not repeatedly scan the tail.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (token.kind !== "ticks") {
      if (token.kind === "line") closes.clear();
      continue;
    }
    let backslashes = 0;
    for (let at = token.index - 1; at >= 0 && text[at] === "\\"; at--) backslashes++;
    const length = token.size - (backslashes % 2);
    pairs[i] = length > 0 ? closes.get(length) ?? -1 : -1;
    // Inside a code span a backslash does not escape its closing backticks.
    closes.set(token.size, i);
  }
  const parts: string[] = [];
  const listIndents: number[] = [];
  let quoteDepth = 0;
  let kept = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "line") {
      if (token.quoteDepth !== quoteDepth) { listIndents.length = 0; quoteDepth = token.quoteDepth; }
      if (token.blank) continue;
      while (listIndents.length > 0 && listIndents.at(-1)! > token.indent) listIndents.pop();
      if (token.listIndent !== undefined) listIndents.push(token.listIndent);
      continue;
    }
    if (token.kind === "fence") {
      const within = token.line.listIndent ?? listIndents.at(-1) ?? 0;
      const indent = token.line.listIndent === undefined ? token.line.indent - within : 0;
      if (indent < 0 || indent > 3) continue;
      // An unfinished fence remains code until its quote/list container ends.
      for (i++; i < tokens.length; i++) {
        const end = tokens[i]!;
        if (end.kind === "line" && (end.quoteDepth < token.line.quoteDepth
          || (within > 0 && end.quoteDepth === token.line.quoteDepth && !end.blank && end.indent < within))) { i--; break; }
        if (end.kind === "fence" && end.line.quoteDepth === token.line.quoteDepth && end.marker[0] === token.marker[0]
          && end.marker.length >= token.marker.length && /^[ \t]*$/.test(end.info)) {
          // Skip the closing line's raw backtick/citation tokens too.
          while (i + 1 < tokens.length && tokens[i + 1]!.kind !== "line") i++;
          break;
        }
      }
      continue;
    }
    const pair = pairs[i];
    if (pair !== undefined && pair >= 0) { i = pair; continue; }
    if (token.kind !== "citation") continue;
    parts.push(text.slice(kept, token.index));
    const close = text.indexOf(closing, token.index + opening.length);
    kept = close === -1 ? text.length : close + closing.length;
    // Metadata contents cannot open code spans or fences in the surrounding answer.
    while (i + 1 < tokens.length && tokens[i + 1]!.index < kept) i++;
  }
  parts.push(text.slice(kept));
  return parts.join("").trimEnd();
}


/**
 * Whether a Codex tool output says the call failed. Codex records no flag: its command
 * runner writes the exit code into the output, and a script or patch its own verdict. A
 * script that completed is judged as a whole, however its commands went.
 */
export function codexCallFailed(output: string): boolean {
  const head = output.slice(0, 2000);
  if (/^Script completed\b/m.test(head)) return false;
  if (/^Script failed\b/m.test(head) || /apply_patch verification failed/.test(head)) return true;
  const code = /^(?:Process exited with code|Exit code:) (\d+)$/m.exec(head) ?? /"exit_code":\s*(\d+)/.exec(head);
  return code !== null && code[1] !== "0";
}

interface CodexParseState {
  turns: ConversationTurn[];
  tools: Map<string, Extract<ConversationPart, { kind: "tool" }>>;
  messages: { role: string; text: string; source: string; ts: string; paired: boolean; part: Extract<ConversationPart, { kind: "text" }>; turn: ConversationTurn }[];
  startedAt?: string;
  skillEvents?: Set<string>;
  activeTurnId?: string;
}

/** Complete records are folded once; snapshots detach mutable tools from prior HTTP answers. */
export function createCodexTranscriptParser(state: CodexParseState = { turns: [], tools: new Map(), messages: [] }) {
  const { turns, tools, messages } = state;
  const assistant = (ts: string): ConversationTurn => {
    let turn = turns.at(-1);
    if (turn?.role !== "assistant") {
      turn = { role: "assistant", ts: state.startedAt || ts || null, parts: [] };
      turns.push(turn);
    }
    if (ts) turn.end_ts = ts;
    return turn;
  };
  const message = (role: "user" | "assistant", text: string, source: string, ts: string, phase?: "commentary" | "final_answer", images: ConversationPart[] = []): void => {
    const body = role === "user" ? questionReply(text) ?? text
      : withoutMemoryCitations(text);
    if (!body.trim() && images.length === 0) return;
    const duplicate = messages.slice(-8).reverse().find((other) => !other.paired && other.role === role && other.text === body
      && other.source !== source && (other.ts === ts || Math.abs(Date.parse(other.ts) - Date.parse(ts)) <= 1000));
    if (duplicate) {
      duplicate.paired = true;
      if (phase) duplicate.part.phase = phase;
      // Prefer the event's local paths over a response's inline copies of the same images.
      if (images.length > 0 && (source === "event" || !duplicate.turn.parts.some((part) => part.kind === "image"))) {
        duplicate.turn.parts = [...images, ...duplicate.turn.parts.filter((part) => part.kind !== "image")];
      }
      return;
    }
    const part: Extract<ConversationPart, { kind: "text" }> = { kind: "text", text: body, ...(phase ? { phase } : {}) };
    const turn = role === "user" ? { role, ts: ts || null, parts: [...images, ...(body.trim() ? [part] : [])] } : assistant(ts);
    if (role === "user") turns.push(turn);
    else turn.parts.push(part);
    messages.push({ role, text: body, source, ts, paired: false, part, turn });
    if (messages.length > 8) messages.shift();
  };

  const write = (text: string): void => {
    for (const entry of entries(text)) {
      const payload = record(entry.payload);
      const ts = string(entry.timestamp);
      if (entry.type === "event_msg") {
        if (payload.type === "item_completed" && (!state.activeTurnId || !payload.turn_id || payload.turn_id === state.activeTurnId)) {
          const item = record(payload.item);
          const id = string(item.id);
          const skills = codexReadSkills(item);
          if (id && skills.length > 0 && !state.skillEvents?.has(id)) {
            (state.skillEvents ??= new Set()).add(id);
            if (state.skillEvents.size > 512) state.skillEvents.delete(state.skillEvents.values().next().value!);
            for (const skill of skills) {
              const turn = assistant(ts);
              const existing = [...turn.parts].reverse().find((part) => part.kind === "tool" && part.skill?.path === skill.path);
              if (existing?.kind === "tool" && existing.skill) existing.skill.status = skill.status;
              else turn.parts.push({ kind: "skill", skill });
            }
          }
        }
        if (payload.type === "task_started") {
          state.startedAt = string(payload.started_at) || ts;
          state.activeTurnId = string(payload.turn_id) || undefined;
        }
        if (payload.type === "task_complete" || payload.type === "turn_aborted") {
          const turn = turns.at(-1);
          if (turn?.role === "assistant" && ts) turn.end_ts = ts;
          state.startedAt = undefined;
        }
        if (payload.type === "user_message" && (!payload.kind || payload.kind === "plain")) {
          message("user", contentText(payload.message, true), "event", ts, undefined, codexImageParts(entry));
        }
        if (payload.type === "agent_message") {
          message("assistant", contentText(payload.message), "event", ts,
            payload.phase === "commentary" || payload.phase === "final_answer" ? payload.phase : undefined);
        }
        continue;
      }
      if (entry.type !== "response_item") continue;
      if (payload.type === "message") {
        if (payload.role === "user") {
          const content = Array.isArray(payload.content) ? payload.content : [{ type: "input_text", text: payload.content }];
          const skills = content.flatMap((block) => {
            const skill = selectedSkill(string(record(block).text));
            return skill ? [skill] : [];
          });
          const visible = content.filter((block, index) => !nativeImageEnvelope(content, index) && !selectedSkill(string(record(block).text)));
          message("user", contentText(visible, true), "response", ts, undefined, codexImageParts(entry));
          for (const skill of skills) {
            const turn = assistant(ts);
            if (!turn.parts.some((part) => part.kind === "skill" && part.skill.name === skill.name && part.skill.path === skill.path)) turn.parts.push({ kind: "skill", skill });
          }
        } else if (payload.role === "assistant") {
          const body = contentText(payload.content);
          if (payload.channel === "analysis") {
            if (body.trim()) assistant(ts).parts.push({ kind: "thinking", text: body });
          } else if (!payload.recipient || payload.recipient === "all") {
            message("assistant", body, "response", ts,
              payload.phase === "commentary" || payload.phase === "final_answer" ? payload.phase : undefined);
          }
        }
      } else if (payload.type === "reasoning") {
        const body = contentText(payload.summary);
        if (body.trim()) assistant(ts).parts.push({ kind: "thinking", text: body });
      } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        const name = string(payload.name) || "tool";
        const raw = payload.type === "function_call" ? payload.arguments : payload.input;
        let args = record(raw);
        if (typeof raw === "string") { try { args = record(JSON.parse(raw)); } catch { /* Freeform tool input. */ } }
        // a patch, bare or in an exec script, is summed up by the files it touches
        const patch = typeof raw === "string" ? patchText(raw) : null;
        const summary = patch !== null && patchFiles(patch).length > 0 ? patchFiles(patch).join(", ")
          : /^request_user_input/.test(name) && questionTitles(args).length > 0
          ? questionTitles(args).join(" · ")
          : [args.cmd, args.command, args.file_path, args.path, args.pattern, args.description, args.url].find((v) => typeof v === "string");
        const part: Extract<ConversationPart, { kind: "tool" }> = {
          kind: "tool", name, summary: (string(summary) || name).slice(0, 120),
          input: Object.keys(args).length ? JSON.stringify(args, null, 2) : string(raw), output: "",
        };
        const skill = codexReadCall(name, args);
        if (skill) part.skill = skill;
        assistant(ts).parts.push(part);
        if (typeof payload.call_id === "string") tools.set(payload.call_id, part);
      } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const tool = tools.get(string(payload.call_id));
        if (!tool) continue;
        const output = contentText(payload.output);
        trimOutput(tool, output, string(payload.call_id));
        if (codexCallFailed(output)) tool.error = true;
        if (tool.skill) tool.skill.status = tool.error ? "failed" : "loaded";
        tools.delete(string(payload.call_id));
        const turn = turns.at(-1);
        if (turn?.role === "assistant" && ts) turn.end_ts = ts;
      }
    }
  };
  return {
    write,
    snapshot(tail = ""): ConversationTurn[] {
      // A valid final line without a newline is visible now, but is not committed:
      // the writer can still extend it before the next poll.
      if (tail.trim()) {
        const preview = createCodexTranscriptParser(structuredClone(state));
        preview.write(tail);
        return preview.snapshot();
      }
      return structuredClone(turns.filter((turn) => turn.parts.length > 0));
    },
  };
}

export function parseCodexTranscript(text: string, maxTurns = 100): ConversationTurn[] {
  const parser = createCodexTranscriptParser();
  parser.write(text);
  return parser.snapshot().slice(-maxTurns);
}

export const defaultCodexHome = (): string => process.env["CODEX_HOME"] || join(homedir(), ".codex");

/** What processCodexHome found, by pid and argv, and when (PROCESS_HOME_TTL_MS). */
const processHomes = new Map<string, { home: string | null; at: number }>();
/**
 * A visible chat reads its conversation up to every 2 s while the transcript changes, the
 * conversation monitor re-resolves its file every 5 s, and macOS reads the environment with
 * a `ps` spawn: a process's environment does not change, so its answer is kept. A pid
 * reused by another process carries other arguments or comes after this; ponytail: a
 * reused pid with the same argv inside it reads the old store until it runs out.
 */
const PROCESS_HOME_TTL_MS = 30_000;

/**
 * The CODEX_HOME in a process's environment: /proc on Linux, `ps -E` (same user only) on macOS,
 * kept for PROCESS_HOME_TTL_MS under the process's pid and argv.
 */
export async function processCodexHome(pid: number, argv: readonly string[] = []): Promise<string | null> {
  const key = `${pid}\0${argv.join("\0")}`;
  const known = processHomes.get(key);
  if (known && Date.now() - known.at < PROCESS_HOME_TTL_MS) return known.home;
  const home = await readProcessCodexHome(pid);
  processHomes.delete(key);
  processHomes.set(key, { home, at: Date.now() });
  if (processHomes.size > 256) processHomes.delete(processHomes.keys().next().value!);
  return home;
}

async function readProcessCodexHome(pid: number): Promise<string | null> {
  let home: string | null = null;
  try {
    if (process.platform === "linux") {
      home = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").find((entry) => entry.startsWith("CODEX_HOME="))?.slice(11) || null;
    } else if (process.platform === "darwin") {
      const child = Bun.spawn(["/bin/ps", "-E", "-ww", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => child.kill(), 3000);
      try {
        // the environment follows the arguments, space-separated: the last match is the
        // environment's, and its value runs to the next `NAME=` (a path may hold spaces).
        // ponytail: a value holding ` NAME=` is cut there, and with none in the environment an
        // argument spelled CODEX_HOME=/path would be taken. /proc on Linux has neither problem
        const text = await new Response(child.stdout).text();
        await child.exited;
        home = codexHomeInPsLine(text);
      } finally { clearTimeout(timer); }
    }
  } catch { home = null; }
  return home !== null && (await isCodexHomeDir(home)) ? home : null;
}

/** An absolute path to a directory that is there: `ps` cannot tell an argument from the environment, a store can be checked. */
async function isCodexHomeDir(home: string): Promise<boolean> {
  if (!isAbsolute(home)) return false;
  try { return (await stat(home)).isDirectory(); } catch { return false; }
}

/**
 * CODEX_HOME in one `ps -E -o command=` line: the environment follows the arguments,
 * space-separated, so the last assignment is taken and its value runs to the next `NAME=`
 * (a path may hold spaces). A value holding ` NAME=` is cut there; an argument spelled
 * `CODEX_HOME=/path` is taken when the environment has none, which the directory check above
 * narrows. /proc on Linux has neither problem.
 */
export function codexHomeInPsLine(text: string): string | null {
  return [...text.matchAll(/(?:^|\s)CODEX_HOME=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/g)].at(-1)?.[1] || null;
}

/**
 * The store a pane's Codex writes to. A launcher can start Codex with its own CODEX_HOME (a
 * harness keeps one per profile), so a single store for the whole server misses those panes:
 * an explicit `configured` store wins, then the pane's Codex process's own, then the default.
 */
export async function paneCodexHome(paneId: string, configured?: string): Promise<string> {
  if (configured) return configured;
  try {
    // the first Codex listed decides, with or without a home of its own: a child or wrapper it
    // started with another CODEX_HOME writes to a store that is not this pane's conversation
    const [first] = (await codexProcessesOf(paneId)).list;
    if (first !== undefined) return (await processCodexHome(first.pid, first.argv)) ?? defaultCodexHome();
  } catch { /* herdr busy: the default store */ }
  return defaultCodexHome();
}

/** The session_meta payload on a rollout's first line, or null when the file is not a rollout. */
function rolloutHeader(path: string): RecordValue | null {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const header = record(JSON.parse(buffer.subarray(0, length).toString("utf8").split("\n")[0]!));
    return header.type === "session_meta" ? record(header.payload) : null;
  } finally { closeSync(fd); }
}

/**
 * A Windows path without the `\\?\` prefix that Codex on Windows stores in `threads` (`cwd`,
 * `rollout_path`), as Rust's canonical paths carry it: `\\?\D:\x` is `D:\x` and
 * `\\?\UNC\host\share` is `\\host\share` (#518). Any other path, `\\?\Volume{…}\` included, is
 * returned as it is: without its prefix it would read as a relative path.
 */
export function withoutVerbatimPrefix(path: string): string {
  if (!path.startsWith("\\\\?\\")) return path;
  const rest = path.slice(4);
  if (/^UNC\\/i.test(rest)) return `\\\\${rest.slice(4)}`;
  return /^[A-Za-z]:\\/.test(rest) ? rest : path;
}

/** The `cwd` values Codex may have stored for a directory: as given, and on Windows also with `\\?\`. */
export function storedCwds(cwd: string): [string, string] {
  const plain = withoutVerbatimPrefix(cwd);
  if (/^[A-Za-z]:\\/.test(plain)) return [plain, `\\\\?\\${plain}`];
  if (/^\\\\[^\\?.]/.test(plain)) return [plain, `\\\\?\\UNC\\${plain.slice(2)}`];
  return [cwd, cwd];
}

/**
 * A Windows cwd in one spelling for every way Codex and herdr may write it: without `\\?\` and
 * with an upper-case drive letter (`d:\work` and `\\?\D:\work` are `D:\work`). The rest is
 * compared as it is: a Windows directory can be case-sensitive, and nothing short of the file
 * system tells `app` from `App`, so a cwd stored in another letter case finds nothing (#587).
 */
export function directoryKey(cwd: string): string {
  const plain = withoutVerbatimPrefix(cwd);
  return /^[a-z]:\\/.test(plain) ? plain[0]!.toUpperCase() + plain.slice(1) : plain;
}

/** Whether two cwds are one directory by `directoryKey`; POSIX ones only when they are equal. */
export function sameDirectory(left: string, right: string): boolean {
  if (directoryKey(left) === directoryKey(right)) return true;
  if (process.platform !== "win32") return false;
  try {
    // bigint: a Windows file ID is 64-bit, and two of them can round to one number
    const a = statSync(left, { bigint: true });
    const b = statSync(right, { bigint: true });
    return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

/** The other Codex panes herdr shows in this pane's directory, in any spelling `sameDirectory` takes. */
export function codexPeersIn(panes: readonly HerdrPane[], paneId: string, cwd: string): HerdrPane[] {
  // the agent first: sameDirectory can ask the file system, and only Codex panes need it
  return panes.filter((pane) => pane.pane_id !== paneId && (pane.agent ?? pane.agent_session?.agent) === "codex"
    && pane.cwd != null && sameDirectory(pane.cwd, cwd));
}

/**
 * Codex's `WHERE` condition for the threads of a directory, and its parameters: each spelling
 * `storedCwds` gives, with the drive letter in either case. Exact comparisons, so the lookup
 * stays on Codex's own binary cwd index.
 */
export function storedCwdCondition(cwd: string): { where: string; params: string[] } {
  // Windows resolves an existing directory to its on-disk casing. Herdr may report the
  // shell's spelling while Codex stores the canonical spelling in its binary cwd index.
  // Keep both: the original is needed when Codex recorded it before a rename or via a link.
  let canonical = cwd;
  if (process.platform === "win32") {
    try { canonical = realpathSync.native(cwd); } catch { /* A removed cwd still has its reported spelling. */ }
  }
  const params = [...new Set([cwd, canonical].flatMap((path) => storedCwds(path)).flatMap((spelling) => {
    const drive = /^((?:\\\\\?\\)?)([A-Za-z])(:\\.*)$/s.exec(spelling);
    return drive ? [`${drive[1]}${drive[2]!.toUpperCase()}${drive[3]}`, `${drive[1]}${drive[2]!.toLowerCase()}${drive[3]}`] : [spelling];
  }))];
  return { where: `cwd IN (${params.map(() => "?").join(", ")})`, params };
}

/**
 * Whether the canonical `file` lies inside the canonical store `root`. Either may carry the
 * Windows `\\?\` prefix without the other (a prefixed CODEX_HOME, #587), or its drive letter in
 * another case: it is not another root. Past the drive letter the comparison is exact, as
 * `directoryKey` has it: a case-sensitive directory's `Sessions` is not `sessions`.
 */
export function rolloutInsideStore(root: string, file: string, paths: PlatformPath = nodePath): boolean {
  const key = (path: string) => directoryKey(paths.normalize(withoutVerbatimPrefix(path)));
  const base = key(root);
  const inside = base.endsWith(paths.sep) ? base : `${base}${paths.sep}`;
  const path = key(file);
  return path.length > inside.length && path.startsWith(inside);
}

/** File access is constrained by canonical paths, including symlink targets. */
export function codexRolloutPath(path: string, codexHome: string): string | null {
  try {
    const canonical = realpathSync(withoutVerbatimPrefix(path));
    if (!rolloutInsideStore(realpathSync(join(codexHome, "sessions")), canonical) || !canonical.endsWith(".jsonl")) return null;
    if (!statSync(canonical).isFile()) return null;
    const metadata = rolloutHeader(canonical);
    // A child Codex can be in the foreground process group too. Its rollout
    // is not the conversation of the parent TUI.
    if (metadata === null || (metadata.source && typeof metadata.source !== "string")
      || metadata.source === "subagent" || (metadata.thread_source && metadata.thread_source !== "user")
      || metadata.agent_role) return null;
    return canonical;
  } catch { return null; }
}

/** Bytes [start, end) of a file as text; a cut first line is dropped. */
export function readRange(path: string, start: number, end: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    const length = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, length).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

/** A question Codex queued with request_user_input_async; `options` is empty for a free-form one. */
export interface QueuedQuestion { key: string; title: string; options: string[] }

const QUESTION_SCAN_BYTES = 4 * 1024 * 1024;
/** Per rollout: how far it was read, the questions asked and the ones answered since. */
const questionScans = new Map<string, { ino: number; size: number; cut: boolean; asked: QueuedQuestion[]; answered: Set<string> }>();

/**
 * The questions a rollout asked with request_user_input_async and holds no answer for,
 * oldest first. A question skipped in the TUI leaves no record, so a caller takes as
 * many of the newest as the TUI shows waiting. Only bytes appended since the last call
 * are read (the first call reads the last 4MB, without blocking), and only lines naming
 * the tool parsed.
 */
export function unansweredCodexQuestions(path: string): Promise<QueuedQuestion[]> {
  // two viewers polling, or a poll overlapping an answer: one scan per file at a time
  const running = questionScansInFlight.get(path);
  if (running) return running;
  const scan = scanQuestions(path).finally(() => questionScansInFlight.delete(path));
  questionScansInFlight.set(path, scan);
  return scan;
}

const questionScansInFlight = new Map<string, Promise<QueuedQuestion[]>>();

async function scanQuestions(path: string): Promise<QueuedQuestion[]> {
  const stat = statSync(path);
  const known = questionScans.get(path);
  // the scan is built on a copy and kept only once complete
  const scan = known && known.ino === stat.ino && stat.size >= known.size
    ? { ...known, asked: [...known.asked], answered: new Set(known.answered) }
    : { ino: stat.ino, size: Math.max(0, stat.size - QUESTION_SCAN_BYTES), cut: stat.size > QUESTION_SCAN_BYTES, asked: [] as QueuedQuestion[], answered: new Set<string>() };
  if (stat.size > scan.size) {
    const bytes = Buffer.from(await Bun.file(path).slice(scan.size, stat.size).arrayBuffer());
    // whole lines only: a line still being written is read again next time
    const end = bytes.lastIndexOf(0x0a) + 1;
    let text = bytes.subarray(0, end).toString("utf8");
    if (scan.cut && end > 0) { text = text.slice(text.indexOf("\n") + 1); scan.cut = false; }
    for (const line of text.split("\n")) {
      if (!line.includes("request_user_input_async")) continue;
      let entry: RecordValue;
      try { entry = record(JSON.parse(line)); } catch { continue; }
      if (entry.type !== "response_item") continue;
      const payload = record(entry.payload);
      if (payload.type === "function_call" && payload.name === "request_user_input_async") {
        let args: RecordValue = {};
        try { args = record(JSON.parse(string(payload.arguments))); } catch { continue; }
        const questions = Array.isArray(args.questions) ? args.questions.map(record) : [];
        questions.forEach((question, index) => scan.asked.push({
          key: `${string(payload.call_id)}:${index}`,
          title: string(question.title) || string(question.question),
          options: Array.isArray(question.options)
            ? question.options.map((option) => typeof option === "string" ? option : string(record(option).label)).filter(Boolean)
            : [],
        }));
      } else if (payload.type === "message" && payload.role === "user") {
        const reply = contentText(payload.content).trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
        let items: unknown = [];
        try { items = JSON.parse(reply?.[1] ?? "[]"); } catch { continue; }
        for (const item of Array.isArray(items) ? items : []) {
          // questionItemId: ["request_user_input_async", call id, question index]
          let id: unknown;
          try { id = JSON.parse(string(record(item).questionItemId)); } catch { continue; }
          if (Array.isArray(id) && typeof id[1] === "string" && Number.isInteger(id[2])) scan.answered.add(`${id[1]}:${id[2]}`);
        }
      }
    }
    scan.size += end;
  }
  questionScans.delete(path);
  questionScans.set(path, scan);
  if (questionScans.size > 16) questionScans.delete(questionScans.keys().next().value!);
  return scan.asked.filter((question) => !scan.answered.has(question.key));
}

const readdir = (path: string): string[] => { try { return readdirSync(path); } catch { return []; } };

/** A byte range of rollout history: the file's first `end` bytes. */
export interface HistorySegment { path: string; end: number }

/**
 * Chains per rollout, newest first. A header never changes, so a complete chain is
 * kept for good; one that stops at a cut no file holds yet is kept a short while,
 * so every append does not walk sessions/ again, and then looked up afresh.
 */
const historyChains = new Map<string, { chain: HistorySegment[]; complete: boolean; at: number }>();
const INCOMPLETE_CHAIN_MS = 30_000;

/** Drops every remembered chain: the next read resolves each one again. */
export function forgetHistoryChains(): void {
  historyChains.clear();
}

/** Drops one rollout's remembered chain: its next read resolves it again. */
export function forgetHistoryChain(path: string): void {
  historyChains.delete(path);
}

/** Everything remembered about one rollout: its chain, its question scan and any scan in flight. */
export function forgetCodexStateFor(path: string): void {
  historyChains.delete(path);
  questionScans.delete(path);
  questionScansInFlight.delete(path);
}

/** Every remembered chain and question scan: the next read resolves each one again. */
export function forgetAllCodexState(): void {
  historyChains.clear();
  questionScans.clear();
  questionScansInFlight.clear();
  linesBeforeCut.clear();
}

/** Lines before a cut, per file identity and cut: the bytes before a cut never change. */
const linesBeforeCut = new Map<string, number>();

function countLines(path: string, end: number): number {
  const stat = statSync(path);
  const key = `${stat.dev}:${stat.ino}:${end}`;
  const known = linesBeforeCut.get(key);
  if (known !== undefined) return known;
  const fd = openSync(path, "r");
  let lines = 0;
  try {
    const buffer = Buffer.alloc(16 * 1024 * 1024);
    for (let offset = 0; offset < end;) {
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (length === 0) break;
      for (let index = buffer.indexOf(0x0a, 0); index !== -1 && index < length; index = buffer.indexOf(0x0a, index + 1)) lines += 1;
      offset += length;
    }
  } finally { closeSync(fd); }
  linesBeforeCut.set(key, lines);
  if (linesBeforeCut.size > 256) linesBeforeCut.delete(linesBeforeCut.keys().next().value!);
  return lines;
}

function byteAt(path: string, offset: number): number | null {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1);
    return readSync(fd, buffer, 0, 1, offset) === 1 ? buffer[0]! : null;
  } finally { closeSync(fd); }
}

/** A rollout's first ordinal: where the history it continues ends, 0 for a whole history. */
function firstOrdinal(header: RecordValue): number {
  const ordinal = record(header.history_base).end_ordinal_exclusive;
  return typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : 0;
}

/**
 * Does `path` hold a cut at (ordinal, byte)? Every record is one line and a rollout's
 * ordinals start at its own first ordinal, so the cut must end a line with exactly
 * `ordinal - first` lines before it (checked on a three-rollout Codex 0.156 chain
 * against the turn offsets in its thread_history_1.sqlite).
 */
function holdsCut(path: string, ordinal: number, end: number): boolean {
  let header: RecordValue | null;
  try { header = rolloutHeader(path); } catch { return false; }
  if (header === null) return false;
  const lines = ordinal - firstOrdinal(header);
  if (lines <= 0 || (statSync(path, { throwIfNoEntry: false })?.size ?? 0) < end || byteAt(path, end - 1) !== 0x0a) return false;
  return countLines(path, end) === lines;
}

/** Every rollout of a thread: rollout-<time>-<thread>.jsonl and its rollout-<time>-<thread>_<segment>.jsonl. */
function threadRollouts(home: string, threadId: string): string[] {
  const sessions = join(home, "sessions");
  return readdir(sessions).flatMap((year) => readdir(join(sessions, year)).flatMap((month) =>
    readdir(join(sessions, year, month)).flatMap((day) => readdir(join(sessions, year, month, day))
      .filter((name) => name.endsWith(`-${threadId}.jsonl`) || name.includes(`-${threadId}_`))
      .map((name) => join(sessions, year, month, day, name)))));
}

/**
 * Paginated rollouts (Codex 0.156) do not copy history. A backtrack or fork starts
 * a new file whose session_meta.history_base names what it continues by thread,
 * ordinal and byte: the same thread before a backtrack, the parent after a fork.
 * The bytes past that cut are the turns the backtrack discarded. A thread can have
 * several rollouts (one per backtrack) and a later backtrack can cut into any of
 * them, so the one that continues is the one that holds the cut (holdsCut), never
 * guessed from names or sizes. A chain that stops at a cut no file holds shows
 * less history rather than the wrong one, and is looked up again next time.
 */
function historyChain(path: string, home: string): HistorySegment[] {
  const cached = historyChains.get(path);
  if (cached && (cached.complete || Date.now() - cached.at < INCOMPLETE_CHAIN_MS)) return cached.chain;
  const remember = (chain: HistorySegment[], complete: boolean): HistorySegment[] => {
    historyChains.delete(path);
    historyChains.set(path, { chain, complete, at: Date.now() });
    if (historyChains.size > 64) historyChains.delete(historyChains.keys().next().value!);
    return chain;
  };
  const chain: HistorySegment[] = [];
  let current = path;
  for (let depth = 0; depth < 32; depth++) {
    let base: RecordValue;
    try { base = record(rolloutHeader(current)?.history_base); } catch { return remember(chain, false); }
    const threadId = string(base.thread_id);
    const ordinal = base.end_ordinal_exclusive;
    const end = base.end_byte_offset;
    if (Object.keys(base).length === 0) return remember(chain, true);
    if (!UUID.test(threadId) || typeof ordinal !== "number" || !Number.isSafeInteger(ordinal)
      || typeof end !== "number" || !Number.isSafeInteger(end) || end <= 0) return remember(chain, false);
    const holders = threadRollouts(home, threadId).flatMap((candidate) => {
      const resolved = codexRolloutPath(candidate, home);
      return resolved !== null && resolved !== current && !chain.some((segment) => segment.path === resolved)
        && holdsCut(resolved, ordinal, end) ? [resolved] : [];
    });
    if (holders.length !== 1) return remember(chain, false);
    chain.push({ path: holders[0]!, end });
    current = holders[0]!;
  }
  return remember(chain, false);
}

/**
 * historyChain, for reading now: a remembered chain can outlive its files (a parent
 * archived since, moved out of sessions/). Then it is looked up again and comes back
 * shorter, so the stream's id changes and a cursor into the old chain answers 409 once.
 */
function liveChain(path: string, home: string): HistorySegment[] {
  const chain = historyChain(path, home);
  if (chain.every((segment) => statSync(segment.path, { throwIfNoEntry: false }))) return chain;
  forgetHistoryChain(path);
  return historyChain(path, home);
}

/** A Codex conversation's files oldest first, each with how many of its bytes belong to it. */
export function codexHistorySegments(path: string, home = defaultCodexHome()): HistorySegment[] {
  return [...liveChain(path, home)].reverse().concat({ path, end: statSync(path).size });
}

/**
 * The last `budget` bytes of a Codex conversation, across the earlier rollouts a
 * paginated one continues. A rollout can reach hundreds of MB while the chat
 * shows only its latest turns, so nothing before the budget is read.
 */
export function codexHistoryTail(path: string, budget: number, home = defaultCodexHome()): string {
  const chunks: string[] = [];
  let remaining = budget;
  for (const segment of [{ path, end: statSync(path).size }, ...liveChain(path, home)]) {
    if (remaining <= 0) break;
    const start = Math.max(0, segment.end - remaining);
    chunks.unshift(readRange(segment.path, start, segment.end));
    remaining -= segment.end - start;
  }
  return chunks.join("\n");
}

const normalizeDisplay = (text: string): string => text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * What of an answer to look for on screen: its last 160 letters and digits. Codex shows a
 * markdown link as its label and the target relative to the cwd ("label (docs/x.md)" for
 * `[label](/repo/docs/x.md)`), so the text is cut at link targets, and the anchor is the end of
 * the last piece long enough. Without links, that is the end of the whole text.
 */
function answerAnchor(text: string): string | null {
  const pieces = text.split(/\]\([^)\s]*\)/);
  for (let index = pieces.length - 1; index >= 0; index--) {
    const anchor = normalizeDisplay(pieces[index]!).slice(-160);
    if (anchor.length >= 64 && new Set(anchor).size >= 12) return anchor;
  }
  return null;
}

/** Shared app-server TUIs do not hold rollout descriptors. For read-only display,
 * require a unique substantial assistant-message match in this pane's output.
 * Directory recency alone is never evidence: multiple panes can share a cwd. */
export function matchCodexTranscript(screen: string, candidates: { path: string; text: string }[]): string | null {
  const lastHeader = screen.lastIndexOf("OpenAI Codex (v");
  const display = normalizeDisplay(lastHeader >= 0 ? screen.slice(lastHeader) : screen);
  const matching = new Set<string>();
  for (const candidate of candidates) {
    const prose = parseCodexTranscript(candidate.text).filter((turn) => turn.role === "assistant")
      .flatMap((turn) => turn.parts).filter((part) => part.kind === "text").slice(-8);
    if (prose.some((part) => {
      const anchor = answerAnchor(part.text);
      return anchor !== null && display.includes(anchor);
    })) matching.add(candidate.path);
  }
  return matching.size === 1 ? [...matching][0]! : null;
}

/**
 * A text cut at its markdown link targets: each stretch of text with the target that follows it
 * ("" after the last). A scan, not a split at /\]\([^)\s]*\)/: that rescans to the end of the
 * text from every "](" no ")" closes, quadratic in a text full of them.
 */
function cutAtLinkTargets(text: string): { text: string; target: string }[] {
  const pieces: { text: string; target: string }[] = [];
  let start = 0;
  let search = 0;
  for (let at = text.indexOf("](", search); at >= 0; at = text.indexOf("](", search)) {
    let end = at + 2;
    while (end < text.length && text[end] !== ")" && !/\s/.test(text[end]!)) end++;
    // unclosed: no "](" before `end` is closed either, so all of it stays text
    if (text[end] !== ")") { search = end; continue; }
    pieces.push({ text: text.slice(start, at), target: text.slice(at + 2, end) });
    start = search = end + 1;
  }
  pieces.push({ text: text.slice(start), target: "" });
  return pieces;
}

/**
 * An answer as the screen shows it, for matchShortCodexAnswers: its last 160 letters and digits.
 * null for one with a link: Codex shows `[label](target)` as "label (target)" with the target its
 * own way, so the answer is not one run of text there, and its pieces alone are short common words.
 */
function shownAnswer(text: string): string | null {
  return cutAtLinkTargets(text).length > 1 ? null : normalizeDisplay(text).slice(-160);
}

/**
 * A rollout's newest answers on screen, newest lowest: whole answers taken from the end of the
 * rollout one after another (the very newest may be skipped: it may not be rendered yet, or hold
 * a link), each at least 16 letters and digits, found bottom-up in order, until at least two of
 * them hold 64 with 12 distinct. The answers that did, or null. A gap ends the run: an answer of
 * the rollout not on screen means the screen is not showing this rollout's end.
 */
function newestAnswersShown(display: string, answers: string[]): string[] | null {
  const newest = answers.slice(-5).map(shownAnswer).reverse();
  for (const skip of [0, 1]) {
    let before = display.length;
    const shown: string[] = [];
    for (const answer of newest.slice(skip, skip + 4)) {
      const at = answer === null || answer.length < 16 || answer.length > before ? -1 : display.lastIndexOf(answer, before - answer.length);
      if (at < 0) break;
      before = at;
      shown.push(answer!);
      const joined = shown.join("");
      if (shown.length >= 2 && joined.length >= 64 && new Set(joined).size >= 12) return shown;
    }
  }
  return null;
}

/**
 * The last resort for a pane nothing else ties to a rollout (codexTranscriptPath): a session
 * whose answers are all short never has an anchor for matchCodexTranscript, yet its newest
 * answers on screen together say as much as one long one (#283). Weaker evidence, so it gives
 * up readily: every candidate must have been read whole (none `cut`: past the read budget, or
 * continuing another rollout, whose answers it shares), only one may show that way, and no other
 * may have said any of the answers it showed, alone or inside a longer one.
 */
export function matchShortCodexAnswers(screen: string, candidates: { path: string; text: string; cut?: boolean }[]): string | null {
  if (candidates.some((candidate) => candidate.cut)) return null;
  const lastHeader = screen.lastIndexOf("OpenAI Codex (v");
  const display = normalizeDisplay(lastHeader >= 0 ? screen.slice(lastHeader) : screen);
  // every turn of what was read, not the newest 100: an answer said long ago is said
  const answers = candidates.map((candidate) => parseCodexTranscript(candidate.text, Infinity).filter((turn) => turn.role === "assistant")
    .flatMap((turn) => turn.parts).flatMap((part) => part.kind === "text" ? [part.text] : []));
  let found: { index: number; shown: string[] } | null = null;
  for (const [index, own] of answers.entries()) {
    const shown = newestAnswersShown(display, own);
    if (shown === null) continue;
    if (found !== null) return null;
    found = { index, shown };
  }
  if (found === null) return null;
  const { index: only, shown } = found;
  for (const [index, other] of answers.entries()) {
    if (index === only) continue;
    const said = normalizeDisplay(other.join("\n"));
    if (shown.some((answer) => said.includes(answer))) return null;
    // an answer of the other with links shows as its text around them, the targets Codex's own
    // way: when that text is all in a shown answer, in order, the screen may be showing the other
    // every such answer of what was read, however short its text or many its links: one left
    // unchecked is one the screen may be showing
    for (const text of other) {
      const pieces = cutAtLinkTargets(text);
      if (pieces.length < 2) continue;
      const around = pieces.map((piece) => normalizeDisplay(piece.text)).filter((piece) => piece !== "");
      if (around.length === 0) continue;
      if (shown.some((answer) => { let from = 0; return around.every((piece) => { const at = answer.indexOf(piece, from); from = at + piece.length; return at >= 0; }); })) return null;
    }
  }
  return candidates[only]!.path;
}

interface CodexExchange { user: string; assistant: string }
interface CodexFirstExchangeCandidate {
  path: string;
  text: string;
  firstUserMessage?: string | null;
  createdAtMs?: number;
}

const normalizePrompt = (text: string): string => text.trim().replace(/\s+/g, " ");

/** User/assistant exchanges as recorded, retaining later prompts as competing evidence. */
function codexExchanges(text: string): CodexExchange[] {
  const turns = parseCodexTranscript(text, Infinity);
  const exchanges: CodexExchange[] = [];
  let user: string | null = null;
  let assistant: string[] = [];
  const finish = () => {
    if (user !== null) exchanges.push({ user, assistant: assistant.join("\n") });
  };
  for (const turn of turns) {
    const prose = turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n");
    if (turn.role === "user") {
      finish();
      user = prose;
      assistant = [];
    } else if (user !== null && prose !== "") assistant.push(prose);
  }
  finish();
  return exchanges;
}

/** The first top-level prompt and its following assistant output, after this TUI's header. */
function displayedFirstExchange(screen: string): CodexExchange | null {
  const header = screen.lastIndexOf("OpenAI Codex (v");
  if (header < 0) return null;
  const lines = screen.slice(header).split(/\r?\n/);
  let promptAt = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^•(?:[ \t]|$)/.test(line)) return null;
    if (/^›[ \t]+/.test(line)) { promptAt = index; break; }
  }
  if (promptAt < 0) return null;
  let answerAt = -1;
  for (let index = promptAt + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^›[ \t]+/.test(line)) return null;
    if (/^•(?:[ \t]|$)/.test(line)) { answerAt = index; break; }
  }
  if (answerAt < 0) return null;
  const user = lines.slice(promptAt, answerAt).map((line, index) => index === 0 ? line.slice(1) : line).join("\n");
  const nextPrompt = lines.findIndex((line, index) => index > answerAt && /^›(?:[ \t]|$)/.test(line));
  const response = lines.slice(answerAt, nextPrompt < 0 ? undefined : nextPrompt)
    .map((line) => /^•/.test(line) ? line.slice(1) : line).join("\n");
  return { user, assistant: response };
}

function matchingCodexExchanges(screen: string, candidates: readonly CodexFirstExchangeCandidate[]): { candidate: CodexFirstExchangeCandidate; index: number }[] {
  const shown = displayedFirstExchange(screen);
  if (shown === null) return [];
  const prompt = normalizePrompt(shown.user);
  const answer = normalizePrompt(shown.assistant);
  if (normalizeDisplay(prompt).length < 8 || normalizeDisplay(answer).length < 16) return [];
  const matches: { candidate: CodexFirstExchangeCandidate; index: number }[] = [];
  for (const candidate of candidates) {
    for (const [index, exchange] of codexExchanges(candidate.text).entries()) {
      const recordedPrompt = normalizePrompt(exchange.user);
      const recordedAnswer = normalizePrompt(exchange.assistant);
      if (recordedPrompt === prompt && recordedAnswer !== ""
        && (answer.includes(recordedAnswer) || recordedAnswer.includes(answer))) {
        matches.push({ candidate, index });
      }
    }
  }
  return matches;
}

/** Match a submitted first prompt and its answer only when no competing exchange explains it. */
export function matchCodexFirstExchange(
  screen: string,
  candidates: readonly CodexFirstExchangeCandidate[],
  startedAtMs: number,
): string | null {
  if (!Number.isFinite(startedAtMs)) return null;
  if (candidates.filter((candidate) => typeof candidate.createdAtMs === "number"
    && candidate.createdAtMs >= startedAtMs).length !== 1) return null;
  const matches = matchingCodexExchanges(screen, candidates);
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const first = codexExchanges(match.candidate.text)[0];
  const storedPrompt = normalizePrompt(match.candidate.firstUserMessage ?? "");
  const shown = displayedFirstExchange(screen);
  if (match.index !== 0 || first === undefined || shown === null
    || normalizeDisplay(storedPrompt).length < 8
    || normalizePrompt(first.user) !== storedPrompt
    || normalizePrompt(first.assistant) !== normalizePrompt(shown.assistant)
    || typeof match.candidate.createdAtMs !== "number"
    || !Number.isFinite(match.candidate.createdAtMs) || match.candidate.createdAtMs < startedAtMs) return null;
  return match.candidate.path;
}

/** `codex resume <thread>`: the thread a TUI was started on, straight from its command line. */
export function resumedThread(argvs: readonly (readonly string[])[]): string | null {
  for (const argv of argvs) {
    const at = argv.indexOf("resume");
    const thread = at < 0 ? undefined : argv[at + 1];
    if (thread !== undefined && UUID.test(thread)) return thread;
  }
  return null;
}

/** The rollout each pane's Codex was last matched to on screen, the processes that were running it, and when. */
const boundRollouts = new Map<string, { processes: string; path: string; at: number }>();

/**
 * Threads begun in this cwd since `since` (seconds) that this pane's Codex may have moved
 * on to (/new), as their rollouts. Only interactive threads count: subagents (often with
 * a NULL agent_role) and `codex exec` runs share their parent's cwd but never replace the
 * TUI's conversation. A thread another pane is bound to is that pane's (theirs).
 */
function newerThreads(db: Database, cwd: string, since: number, except: string | null, paneId: string, home: string, firsts?: Map<string, string>): string[] {
  const first = db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'first_user_message'").get() !== null ? ", first_user_message" : "";
  const { where, params } = storedCwdCondition(cwd);
  const rows = db.query<{ id: string; rollout_path: string; first_user_message?: string | null }, (string | number)[]>(
    `SELECT id, rollout_path${first} FROM threads WHERE ${where} AND archived = 0 AND agent_role IS NULL${interactive(db)} AND created_at >= ?`,
  ).all(...params, since);
  return theirs(rows.flatMap((row) => {
    if (row.id === except) return [];
    const path = codexRolloutPath(row.rollout_path, home) ?? row.rollout_path;
    if (typeof row.first_user_message === "string") firsts?.set(path, row.first_user_message);
    return [path];
  }), paneId);
}

/**
 * Interactive threads only, where the store says (`source`): subagents (often with a NULL
 * agent_role) and `codex exec` runs share a TUI's cwd but are never its conversation.
 */
function interactive(db: Database): string {
  return db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'source'").get() !== null
    ? " AND source IN ('cli', 'vscode')" : "";
}

/** The rollouts no other pane is bound to. */
function theirs(rollouts: string[], paneId: string, claimed: ReadonlySet<string> = new Set()): string[] {
  const elsewhere = new Set([...boundRollouts].flatMap(([pane, binding]) => pane === paneId ? [] : [binding.path]));
  return rollouts.filter((rollout) => !elsewhere.has(rollout) && !claimed.has(rollout));
}

/** Interpreter options that run code or load a module: whatever follows is not the script. */
const CODE_OPTIONS = new Set(["eval", "print", "require", "import", "loader", "experimental-loader", "input-type"]);
/** Interpreter and shell options that take no value, so the script may follow them directly. */
const VALUELESS_OPTIONS = new Set([
  "", "no-warnings", "no-deprecation", "trace-warnings", "trace-deprecation", "pending-deprecation", "throw-deprecation",
  "enable-source-maps", "preserve-symlinks", "preserve-symlinks-main", "expose-gc", "abort-on-uncaught-exception",
  "experimental-strip-types", "experimental-transform-types", "experimental-vm-modules", "experimental-require-module",
  "no-experimental-fetch", "harmony", "bun", "smol", "hot", "watch", "noprofile", "norc", "posix", "login",
]);

/** A pane's Codex executables (or interpreter scripts), and their pids as one key. */
async function codexProcessesOf(paneId: string): Promise<{ list: { pid: number; argv?: string[] }[]; key: string }> {
  const processInfo = await paneProcessInfo(paneId);
  // herdr's schema allows `argv: null`; this reader has always read argv as absent or a list
  // (the cast is the inline result type herdrRpc was given before the typed seam)
  const list = ((processInfo?.foreground_processes ?? []) as { pid: number; argv?: string[] }[])
    .map((foreground) => {
      if (foreground.argv?.length || process.platform !== "linux") return foreground;
      // herdr can report only pid/name. Read this process, never infer argv from
      // its name; an exited or inaccessible process provides no binding evidence.
      try {
        return { ...foreground, argv: readFileSync(`/proc/${foreground.pid}/cmdline`, "utf8").split("\0") };
      } catch { return foreground; }
    })
    .filter(({ argv = [] }) => {
      const executable = argv[0] ?? "";
      const codex = /(?:^|[\\/])codex(?:\.js|\.exe|\.opencodex-real)?$/;
      if (codex.test(executable)) return true;
      // `node codex.js` and shell shebangs name the script after the interpreter and its
      // `--flag` options (`node --no-warnings codex.js`). Only options known to take no
      // value may precede the script, plus `--name=value` forms that do not run code: an
      // option that takes the next argument (`--title x`, `-e`, `-c`) or one that evaluates
      // code or loads a module ends the search, since what follows it is not the script.
      // Later arguments (echo, etc.) are not executables.
      if (!/(?:^|[\\/])(?:node|bun|sh|bash|dash|zsh)(?:\.exe)?$/.test(executable)) return false;
      let script = 1;
      for (; argv[script]?.startsWith("--"); script++) {
        const option = argv[script] ?? "";
        const name = option.slice(2, option.includes("=") ? option.indexOf("=") : undefined);
        if (CODE_OPTIONS.has(name)) return false;
        if (!option.includes("=") && !VALUELESS_OPTIONS.has(name)) return false;
      }
      return codex.test(argv[script] ?? "");
    });
  return { list, key: list.map((process) => process.pid).sort((left, right) => left - right).join(",") };
}

/** When each pane last looked at the other Codex panes for a set of threads, and which panes those were. */
const claimChecks = new Map<string, { panes: string; at: number }>();
const CLAIM_CHECK_MS = 5000;

/**
 * Which of `threads` (rollouts) another Codex pane in this cwd shows, as its own: a pane
 * claims a thread when its screen shows the thread's first message (typed there) and an
 * answer of it, and the match is unique against this pane's threads and that pane's
 * binding too. A pane that shows one is bound to it, whether or not anyone opened its
 * chat, and that thread is theirs, not a /new of this pane. The same threads and panes are
 * looked at again at most every 5s: a pane whose answer is not on screen yet is tried then.
 *
 * Trade-off: the first message must still be in that pane's last 400 lines and read as at
 * least 8 letters or digits. After a long session with this chat closed, or for a first
 * message like "hi", the thread is never claimed, and this pane says it cannot tell while
 * its own answer is off screen, until that pane's chat binds it. Never another conversation.
 */
async function claimedByOtherPanes(paneId: string, cwd: string, threads: string[], own: string[], firsts: ReadonlyMap<string, string>, home: string, sessionPanes?: HerdrPane[]): Promise<Set<string>> {
  const claimed = new Set<string>();
  const key = `${paneId}\0${[...threads].sort().join("\0")}`;
  const panes = codexPeersIn(sessionPanes ?? (await sessionSnapshot()).panes, paneId, cwd).slice(0, 8);
  // a pane that appeared since is looked at at once
  const last = claimChecks.get(key);
  const seen = panes.map((pane) => pane.pane_id).join();
  if (panes.length === 0 || (last !== undefined && last.panes === seen && Date.now() - last.at < CLAIM_CHECK_MS)) return claimed;
  claimChecks.set(key, { panes: seen, at: Date.now() });
  if (claimChecks.size > 64) claimChecks.delete(claimChecks.keys().next().value!);
  const tail = (path: string) => { try { return [{ path, text: codexHistoryTail(path, 1024 * 1024, home) }]; } catch { return []; } };
  const candidates = threads.flatMap(tail);
  if (candidates.length === 0) return claimed;
  // a screen is matched against this pane's own threads and that pane's too, not only the
  // new ones: an answer of this pane quoted over there is then not unique, and claims nothing
  const known = [...new Set(own)].flatMap(tail);
  for (const pane of panes) {
    try {
      const theirsNow = boundRollouts.get(pane.pane_id)?.path;
      const screen = await paneRead({ paneId: pane.pane_id, source: "recent", lines: 400, stripAnsi: true });
      const possible = [...new Map([...candidates, ...known, ...(theirsNow && !threads.includes(theirsNow) && !own.includes(theirsNow) ? tail(theirsNow) : [])]
        .map((candidate) => [candidate.path, candidate])).values()];
      const shown = matchCodexTranscript(screen.text, possible);
      if (shown === null || !threads.includes(shown)) continue;
      // and the thread's first message shows there too: typed in that pane, not only its answer
      // quoted or pasted there (a thread whose first message is gone from that screen stays unclaimed)
      const first = normalizeDisplay(firsts.get(shown) ?? "").slice(0, 48);
      if (firsts.has(shown) && (first.length < 8 || !normalizeDisplay(screen.text).includes(first))) continue;
      claimed.add(shown);
      const processes = (await codexProcessesOf(pane.pane_id)).key;
      if (processes !== "") {
        boundRollouts.delete(pane.pane_id);
        boundRollouts.set(pane.pane_id, { processes, path: shown, at: Date.now() });
        if (boundRollouts.size > 64) boundRollouts.delete(boundRollouts.keys().next().value!);
      }
    } catch { /* a pane closed meanwhile */ }
  }
  return claimed;
}

/** Whether another Codex pane in this cwd was started as `codex resume <thread>`. */
async function resumedElsewhere(paneId: string, cwd: string, thread: string, sessionPanes?: HerdrPane[]): Promise<boolean> {
  const panes = codexPeersIn(sessionPanes ?? (await sessionSnapshot()).panes, paneId, cwd);
  for (const pane of panes) {
    try {
      if (resumedThread((await codexProcessesOf(pane.pane_id)).list.map((process) => process.argv ?? [])) === thread) return true;
    } catch { /* a pane closed meanwhile */ }
  }
  return false;
}

interface CodexThreadRow {
  rolloutPath: string;
  firstUserMessage: string | null;
  createdAtMs: number;
}

const SHORT_THREAD_LIMIT = 32;
const SHORT_ROLLOUT_LIMIT = 1024 * 1024;

/** Short matching needs every competing exchange, so incomplete or unsafe rows disable it. */
function safeShortThreads(rows: readonly CodexThreadRow[], home: string): CodexFirstExchangeCandidate[] | null {
  if (rows.length === 0 || rows.length > SHORT_THREAD_LIMIT) return null;
  const candidates: CodexFirstExchangeCandidate[] = [];
  for (const row of rows) {
    const path = codexRolloutPath(row.rolloutPath, home);
    if (path === null) return null;
    try {
      const stat = statSync(path);
      const header = rolloutHeader(path);
      if (!stat.isFile() || stat.size <= 0 || stat.size > SHORT_ROLLOUT_LIMIT || header === null
        || Object.keys(record(header.history_base)).length > 0) return null;
      const text = readRange(path, 0, stat.size);
      const after = statSync(path);
      if (Buffer.byteLength(text, "utf8") !== stat.size
        || after.size !== stat.size || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs
        || !text.endsWith("\n")) return null;
      const lines = text.slice(0, -1).split(/\r?\n/);
      if (lines.length === 0 || lines.some((line) => {
        try { JSON.parse(line); return false; } catch { return true; }
      })) return null;
      const exchanges = codexExchanges(text);
      const stored = normalizePrompt(row.firstUserMessage ?? "");
      if (stored !== "" && (exchanges[0] === undefined || normalizePrompt(exchanges[0].user) !== stored)) return null;
      candidates.push({
        path,
        text,
        firstUserMessage: row.firstUserMessage,
        createdAtMs: row.createdAtMs,
      });
    } catch { return null; }
  }
  return candidates;
}

/**
 * The prompt is not ownership evidence on its own. Require its submitted answer,
 * compare older conversations too, and decline while another same-directory Codex
 * pane could own the thread. No weak binding or cached peer claim survives a poll.
 */
async function shortThreadFromProcess(
  paneId: string, cwd: string, home: string, screen: string,
  processes: readonly { pid: number }[], panes?: HerdrPane[],
): Promise<string | null> {
  const starts = processes.map(({ pid }) => processStartedAt(pid));
  if (starts.length === 0 || starts.some((start) => start === null || !Number.isFinite(start))) return null;
  const startedAt = Math.min(...starts as number[]);
  const notBefore = startedAt + 1000;
  let db: Database | undefined;
  try {
    const peers = panes ?? (await sessionSnapshot()).panes;
    if (peers.some((pane) => pane.pane_id !== paneId
      && (pane.agent ?? pane.agent_session?.agent) === "codex"
      && (pane.cwd == null || sameDirectory(pane.cwd, cwd)))) return null;
    db = new Database(join(home, "state_5.sqlite"), { readonly: true, create: false });
    const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('threads')").all().map((column) => column.name));
    if (!columns.has("first_user_message") || !columns.has("source")) return null;
    const created = columns.has("created_at_ms") ? "COALESCE(created_at_ms, created_at * 1000)" : "created_at * 1000";
    // The 33rd row disables this bounded lookup, never establishes uniqueness.
    const { where, params } = storedCwdCondition(cwd);
    const rows = db.query<CodexThreadRow, string[]>(
      `SELECT rollout_path AS rolloutPath, first_user_message AS firstUserMessage, ${created} AS createdAtMs
       FROM threads WHERE ${where} AND archived = 0 AND agent_role IS NULL${interactive(db)} LIMIT 33`,
    ).all(...params);
    if (rows.length > SHORT_THREAD_LIMIT || rows.some((row) => !Number.isFinite(row.createdAtMs))) return null;
    // Process starts are only estimated to second precision; require a full second of margin.
    const begun = rows.filter((row) => row.createdAtMs >= notBefore);
    if (begun.length !== 1) return null;
    const candidates = safeShortThreads(rows, home);
    if (candidates === null) return null;
    const path = matchCodexFirstExchange(screen, candidates, notBefore);
    return path !== null && theirs([path], paneId).length === 1 ? path : null;
  } catch { return null; }
  finally { db?.close(); }
}

/** The pane's Codex processes, and the rollouts they hold open (lsof on macOS, /proc elsewhere): one alone is the pane's. */
async function openRollouts(paneId: string, home: string): Promise<{ codexProcesses: Awaited<ReturnType<typeof codexProcessesOf>>["list"]; processes: string; open: Set<string> }> {
  const { list: codexProcesses, key: processes } = await codexProcessesOf(paneId);
  const open = new Set<string>();
  if (globalThis.process.platform === "darwin" && codexProcesses.length > 0) {
    // lsof is available on macOS, where /proc does not exist. Keep the same
    // canonical-store and unambiguous-open-file checks as the Linux path. One run
    // for every Codex process of the pane (a wrapper and the binary are two), and
    // -b keeps lsof off the stat calls it does not need for a name: a chat reads this up
    // to every 2 s while its transcript changes, the conversation monitor every 5 s, and
    // each run costs about 20 ms of process start and kernel walk
    const child = Bun.spawn(["/usr/sbin/lsof", "-nPbw", "-a", "-p", codexProcesses.map((process) => process.pid).join(","), "-Fn"], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      const text = await new Response(child.stdout).text();
      await child.exited;
      for (const line of text.split("\n")) {
        if (!line.startsWith("n") || !line.endsWith(".jsonl")) continue;
        const path = codexRolloutPath(line.slice(1), home);
        if (path) open.add(path);
      }
    } finally { clearTimeout(timer); }
  }
  for (const process of codexProcesses) {
    if (globalThis.process.platform === "darwin") continue;
    let descriptors: string[];
    try { descriptors = readdirSync(`/proc/${process.pid}/fd`); } catch { continue; }
    for (const descriptor of descriptors.slice(0, 512)) {
      try {
        const target = readlinkSync(`/proc/${process.pid}/fd/${descriptor}`);
        if (!target.endsWith(".jsonl")) continue;
        const path = codexRolloutPath(target, home);
        if (path) open.add(path);
      } catch { /* A descriptor may close while enumerating it. */ }
    }
  }
  return { codexProcesses, processes, open };
}

/**
 * The rollout a pane's Codex writes when that is certain without reading its screen: the path
 * herdr reports, the one rollout its processes hold open, or the one a chat read last matched to
 * the same processes while no thread begun in `cwd` since may have replaced it (/new). Nothing is
 * matched or bound here, so a reader in the background (the session plan, server/session-plan.ts)
 * never changes what codexTranscriptPath decides for the chat. Unlike the chat it does not ask the
 * other panes' screens whose a newer thread is: such a thread leaves it unsure until a chat read
 * matches the pane again.
 */
export async function codexOpenRollout(paneId: string, cwd: string | null | undefined, home = defaultCodexHome()): Promise<string | null> {
  const session = (await agentGet(paneId)).agent_session;
  if (session?.kind === "path" && session.value) return codexRolloutPath(session.value, home);
  const { processes, open } = await openRollouts(paneId, home);
  if (open.size === 1) return [...open][0]!;
  const bound = boundRollouts.get(paneId);
  if (bound === undefined || bound.processes !== processes || processes === "" || !cwd || codexRolloutPath(bound.path, home) === null) return null;
  let db: Database | undefined;
  try {
    db = new Database(join(home, "state_5.sqlite"), { readonly: true, create: false });
    return newerThreads(db, cwd, Math.floor(bound.at / 1000), null, paneId, home).length === 0 ? bound.path : null;
  } catch {
    // no store to ask, as codexTranscriptPath then keeps its binding too
    return bound.path;
  } finally { db?.close(); }
}

/**
 * The rollout a pane's Codex writes, or null when nothing tells. `panes`: the session's
 * panes, when the caller has them (saves a snapshot, and closed panes' bindings go).
 *
 * The thread id herdr has for a Codex pane is a hint, not proof: Codex's SessionStart
 * hook reports it, and since Codex 0.157 that hook runs in the app-server daemon every
 * Codex TUI shares. The daemon keeps the environment of the TUI that started it, so each
 * TUI's thread is reported to that first pane (live-verified 2026-09-26 with Codex
 * 0.157.1: a pane resumed on thread A left the daemon's own pane holding A). What
 * shows on screen decides first; the id is used only when nothing does and no other
 * pane owns that thread.
 */
export async function codexTranscriptPath(paneId: string, cwd: string, home = defaultCodexHome(), panes?: HerdrPane[]): Promise<string | null> {
  if (panes !== undefined) {
    const open = new Set(panes.map((pane) => pane.pane_id));
    for (const pane of [...boundRollouts.keys()]) if (!open.has(pane)) boundRollouts.delete(pane);
  }
  const session = (await agentGet(paneId)).agent_session;
  if (session?.kind === "path" && session.value) return codexRolloutPath(session.value, home);

  const { codexProcesses, processes, open } = await openRollouts(paneId, home);
  if (open.size === 1) return [...open][0]!;
  const resumed = resumedThread(codexProcesses.map((process) => process.argv ?? []));

  let db: Database | undefined;
  let paths: string[] = [...open];
  let resumedPath: string | null = null;
  let resumedNewer: string[] = [];
  /** the first message of each newer thread, when the store keeps it */
  const firsts = new Map<string, string>();
  const bound = boundRollouts.get(paneId);
  const boundHere = bound !== undefined && bound.processes === processes && processes !== "" ? bound : undefined;
  let boundNewer: string[] = [];
  /** the rollout of the thread herdr has for this pane */
  let reported: string | null = null;
  /** whether every interactive thread in this cwd is among the candidates */
  let listed = false;
  try {
    db = new Database(join(home, "state_5.sqlite"), { readonly: true, create: false });
    if (session?.value && UUID.test(session.value)) {
      const first = db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'first_user_message'").get() !== null ? ", first_user_message" : "";
      const row = db.query<{ rollout_path: string; first_user_message?: string | null }, [string]>(`SELECT rollout_path${first} FROM threads WHERE id = ?`).get(session.value);
      reported = row ? codexRolloutPath(row.rollout_path, home) : null;
      if (reported !== null && typeof row?.first_user_message === "string") firsts.set(reported, row.first_user_message);
    }
    if (resumed !== null) {
      const row = db.query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id = ?").get(resumed);
      // After /new the command line still names the resumed thread. Trust it only while
      // no other interactive thread in this cwd began after this Codex did (newerThreads;
      // one no other pane shows counts too: then the chat says it cannot tell, rather
      // than show the wrong conversation). Without a start time, since the resumed
      // thread was last updated.
      const startedAt = Math.min(...codexProcesses.map((process) => processStartedAt(process.pid) ?? Infinity));
      const since = Number.isFinite(startedAt)
        ? Math.floor(startedAt / 1000)
        : (db.query<{ updated_at: number }, [string]>("SELECT updated_at FROM threads WHERE id = ?").get(resumed)?.updated_at ?? 0);
      resumedPath = row ? codexRolloutPath(row.rollout_path, home) : null;
      resumedNewer = newerThreads(db, cwd, since, resumed, paneId, home, firsts);
    }
    // the same guard for a match: after /new the process writes a thread begun since
    // (created_at has whole seconds, so one begun in the match's second counts too)
    if (boundHere !== undefined) boundNewer = newerThreads(db, cwd, Math.floor(boundHere.at / 1000), null, paneId, home, firsts);
    const { where, params } = storedCwdCondition(cwd);
    const rows = db.query<{ rollout_path: string }, string[]>(
      // a burst of `codex exec` runs must not push the pane's own thread out of the 32
      `SELECT rollout_path FROM threads WHERE ${where} AND archived = 0 AND agent_role IS NULL${interactive(db)} ORDER BY updated_at DESC LIMIT 33`,
    ).all(...params);
    const rollouts = rows.slice(0, 32).map((row) => codexRolloutPath(row.rollout_path, home));
    // a thread whose rollout is gone or outside the store is still a conversation of this cwd
    listed = rows.length <= 32 && !rollouts.includes(null);
    paths = [...new Set([...paths, ...(reported !== null ? [reported] : []), ...rollouts.filter((path): path is string => path !== null)])];
  } catch { /* Older installations can still resolve their open descriptors. */ }
  finally { db?.close(); }
  const screen = paths.length ? await paneRead({ paneId, source: "recent", lines: 400, stripAnsi: true }) : null;
  const candidates = paths.flatMap((path) => {
    try { return [{ path, text: codexHistoryTail(path, 1024 * 1024, home) }]; } catch { return []; }
  });
  const matched = screen ? matchCodexTranscript(screen.text, candidates) : null;
  if (matched !== null) {
    boundRollouts.delete(paneId);
    boundRollouts.set(paneId, { processes, path: matched, at: Date.now() });
    if (boundRollouts.size > 64) boundRollouts.delete(boundRollouts.keys().next().value!);
    return matched;
  }
  // Nothing on screen tells: a long run of tool output pushed the last answer out of
  // the read, or nothing is answered yet. The same Codex process still writes the
  // rollout it was last matched to, while no thread begun since in this cwd leaves it
  // unsure: one another Codex pane here shows is that pane's. The binding is kept even
  // when unsure, so it holds again once that thread turns out to be another pane's.
  // Failing that, the thread herdr has for this pane, unless another pane shows it, is
  // bound to it, or was resumed on it. Failing that, the thread it was resumed on, under
  // the same rule as the binding.
  const unsure = [...new Set([...boundNewer, ...(resumedPath !== null ? resumedNewer : []), ...(reported !== null ? [reported] : [])])];
  if (unsure.length > 0) {
    const own = [boundHere?.path, resumedPath].filter((path): path is string => typeof path === "string");
    const claimed = await claimedByOtherPanes(paneId, cwd, unsure, own, firsts, home, panes);
    boundNewer = theirs(boundNewer, paneId, claimed);
    resumedNewer = theirs(resumedNewer, paneId, claimed);
    if (reported !== null && (theirs([reported], paneId, claimed).length === 0 || await resumedElsewhere(paneId, cwd, session!.value!, panes))) reported = null;
  }
  if (boundHere !== undefined && boundNewer.length === 0 && codexRolloutPath(boundHere.path, home) !== null) {
    // a pane in use stays among the kept ones
    boundRollouts.delete(paneId);
    boundRollouts.set(paneId, boundHere);
    return boundHere.path;
  }
  if (reported !== null) return reported;
  if (resumed !== null) return resumedNewer.length === 0 ? resumedPath : null;
  // Nothing ties this pane to a rollout at all: no session herdr names, no resume, no match by a
  // long answer for this process, and so no /new to be unsure about. Short answers on screen may
  // tell (#283). Never remembered as a binding: what it shows is read again each time, and only a
  // long answer binds the pane for when its screen no longer tells.
  if (screen === null || session?.value || boundHere !== undefined) return null;
  // and only against every conversation this pane may be running, read whole: one left out of
  // the 32 or one whose rollout is gone may be what said the same short lines
  if (!listed || candidates.length !== paths.length) return null;
  // read from each rollout itself, nothing remembered: one that continues another (a fork, a
  // backtrack) shares that one's answers, and one past the budget was not read whole
  let cut: boolean[];
  try {
    cut = candidates.map((candidate) => Object.keys(record(rolloutHeader(candidate.path)?.history_base)).length > 0 || statSync(candidate.path).size > 1024 * 1024);
  } catch { return null; }
  const short = matchShortCodexAnswers(screen.text, candidates.map((candidate, index) => ({ ...candidate, cut: cut[index] })));
  if (short !== null) return short;
  return shortThreadFromProcess(paneId, cwd, home, screen.text, codexProcesses, panes);
}
