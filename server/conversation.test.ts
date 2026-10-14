import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { MAX_TURNS, parseOmpTranscript } from "./transcript-records.ts";
import { toolVerb } from "../src/lib/toolVerbs.ts";
import type { ConversationTurn } from "../shared/protocol.ts";
import { parseAgyTranscript } from "./agy.ts";
import { agyStoreFromLocks } from "./agy-store.ts";
import * as agyStore from "./agy-store.ts";
import * as herdr from "./herdr/client.ts";
import { forgetHistoryChains } from "./codex.ts";
import { DevinHistoryChanged } from "./devin.ts";
import * as omo from "./omo.ts";
import { ConversationUnavailable, devinSessionForPane, forgetPaneTranscriptState, forgetTranscriptState, gjcTranscriptPath, HistoryChanged, isDevinProcess, isOmoProcess, ompSessionStore, paneConversation, paneTranscript, parseClaudeTranscript, unwrapPastes, transcriptImage, transcriptPage, transcriptToolOutput } from "./conversation.ts";

let mockedPanes: HerdrPane[] = [];
let mockedProcesses: { argv?: unknown }[] = [];

describe("Devin pane identity", () => {
  const restores: Array<() => void> = [];
  beforeEach(() => {
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => {
      if (method !== "pane.process_info") throw new Error(`unexpected conversation fixture RPC: ${method}`);
      return { process_info: { foreground_processes: mockedProcesses } } as never;
    });
    restores.push(() => rpc.mockRestore());
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: mockedPanes } as SessionSnapshot));
    restores.push(() => snapshot.mockRestore());
  });
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    mockedPanes = [];
    mockedProcesses = [];
    forgetTranscriptState();
  });
  const pane = { pane_id: "pane-a", cwd: "/synthetic/work", agent: "devin" } as HerdrPane;
  const shell = { pane_id: "pane-b", cwd: pane.cwd, agent_session: { agent: "devin", kind: "id", value: "stale" } } as HerdrPane;
  const peer = { pane_id: "pane-b", cwd: pane.cwd, agent: "devin" } as HerdrPane;
  const reported = { ...pane, agent_session: { agent: "devin", kind: "id", value: "one" } } as HerdrPane;
  it("never guesses a session from its directory or a stale shell agent_session", () => {
    expect(() => devinSessionForPane(pane, [pane], ["/bin/devin"])).toThrow(ConversationUnavailable);
    expect(() => devinSessionForPane(shell, [shell], ["/bin/devin", "--resume", "stale"])).toThrow(ConversationUnavailable);
  });
  it("accepts only an exact reported or resumed identity and does not consider shell peers", () => {
    expect(devinSessionForPane(reported, [reported, shell], ["/bin/devin"])).toBe("one");
    expect(devinSessionForPane(pane, [pane, shell], ["/bin/devin", "--resume=two"])).toBe("two");
    expect(() => devinSessionForPane(reported, [reported], ["/bin/devin", "--resume", "two"])).toThrow(ConversationUnavailable);
    expect(() => devinSessionForPane(reported, [reported], ["/bin/devin", "--resume=one", "-r", "two"])).toThrow(ConversationUnavailable);
    expect(() => devinSessionForPane(reported, [reported, { ...peer, agent_session: reported.agent_session }], ["/bin/devin"])).toThrow(ConversationUnavailable);
    expect(() => devinSessionForPane(pane, [pane], ["/bin/devin", "--", "--resume", "one"])).toThrow(ConversationUnavailable);
    expect(() => devinSessionForPane(pane, [pane], ["/bin/devin", "--resume"])).toThrow(ConversationUnavailable);
  });
  it("recognizes only Devin as the executable, not another argument", () => {
    expect(isDevinProcess(["/usr/bin/devin"])).toBeTrue();
    expect(isDevinProcess(["C:\\tools\\devin.exe"])).toBeTrue();
    expect(isDevinProcess(["node", "/tmp/devin"])).toBeFalse();
    expect(isDevinProcess(["sh", "-c", "devin --resume one"])).toBeFalse();
    expect(isDevinProcess(["/usr/bin/not-devin"])).toBeFalse();
  });
  it("reads through paneConversation only with live executable and explicit session evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-devin-pane-"));
    const dbPath = join(root, "sessions.db");
    const cwd = "/synthetic/work";
    const pane = { pane_id: "pane-a", cwd, foreground_cwd: cwd, agent: "devin", agent_session: { agent: "devin", kind: "id", value: "one" } } as HerdrPane;
    try {
      const db = new Database(dbPath);
      try {
        db.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT)");
        db.query("INSERT INTO sessions VALUES ('one', ?, 2, 0, 'synthetic-model')").run(cwd);
        db.query("INSERT INTO message_nodes VALUES ('one', 1, NULL, ?, 1700000000)").run(JSON.stringify({ role: "user", content: "synthetic question" }));
        db.query("INSERT INTO message_nodes VALUES ('one', 2, 1, ?, 1700000001)").run(JSON.stringify({ role: "assistant", content: "synthetic answer" }));
      } finally { db.close(); }
      mockedPanes = [pane];
      mockedProcesses = [{ argv: ["/usr/local/bin/devin"] }];
      const answer = await paneConversation(pane.pane_id, undefined, {}, dbPath);
      expect(answer.source).toBe("devin-transcript");
      expect(answer.turns.map((turn) => turn.parts[0])).toEqual([
        { kind: "text", text: "synthetic question" }, { kind: "text", text: "synthetic answer" },
      ]);
      mockedProcesses = [{ argv: ["/usr/bin/vim", "/usr/local/bin/devin"] }];
      await expect(paneConversation(pane.pane_id, undefined, {}, dbPath)).rejects.toThrow(ConversationUnavailable);
      mockedProcesses = [{ argv: ["/usr/local/bin/devin"] }];
      mockedPanes = [{ ...pane, agent_session: undefined }];
      await expect(paneConversation(pane.pane_id, undefined, {}, dbPath)).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_id" });
      mockedProcesses = [{ argv: ["/usr/local/bin/devin", "--resume=one"] }];
      expect((await paneConversation(pane.pane_id, undefined, {}, dbPath)).turns).toEqual(answer.turns);
    } finally {
      mockedPanes = [];
      mockedProcesses = [];
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not render Devin for a shell with a stale Devin session report", async () => {
    const pane = { pane_id: "pane-shell", cwd: "/synthetic/work", agent_session: { agent: "devin", kind: "id", value: "one" } } as HerdrPane;
    mockedPanes = [pane];
    mockedProcesses = [{ argv: ["/usr/local/bin/devin"] }];
    try {
      await expect(paneConversation(pane.pane_id, undefined, {}, "/missing/sessions.db")).rejects.toThrow(ConversationUnavailable);
    } finally {
      mockedPanes = [];
      mockedProcesses = [];
    }
  });
  it("falls back when the explicit store is inaccessible or malformed", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-devin-unavailable-"));
    const cwd = "/synthetic/work";
    const pane = { pane_id: "pane-a", cwd, agent: "devin", agent_session: { agent: "devin", kind: "id", value: "one" } } as HerdrPane;
    mockedPanes = [pane];
    mockedProcesses = [{ argv: ["/usr/local/bin/devin"] }];
    try {
      await expect(paneConversation(pane.pane_id, undefined, {}, join(root, "missing.db"))).rejects.toThrow(ConversationUnavailable);
      const dbPath = join(root, "malformed.db");
      const db = new Database(dbPath);
      try { db.exec("CREATE TABLE sessions(id TEXT)"); } finally { db.close(); }
      await expect(paneConversation(pane.pane_id, undefined, {}, dbPath)).rejects.toThrow(ConversationUnavailable);

      const oversizedPath = join(root, "oversized.db");
      const oversized = new Database(oversizedPath);
      try {
        oversized.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT); CREATE INDEX node_identity ON message_nodes(session_id, node_id); BEGIN");
        oversized.query("INSERT INTO sessions VALUES ('one', ?, 5001, 0, NULL)").run(cwd);
        const insert = oversized.query("INSERT INTO message_nodes VALUES ('one', ?, ?, '{\"role\":\"user\",\"content\":\"synthetic\"}', 1700000000)");
        for (let index = 1; index <= 5001; index++) insert.run(index, index === 1 ? null : index - 1);
        oversized.exec("COMMIT");
      } finally { oversized.close(); }
      await expect(paneConversation(pane.pane_id, undefined, {}, oversizedPath)).rejects.toThrow(ConversationUnavailable);
    } finally {
      mockedPanes = [];
      mockedProcesses = [];
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reads an omo that runs in a pane herdr still labels devin", async () => {
    const pane = { pane_id: "pane-a", cwd: "/synthetic/work", agent: "devin" } as HerdrPane;
    const session = spyOn(omo, "omoSessionForPane").mockImplementation(async () => ({ path: null, pending: "synthetic-id" }));
    mockedPanes = [pane];
    mockedProcesses = [{ argv: ["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"] }];
    try {
      expect(await paneConversation(pane.pane_id, undefined, {}, "/missing/sessions.db")).toMatchObject({ source: "omo-transcript", turns: [], history_id: "unwritten:synthetic-id" });
    } finally {
      session.mockRestore();
      mockedPanes = [];
      mockedProcesses = [];
    }
  });
  it("forgets a pane's Devin history cache on pane teardown and test-suite reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-devin-reset-"));
    const dbPath = join(root, "sessions.db");
    const cwd = "/synthetic/work";
    const pane = { pane_id: "pane-a", cwd, agent: "devin", agent_session: { agent: "devin", kind: "id", value: "one" } } as HerdrPane;
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT)");
      // more turns than one page holds, so the newest page carries a cursor
      db.query("INSERT INTO sessions VALUES ('one', ?, 120, 0, NULL)").run(cwd);
      const insert = db.query("INSERT INTO message_nodes VALUES ('one', ?, ?, ?, 1700000000)");
      for (let node = 1; node <= 120; node++) insert.run(node, node === 1 ? null : node - 1, JSON.stringify({ role: "user", content: `synthetic ${node}` }));
      mockedPanes = [pane];
      mockedProcesses = [{ argv: ["/usr/local/bin/devin", "--resume", "one"] }];
      // the store never changes below, so only a forgotten cache can move the identity
      const read = () => paneConversation(pane.pane_id, undefined, {}, dbPath);
      const initial = await read();
      expect(typeof initial.cursor).toBe("string");
      expect((await read()).history_id).toBe(initial.history_id);
      expect((await paneConversation(pane.pane_id, undefined, { before: initial.cursor! }, dbPath)).turns.length).toBe(20);
      forgetPaneTranscriptState(pane.pane_id);
      const paneReset = await read();
      expect(paneReset.history_id).not.toBe(initial.history_id);
      await expect(paneConversation(pane.pane_id, undefined, { before: initial.cursor! }, dbPath)).rejects.toThrow(DevinHistoryChanged);
      forgetTranscriptState();
      const testReset = await read();
      expect(testReset.history_id).not.toBe(paneReset.history_id);
      await expect(paneConversation(pane.pane_id, undefined, { before: paneReset.cursor! }, dbPath)).rejects.toThrow(DevinHistoryChanged);
    } finally {
      db.close();
      mockedPanes = [];
      mockedProcesses = [];
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Minimal but shape-true slices of a Claude Code session jsonl. */
const lines = [
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:00:00.000Z", message: { role: "user", content: "리팩터링 시작해줘" } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-09-19T08:00:02.000Z", message: { role: "assistant", content: [
    { type: "text", text: "먼저 상태를 확인하겠습니다." },
    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git status --short", description: "check tree" } },
  ] } }),
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:00:03.000Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "M src/app.ts" },
  ] } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-09-19T08:00:05.000Z", message: { role: "assistant", content: [
    { type: "thinking", thinking: "internal reasoning stays private" },
    { type: "text", text: "변경된 파일이 하나입니다." },
  ] } }),
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:01:00.000Z", message: { role: "user", content: "<command-name>/help</command-name>" } }),
].join("\n");

describe("parseClaudeTranscript", () => {
  it("builds user and merged assistant turns with folded tool results", () => {
    const turns = parseClaudeTranscript(lines);
    expect(turns).toEqual([
      { role: "user", ts: "2026-09-19T08:00:00.000Z", parts: [{ kind: "text", text: "리팩터링 시작해줘" }] },
      { role: "assistant", ts: "2026-09-19T08:00:02.000Z", end_ts: "2026-09-19T08:00:05.000Z", parts: [
        { kind: "text", text: "먼저 상태를 확인하겠습니다." },
        // the row says what the agent said the command is for; the command stays in the input
        { kind: "tool", name: "Bash", summary: "check tree", input: expect.stringContaining("git status"), output: "M src/app.ts" },
        { kind: "thinking", text: "internal reasoning stays private" },
        { kind: "text", text: "변경된 파일이 하나입니다." },
      ] },
    ]);
  });

  it("shows a pasted text without Claude Code's paste wrapper, in string and block prompts", () => {
    const pasted = '\n\n<pasted_content id="6d8b">\n| a | b |\n\nsecond paragraph\n</pasted_content id="6d8b">\n';
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", message: { role: "user", content: pasted } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `look at this${pasted}` }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "typed <\\pasted_content id=\"6d8b\"> stays" } }),
    ].join("\n"));
    expect(turns.map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "| a | b |\n\nsecond paragraph" },
      { kind: "text", text: "look at this\n\n| a | b |\n\nsecond paragraph" },
      { kind: "text", text: 'typed <\\pasted_content id="6d8b"> stays' },
    ]);
  });

  it("drops slash-command bookkeeping entries", () => {
    const turns = parseClaudeTranscript(lines);
    expect(turns.some((turn) => turn.parts.some((part) => part.kind === "text" && part.text.includes("/clear")))).toBe(false);
  });

  it("shows what a slash command answered, and leaves its echo and an empty answer out", () => {
    const local = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "local_command", isMeta: false, timestamp: ts, content });
    const refusal = "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy).";
    const turns = parseClaudeTranscript([
      local("<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>test</command-args>", "2026-10-07T19:00:00.000Z"),
      local(`<local-command-stdout>${refusal}</local-command-stdout>`, "2026-10-07T19:00:01.000Z"),
      local("<local-command-stdout></local-command-stdout>", "2026-10-07T19:00:02.000Z"),
      local("<local-command-stderr>\u001b[31mUnknown command: /gaol\u001b[39m</local-command-stderr>", "2026-10-07T19:00:03.000Z"),
      JSON.stringify({ type: "system", subtype: "turn_duration", content: "<local-command-stdout>not a command's answer</local-command-stdout>" }),
    ].join("\n"));
    expect(turns).toEqual([
      { role: "user", ts: "2026-10-07T19:00:01.000Z", parts: [{ kind: "notice", text: refusal, source: "local-command" }] },
      { role: "user", ts: "2026-10-07T19:00:03.000Z", parts: [{ kind: "notice", text: "Unknown command: /gaol", source: "local-command" }] },
    ]);
  });

  it("shows Claude Code's own notices, an unknown command's lines joined as one", () => {
    // Claude Code 2.1.294: an unknown command and its dropped arguments, 1ms apart, and no user turn
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, level: "warning", timestamp: ts });
    const turns = parseClaudeTranscript([
      info("Unknown command: /xyzabc", "2026-10-08T08:06:31.117Z"),
      info("Args from unknown skill: hello there", "2026-10-08T08:06:31.118Z"),
      info("Usage limit reached · continuing automatically at 4am · esc to cancel", "2026-10-08T09:00:00.000Z"),
      info("\u001b[2mUsage limit reset · continuing automatically\u001b[22m", "2026-10-08T13:00:00.000Z"),
      info("", "2026-10-08T13:00:01.000Z"),
    ].join("\n"));
    expect(turns).toEqual([
      { role: "user", ts: "2026-10-08T08:06:31.117Z", parts: [{ kind: "notice", text: "Unknown command: /xyzabc\nArgs from unknown skill: hello there", source: "informational" }] },
      { role: "user", ts: "2026-10-08T09:00:00.000Z", parts: [{ kind: "notice", text: "Usage limit reached · continuing automatically at 4am · esc to cancel", source: "informational" }] },
      { role: "user", ts: "2026-10-08T13:00:00.000Z", parts: [{ kind: "notice", text: "Usage limit reset · continuing automatically", source: "informational" }] },
    ]);
  });

  it("keeps a notice joined from long lines within the notice's length", () => {
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, timestamp: ts });
    const [turn] = parseClaudeTranscript([
      info("a".repeat(4000), "2026-10-08T08:06:31.117Z"),
      info("b".repeat(4000), "2026-10-08T08:06:31.118Z"),
    ].join("\n"));
    const text = (turn!.parts[0] as { text: string }).text;
    expect(turn!.parts).toHaveLength(1);
    expect(text.length).toBe(4001);
    expect(text.endsWith("\u2026")).toBe(true);
  });

  it("keeps a turn whole when Claude Code writes a notice while the agent works", () => {
    // a cross-session notice between a tool's result and the next call: about half of the notices in real transcripts
    const assistant = (block: object, stop: string, ts: string) => JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", stop_reason: stop, content: [block] } });
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, level: "warning", timestamp: ts });
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:00:00.000Z", message: { role: "user", content: "run it" } }),
      assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 60" } }, "tool_use", "2026-10-08T08:00:01.000Z"),
      info("Cross-session message held by the receiving session", "2026-10-08T08:00:20.000Z"),
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:01:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
      info("Cross-session message expired without approval", "2026-10-08T08:01:02.500Z"),
      assistant({ type: "text", text: "Done." }, "end_turn", "2026-10-08T08:01:03.000Z"),
      info("Unknown command: /xyzabc", "2026-10-08T08:02:00.000Z"),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind === "notice" ? part.text : part.kind)])).toEqual([
      ["user", ["text"]],
      // written inside the turn: shown before it, and the turn is still the last one while it runs
      ["user", ["Cross-session message held by the receiving session"]],
      ["user", ["Cross-session message expired without approval"]],
      ["assistant", ["tool", "text"]],
      // written after the answer: shown after it
      ["user", ["Unknown command: /xyzabc"]],
    ]);
    expect(turns[3]!.end_ts).toBe("2026-10-08T08:01:03.000Z");
  });

  it("keeps a turn whole around a notice when the tool call's entry names no stop reason", () => {
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", message: { role: "user", content: "run" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: null, content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "sleep 60" } }] } }),
      JSON.stringify({ type: "system", subtype: "informational", content: "Message held" }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
      JSON.stringify({ type: "system", subtype: "informational", content: "After the answer" }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind === "notice" ? part.text : part.kind)])).toEqual([
      ["user", ["text"]], ["user", ["Message held"]], ["assistant", ["tool", "text"]], ["user", ["After the answer"]],
    ]);
  });

  it("shows a refusal recorded both ways once also while the agent works, and keeps the turn whole", () => {
    const at = "2026-10-08T08:00:10.000Z";
    const info = JSON.stringify({ type: "system", subtype: "informational", timestamp: at, content: "Message held" });
    const local = JSON.stringify({ type: "system", subtype: "local_command", timestamp: at, content: "<local-command-stderr>Message held</local-command-stderr>" });
    const around = (notices: string[]) => parseClaudeTranscript([
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:00:00.000Z", message: { role: "user", content: "run" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-08T08:00:01.000Z", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "sleep 60" } }] } }),
      ...notices,
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:01:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-08T08:01:01.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] } }),
    ].join("\n")).map((turn) => [turn.role, turn.parts.map((part) => part.kind === "notice" ? `${part.source}: ${part.text}` : part.kind)]);
    expect(around([info, local])).toEqual([["user", ["text"]], ["user", ["informational: Message held"]], ["assistant", ["tool", "text"]]]);
    expect(around([local, info])).toEqual([["user", ["text"]], ["user", ["local-command: Message held"]], ["assistant", ["tool", "text"]]]);
  });

  it("shows a refusal once when Claude Code records it both as a command's answer and as a notice", () => {
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, level: "warning", timestamp: ts });
    const local = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: ts, content });
    const notices = (lines: string[]) => parseClaudeTranscript(lines.join("\n")).flatMap((turn) => turn.parts).filter((part) => part.kind === "notice").map((part) => (part as { text: string }).text);
    const stderr = "<local-command-stderr>\u001b[31mUnknown command: /gaol\u001b[39m</local-command-stderr>";
    expect(notices([local(stderr, "2026-10-08T08:06:31.117Z"), info("Unknown command: /gaol", "2026-10-08T08:06:31.118Z"), info("Args from unknown skill: x", "2026-10-08T08:06:31.119Z")]))
      .toEqual(["Unknown command: /gaol", "Args from unknown skill: x"]);
    expect(notices([info("Unknown command: /gaol", "2026-10-08T08:06:31.117Z"), info("Args from unknown skill: x", "2026-10-08T08:06:31.118Z"), local(stderr, "2026-10-08T08:06:31.119Z")]))
      .toEqual(["Unknown command: /gaol\nArgs from unknown skill: x"]);
    // the same words a minute later are another answer, and a notice's own repeat is kept
    expect(notices([local(stderr, "2026-10-08T08:06:31.117Z"), info("Unknown command: /gaol", "2026-10-08T08:07:31.118Z")])).toEqual(["Unknown command: /gaol", "Unknown command: /gaol"]);
    expect(notices([info("Message expired", "2026-10-08T08:06:31.117Z"), info("Message expired", "2026-10-08T08:06:31.118Z")])).toEqual(["Message expired\nMessage expired"]);
  });

  it("shows a slash command's answer only as the whole entry, as text, and not past its length", () => {
    const local = (content: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-10-07T19:00:00.000Z", content });
    const notices = (lines: string[]) => parseClaudeTranscript(lines.join("\n")).flatMap((turn) => turn.parts).filter((part) => part.kind === "notice").map((part) => (part as { text: string }).text);
    // an echo whose arguments quote the tag is still an echo
    expect(notices([local("<command-name>/goal</command-name>\n<command-args>x <local-command-stdout>quoted</local-command-stdout></command-args>")])).toEqual([]);
    // a link keeps its text and drops its hidden address; cursor moves and backspaces go too
    expect(notices([local("<local-command-stdout>\u001b]8;;https://example.test/?token=hidden\u0007open\u001b]8;;\u0007 done\u001b[2K\b</local-command-stdout>")])).toEqual(["open done"]);
    const long = notices([local(`<local-command-stdout>${"x".repeat(10_000)}</local-command-stdout>`)])[0]!;
    expect(long.length).toBe(4001);
    expect(long.endsWith("\u2026")).toBe(true);
  });

  it("strips an unterminated link, a charset switch, and shows both streams of one entry", () => {
    const local = (content: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-10-07T19:00:00.000Z", content });
    const notices = (lines: string[]) => parseClaudeTranscript(lines.join("\n")).flatMap((turn) => turn.parts).filter((part) => part.kind === "notice").map((part) => (part as { text: string }).text);
    // an OSC cut off before its BEL or ST still hides its address
    expect(notices([local("<local-command-stdout>done \u001b]8;;https://example.test/?token=hidden</local-command-stdout>")])).toEqual(["done"]);
    // ESC ( B is one sequence: no stray B
    expect(notices([local("<local-command-stdout>\u001b(Bplain\u001b[m text</local-command-stdout>")])).toEqual(["plain text"]);
    expect(notices([local("<local-command-stdout>out</local-command-stdout>\n<local-command-stderr>err</local-command-stderr>")])).toEqual(["out\nerr"]);
    // a closing tag the output itself prints ends nothing: only one at the end, or before the next stream, does
    expect(notices([local("<local-command-stdout>Use </local-command-stdout> in this example.</local-command-stdout>")])).toEqual(["Use </local-command-stdout> in this example."]);
    expect(notices([local("<local-command-stdout>a </local-command-stdout> b</local-command-stdout>\n<local-command-stderr>err</local-command-stderr>")])).toEqual(["a </local-command-stdout> b\nerr"]);
  });

  it("strips escapes in work linear in a malformed answer's length", () => {
    const local = (n: number, unit: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-10-07T19:00:00.000Z", content: `<local-command-stdout>${unit.repeat(n)}</local-command-stdout>` });
    // Counted, not timed: the parse takes well under a millisecond, and two such timings divide
    // into noise. It reads the answer through these primitives, each charged the characters it
    // touches. A regex's backtracking cannot be counted, so a run is charged its worst case, the
    // square of its input: a regex over one character costs one step, one over the answer fails.
    const work = (line: string): number => {
      let steps = 0;
      const text = String.prototype;
      const { charCodeAt, indexOf, startsWith, slice } = text;
      const { exec } = RegExp.prototype;
      text.charCodeAt = function (this: string, index: number) {
        steps++;
        return charCodeAt.call(this, index);
      };
      text.indexOf = function (this: string, search: string, from = 0) {
        const found = indexOf.call(this, search, from);
        steps += (found === -1 ? this.length : found) - from + search.length;
        return found;
      };
      text.startsWith = function (this: string, search: string, from?: number) {
        steps += search.length;
        return startsWith.call(this, search, from);
      };
      text.slice = function (this: string, start?: number, end?: number) {
        const part = slice.call(this, start, end);
        steps += part.length;
        return part;
      };
      RegExp.prototype.exec = function (this: RegExp, input: string) {
        steps += input.length ** 2;
        return exec.call(this, input);
      };
      try {
        parseClaudeTranscript(line);
      } finally {
        text.charCodeAt = charCodeAt;
        text.indexOf = indexOf;
        text.startsWith = startsWith;
        text.slice = slice;
        RegExp.prototype.exec = exec;
      }
      return steps;
    };
    // unterminated escapes, and closing tags the output prints itself
    for (const unit of ["\u001b]x", "</local-command-stdout> x"]) {
      // doubling the input doubles the work (2.00 measured for both); a rescan from every
      // unterminated opener, or from every closing tag, quadruples it. No work counted at all
      // is NaN here and fails too.
      expect(work(local(40_000, unit)) / work(local(20_000, unit))).toBeLessThan(2.5);
    }
  });

  it("keeps thinking blocks in transcript order", () => {
    const assistant = parseClaudeTranscript(lines)[1];
    expect(assistant?.parts.map((part) => part.kind)).toEqual(["text", "tool", "thinking", "text"]);
  });

  it("survives a torn tail line while Claude is mid-append", () => {
    expect(parseClaudeTranscript(`${lines}\n{"type":"ass`).length).toBe(2);
  });

  it("trims a huge tool result instead of shipping megabytes to the browser", () => {
    const big = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", id: "t", name: "Read", input: { file_path: "/etc/big" } },
      ] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "t", content: "x".repeat(10_000) },
      ] } }),
    ].join("\n");
    const turns = parseClaudeTranscript(big);
    const tool = turns[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.output.length : 0).toBeLessThanOrEqual(4100);
  });

  it("sums a NotebookEdit up by its notebook, so the row reads as an edit", () => {
    const turns = parseClaudeTranscript(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "n", name: "NotebookEdit", input: { notebook_path: "/repo/analysis.ipynb", cell_id: "c1", new_source: "print(1)", edit_mode: "replace" } },
    ] } }));
    const tool = turns[0]?.parts[0];
    if (tool?.kind !== "tool") throw new Error("expected a tool part");
    expect(tool.summary).toBe("/repo/analysis.ipynb");
    expect(toolVerb(tool, tool.summary)).toBe("Edited");
  });

  it("caps the turn list", () => {
    const many = Array.from({ length: MAX_TURNS + 50 }, (_, i) =>
      JSON.stringify({ type: "user", message: { role: "user", content: `m${i}` } }),
    ).join("\n");
    expect(parseClaudeTranscript(many).length).toBe(MAX_TURNS);
  });

  it("returns nothing for an empty transcript", () => {
    expect(parseClaudeTranscript("")).toEqual([]);
  });

  it("shows a message the person sent while the agent was working", () => {
    const queued = (attachment: Record<string, unknown>) => ({ type: "attachment", timestamp: "2026-10-02T04:00:05.000Z", attachment: { type: "queued_command", timestamp: "2026-10-02T04:00:05.000Z", ...attachment } });
    const transcript = [
      { type: "user", timestamp: "2026-10-02T04:00:00.000Z", message: { role: "user", content: "start" } },
      { type: "assistant", timestamp: "2026-10-02T04:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
      // the queue pair repeats the text; only the attachment becomes a turn
      { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-02T04:00:05.000Z", content: "also fix the tests" },
      { type: "queue-operation", operation: "remove", timestamp: "2026-10-02T04:00:09.000Z", content: "also fix the tests", reason: "absorbed_mid_turn" },
      queued({ prompt: "also fix the tests", commandMode: "prompt", origin: { kind: "human" }, humanTurn: true }),
      // a background task's notice and another agent's message are not the person's words
      queued({ prompt: "<task-notification>\n<status>completed</status>\n</task-notification>", commandMode: "task-notification" }),
      queued({ prompt: "<agent-message from=\"reviewer\">\ndone\n</agent-message>", commandMode: "prompt", origin: { kind: "peer" }, isMeta: true }),
      { type: "assistant", timestamp: "2026-10-02T04:00:10.000Z", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    expect(parseClaudeTranscript(transcript).map((turn) => [turn.role, turn.ts, turn.parts])).toEqual([
      ["user", "2026-10-02T04:00:00.000Z", [{ kind: "text", text: "start" }]],
      ["assistant", "2026-10-02T04:00:02.000Z", [{ kind: "text", text: "working" }]],
      ["user", "2026-10-02T04:00:05.000Z", [{ kind: "text", text: "also fix the tests" }]],
      ["assistant", "2026-10-02T04:00:10.000Z", [{ kind: "text", text: "on it" }]],
    ]);
  });

  it("drops a prompt cancelled before any reply when Claude Code re-sends it from the same parent", () => {
    // Claude Code 2.1.296 on send, Esc before any reply, then a re-send: the cancelled record
    // and the re-send are siblings under one parent, only bookkeeping lines between, and the
    // TUI shows only the re-send
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "a35be47b", parentUuid: "07055903", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "apple 2-87" } }),
      JSON.stringify({ type: "attachment", attachment: { type: "file-history-snapshot" } }),
      JSON.stringify({ type: "last-prompt" }),
      JSON.stringify({ type: "user", uuid: "7477aa61", parentUuid: "07055903", timestamp: "2026-10-10T08:00:04.000Z", message: { role: "user", content: "cherry 2" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:00:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "Cherry." }] } }),
    ].join("\n"));
    expect(turns).toEqual([
      { role: "user", ts: "2026-10-10T08:00:04.000Z", parts: [{ kind: "text", text: "cherry 2" }] },
      { role: "assistant", ts: "2026-10-10T08:00:06.000Z", end_ts: "2026-10-10T08:00:06.000Z", parts: [{ kind: "text", text: "Cherry." }] },
    ]);
  });

  it("keeps a prompt re-sent from the same parent when the first one was answered", () => {
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: "p", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "one answer" }] } }),
      JSON.stringify({ type: "user", uuid: "u2", parentUuid: "p", timestamp: "2026-10-10T08:00:05.000Z", message: { role: "user", content: "second" } }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts[0]])).toEqual([
      ["user", { kind: "text", text: "first" }],
      ["assistant", { kind: "text", text: "one answer" }],
      ["user", { kind: "text", text: "second" }],
    ]);
  });

  it("keeps an unanswered prompt when the next one hangs from another parent", () => {
    // an ordinary next prompt's parent is the answer before it, not the earlier prompt's
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: "p", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "user", uuid: "u2", parentUuid: "q", timestamp: "2026-10-10T08:00:05.000Z", message: { role: "user", content: "second" } }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts[0]])).toEqual([
      ["user", { kind: "text", text: "first" }],
      ["user", { kind: "text", text: "second" }],
    ]);
  });

  it("sees the cancelled prompt whether it was written as a string or as blocks", () => {
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: "p", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "string draft" } }),
      JSON.stringify({ type: "user", uuid: "u2", parentUuid: "p", timestamp: "2026-10-10T08:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "block resend" }] } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
      JSON.stringify({ type: "user", uuid: "u3", parentUuid: "a", timestamp: "2026-10-10T08:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "block draft" }] } }),
      JSON.stringify({ type: "user", uuid: "u4", parentUuid: "a", timestamp: "2026-10-10T08:01:03.000Z", message: { role: "user", content: "string resend" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:01:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "another" }] } }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts[0]])).toEqual([
      ["user", { kind: "text", text: "block resend" }],
      ["assistant", { kind: "text", text: "answer" }],
      ["user", { kind: "text", text: "string resend" }],
      ["assistant", { kind: "text", text: "another" }],
    ]);
  });

  it("hides the cancelled prompt on the live page too once its re-send arrives", () => {
    // Live records: user a35be47b parented on 07055903, cancelled before any reply (only
    // attachment/last-prompt bookkeeping after it), then re-send 7477aa61 on the same
    // parent and the answer. The re-send opens no new turn, so the cancelled record stays
    // inside the live tail the sibling rule reparses instead of settling visible.
    const root = mkdtempSync(join(tmpdir(), "herdr-resend-page-"));
    try {
      const path = join(root, "session.jsonl");
      const write = (...entries: unknown[]) => appendFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      const prompt = (uuid: string, parentUuid: string, text: string, timestamp: string) =>
        ({ type: "user", uuid, parentUuid, timestamp, message: { role: "user", content: text } });
      const answer = (text: string, timestamp: string) =>
        ({ type: "assistant", timestamp, message: { role: "assistant", content: [{ type: "text", text }] } });
      const texts = (turns: ConversationTurn[]) => turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []));
      write(prompt("u0", "p0", "first ask", "2026-10-10T08:00:00.000Z"), answer("first answer", "2026-10-10T08:00:02.000Z"),
        prompt("a35be47b", "p1", "apple 2-87", "2026-10-10T08:01:00.000Z"),
        { type: "attachment", attachment: { type: "file-history-snapshot" } }, { type: "last-prompt" });
      expect(texts(transcriptPage("claude-transcript", path).turns)).toEqual(["first ask", "first answer", "apple 2-87"]);
      write(prompt("7477aa61", "p1", "cherry 2", "2026-10-10T08:01:04.000Z"), answer("Cherry.", "2026-10-10T08:01:06.000Z"));
      const warm = transcriptPage("claude-transcript", path);
      expect(texts(warm.turns)).toEqual(["first ask", "first answer", "cherry 2", "Cherry."]);
      forgetTranscriptState();
      expect(transcriptPage("claude-transcript", path).turns).toEqual(warm.turns);
      // an ordinary next prompt hangs from another parent and still opens a turn of its own
      write(prompt("u9", "p9", "next ask", "2026-10-10T08:02:00.000Z"));
      expect(texts(transcriptPage("claude-transcript", path).turns)).toEqual(["first ask", "first answer", "cherry 2", "Cherry.", "next ask"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      forgetTranscriptState();
    }
  });

  describe("subagent notifications", () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });
    const block = (summary: string, extra = "<result>found two issues</result>") =>
      `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>\n${extra}\n</task-notification>`;
    /** the three records one completion is written as */
    const carriers = (content: string, timestamp: string) => [
      { type: "queue-operation", operation: "enqueue", timestamp, content },
      { type: "user", timestamp, message: { role: "user", content } },
      { type: "attachment", timestamp, attachment: { type: "queued_command", commandMode: "task-notification", prompt: content } },
    ];
    const read = (entries: unknown[], subagents?: Parameters<typeof parseClaudeTranscript>[2]) =>
      parseClaudeTranscript(entries.map((entry) => JSON.stringify(entry)).join("\n"), MAX_TURNS, subagents);
    const start = { type: "user", timestamp: "2026-10-05T00:00:00.000Z", message: { role: "user", content: "review it" } };

    it("deduplicates across settled/live boundaries without suppressing resumed completions or later pages", () => {
      const root = mkdtempSync(join(tmpdir(), "herdr-subagent-page-")); roots.push(root);
      const path = join(root, "s1.jsonl");
      const write = (...entries: unknown[]) => appendFileSync(path, entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
      const prompt = (n: number) => ({ ...start, message: { role: "user", content: `prompt ${n}` } });
      const notices = carriers(block('Agent "Review" finished'), "2026-10-05T00:01:00.000Z");
      const cards = (answer: ReturnType<typeof transcriptPage>) => answer.turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "task_result");
      write(prompt(1), notices[0], prompt(2), notices[1]);
      expect(cards(transcriptPage("claude-transcript", path))).toHaveLength(1);
      write(notices[2]);
      expect(cards(transcriptPage("claude-transcript", path))).toHaveLength(1);
      write(prompt(3));
      const warm = transcriptPage("claude-transcript", path);
      forgetTranscriptState();
      expect(transcriptPage("claude-transcript", path).turns).toEqual(warm.turns);
      write(...carriers(block('Agent "Review" finished').replace("toolu_1", "toolu_2"), "2026-10-05T00:02:00.000Z"));
      expect(cards(transcriptPage("claude-transcript", path))).toHaveLength(2);
      // Reparse the live suffix after another append; its dedup set must not persist across polls.
      write({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } });
      expect(cards(transcriptPage("claude-transcript", path))).toHaveLength(2);
      // Slide the page start past the first carrier. Deduplication belongs to the requested page.
      for (let n = 4; n < MAX_TURNS + 4; n++) write(prompt(n));
      write(notices[1]);
      const newest = transcriptPage("claude-transcript", path);
      expect(cards(newest)).toHaveLength(1);
      const older = transcriptPage("claude-transcript", path, { before: newest.cursor! });
      forgetTranscriptState();
      expect(transcriptPage("claude-transcript", path).turns).toEqual(newest.turns);
      expect(transcriptPage("claude-transcript", path, { before: newest.cursor! }).turns).toEqual(older.turns);
    });

    it("draws a queue-only completion before the active turn, but not its removal", () => {
      const content = block('Agent "Review the parser" finished');
      const turn = { type: "assistant", timestamp: "2026-10-05T00:00:01.000Z", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: {} }] } };
      const queued = { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-05T00:01:00.000Z", content };
      const turns = read([start, turn, queued]);
      expect(turns.map((entry) => entry.parts.map((part) => part.kind).join())).toEqual(["text", "task_result", "tool"]);
      expect(turns[1]?.parts[0]).toMatchObject({ kind: "task_result", tasks: [{ id: "a1", status: "completed", result: "found two issues" }] });
      expect(read([start, turn, { ...queued, operation: "remove" }]).flatMap((entry) => entry.parts).filter((part) => part.kind === "task_result")).toEqual([]);
    });

    it("skips garbled lines and incomplete notification envelopes without a success card", () => {
      const content = block('Agent "Review the parser" finished').replace("</task-notification>", "");
      const transcript = `null\n42\n{garbled\n${JSON.stringify(start)}\n${JSON.stringify({ type: "user", message: { content } })}\n{"type":`;
      expect(parseClaudeTranscript(transcript)).toEqual(read([start]));
    });

    it("becomes one task_result however many records carry it, and starts a turn of its own", () => {
      const turns = read([
        start,
        { type: "assistant", timestamp: "2026-10-05T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "started a reviewer" }] } },
        ...carriers(block('Agent "Review the parser" finished'), "2026-10-05T00:01:00.000Z"),
        { type: "assistant", timestamp: "2026-10-05T00:01:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "it found two" }] } },
      ], { subagents: new Map([["a1", { title: "Review parser fix", agent: "reviewer" }]]) });
      expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(turns[2]).toEqual({ role: "user", ts: "2026-10-05T00:01:00.000Z", parts: [{ kind: "task_result", tasks: [{
        id: "a1", title: "Review parser fix", agent: "reviewer", model: null, status: "completed",
        duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "found two issues",
      }] }] });
    });

    it("draws a notice that shares an entry with a tool's result once, before the turn still at work", () => {
      const notice = block('Agent "Review the parser" finished');
      const entries = [
        start,
        { type: "assistant", timestamp: "2026-10-05T00:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ls" } }] } },
        { type: "user", timestamp: "2026-10-05T00:01:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "a.ts" }, { type: "text", text: notice }] } },
        { type: "assistant", timestamp: "2026-10-05T00:01:01.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "finished" }] } },
      ];
      for (const turns of [read(entries), read([...entries, ...carriers(notice, "2026-10-05T00:01:00.000Z")])]) {
        expect(turns.map((turn) => turn.parts.map((part) => part.kind).join())).toEqual(["text", "task_result", "tool,text"]);
        const tool = turns[2]?.parts[0];
        expect(tool?.kind === "tool" ? tool.output : tool).toBe("a.ts");
      }
    });

    it("takes a page's card from the subagent's meta file alone, so it reads the same however the subagent's transcript has grown", () => {
      const root = mkdtempSync(join(tmpdir(), "herdr-subagent-page-")); roots.push(root);
      const path = join(root, "s1.jsonl");
      mkdirSync(join(root, "s1", "subagents"), { recursive: true });
      writeFileSync(join(root, "s1", "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", description: "Review parser fix", toolUseId: "toolu_1", requestShape: "background" }));
      const work = join(root, "s1", "subagents", "agent-a1.jsonl");
      writeFileSync(work, JSON.stringify({ type: "assistant", timestamp: "2026-10-05T00:00:20.000Z", message: { id: "m1", content: [] } }) + "\n");
      writeFileSync(path, [start, ...carriers(block('Agent "Review the parser" finished'), "2026-10-05T00:01:00.000Z")].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const card = () => { forgetTranscriptState(); return transcriptPage("claude-transcript", path).turns.flatMap((turn) => turn.parts).find((candidate) => candidate.kind === "task_result"); };
      const before = card();
      expect(before?.kind === "task_result" ? before.tasks[0] : before).toMatchObject({ title: "Review parser fix", agent: "reviewer", turns: null, tokens: null, duration_ms: null });
      // the agent goes on working: the card does not change with it
      appendFileSync(work, JSON.stringify({ type: "assistant", timestamp: "2026-10-05T00:09:00.000Z", message: { id: "m2", content: [] } }) + "\n");
      expect(card()).toEqual(before);
    });

    it("reads no file for an id that a tool's output quoted with the tag", () => {
      const root = mkdtempSync(join(tmpdir(), "herdr-subagent-page-")); roots.push(root);
      const path = join(root, "s1.jsonl");
      mkdirSync(join(root, "s1", "subagents"), { recursive: true });
      writeFileSync(join(root, "secret.meta.json"), JSON.stringify({ description: "SECRET", agentType: "x" }));
      const quoted = block('Agent "Hostile" finished').replace("<task-id>a1", "<task-id>x/../../secret");
      writeFileSync(path, [start,
        { type: "user", timestamp: "2026-10-05T00:00:30.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: quoted }] } },
        ...carriers(block('Agent "Real" finished'), "2026-10-05T00:01:00.000Z"),
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const cards = transcriptPage("claude-transcript", path).turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "task_result");
      expect(JSON.stringify(cards)).not.toContain("SECRET");
      expect(cards).toHaveLength(1);
    });

    it("falls back to the summary's name and leaves out what no file told", () => {
      const turns = read(carriers(block('Agent "Security review" finished'), "2026-10-05T00:01:00.000Z"));
      expect(turns).toHaveLength(1);
      expect(turns[0]?.parts).toEqual([{ kind: "task_result", tasks: [{ id: "a1", title: "Security review", agent: null, model: null, status: "completed", duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "found two issues" }] }]);
    });

    it("counts a resumed agent's next notification, which carries another tool-use id", () => {
      const again = block('Agent "Review" finished').replace("toolu_1", "toolu_2");
      const turns = read([...carriers(block('Agent "Review" finished'), "2026-10-05T00:01:00.000Z"), ...carriers(again, "2026-10-05T00:05:00.000Z")]);
      expect(turns.map((turn) => turn.ts)).toEqual(["2026-10-05T00:01:00.000Z", "2026-10-05T00:05:00.000Z"]);
    });

    it("cuts a long answer at the same limit as OmO's", () => {
      const turns = read(carriers(block('Agent "Long" finished', `<result>${"x".repeat(16_001)}</result>`), "2026-10-05T00:01:00.000Z"));
      const part = turns[0]?.parts[0];
      expect(part?.kind === "task_result" ? [part.tasks[0]?.result.length, part.tasks[0]?.result_cut] : part).toEqual([16_000, true]);
    });

    it("keeps a failed or stopped agent's status and hides a background command's notice", () => {
      const stopped = block('Agent "Cleanup" was stopped by Claude', "").replace("<status>completed", "<status>killed");
      const turns = read([...carriers(stopped, "2026-10-05T00:01:00.000Z"), ...carriers(block('Background command "sleep 5" completed (exit code 0)', ""), "2026-10-05T00:02:00.000Z")]);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.parts[0]).toMatchObject({ kind: "task_result", tasks: [{ title: "Cleanup", status: "cancelled", result: "" }] });
    });
  });

  it("preserves array user text, including mixed tool results, without exposing bookkeeping", () => {
    const transcript = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] } },
      { type: "user", message: { content: [null, { type: "tool_result", tool_use_id: "t", content: "result" }, { type: "text", text: "Actual request" }] } },
      { type: "user", message: { content: [{ type: "text", text: "<command-name>/clear</command-name>" }] } },
      { type: "user", isMeta: true, message: { content: "internal reminder" } },
      { type: "user", isCompactSummary: true, message: { content: "compacted context" } },
      null,
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const turns = parseClaudeTranscript(transcript);
    // the compaction is no bookkeeping: it marks where the conversation was folded
    expect(turns).toHaveLength(3);
    expect(turns[0]?.parts[0]).toMatchObject({ kind: "tool", output: "result" });
    expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Actual request" }]);
    expect(turns[2]?.parts).toEqual([{ kind: "compact", text: "compacted context" }]);
  });
});

/** Minimal but shape-true slices of an omp session jsonl. */
const ompLines = [
  JSON.stringify({ type: "title", v: 1, title: "프로젝트 불편사항 패치" }),
  JSON.stringify({ type: "session", version: 3, id: "01a0bdf7-b9e3-72bb-bad1-671dde7082f8" }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:00.000Z", message: { role: "user", attribution: "user", content: [
    { type: "text", text: "주소좀 줘봐" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:02.000Z", message: { role: "assistant", content: [
    { type: "thinking", text: "internal reasoning stays private" },
    { type: "thinking", thinking: "alternate thinking field" },
    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ss -tlnp", i: "Checking ports" }, intent: "Checking ports" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:03.000Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", isError: false, content: [
    { type: "text", text: "LISTEN 0 512 100.123.228.51:7317" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:05.000Z", message: { role: "assistant", content: [
    { type: "text", text: "http://100.123.228.51:7317" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:40:00.000Z", message: { role: "user", content: [
    { type: "image", blob: "..." },
  ] } }),
].join("\n");

describe("parseOmpTranscript", () => {
  it("builds user and merged assistant turns with folded tool results", () => {
    const turns = parseOmpTranscript(ompLines);
    expect(turns).toEqual([
      { role: "user", ts: "2026-09-20T08:39:00.000Z", parts: [{ kind: "text", text: "주소좀 줘봐" }] },
      { role: "assistant", ts: "2026-09-20T08:39:02.000Z", end_ts: "2026-09-20T08:39:05.000Z", parts: [
        { kind: "thinking", text: "internal reasoning stays private" },
        { kind: "thinking", text: "alternate thinking field" },
        { kind: "tool", name: "bash", summary: "Checking ports", input: expect.stringContaining("ss -tlnp"), output: "LISTEN 0 512 100.123.228.51:7317" },
        { kind: "text", text: "http://100.123.228.51:7317" },
      ] },
    ]);
  });

  it("keeps thinking parts while ignoring title/session headers", () => {
    const rendered = JSON.stringify(parseOmpTranscript(ompLines));
    expect(rendered).toContain("\"kind\":\"thinking\",\"text\":\"internal reasoning stays private\"");
    expect(rendered).toContain("\"kind\":\"thinking\",\"text\":\"alternate thinking field\"");
    expect(rendered).not.toContain("프로젝트 불편사항 패치");
  });

  it("skips an unsupported path-only image carrier instead of an empty turn", () => {
    const turns = parseOmpTranscript(ompLines);
    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(1);
    expect(turns.flatMap((turn) => turn.parts).some((part) => part.kind === "image")).toBe(false);
  });

  it("falls back to the first interesting argument when a toolCall has no intent", () => {
    const noIntent = [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [
        { type: "toolCall", id: "c", name: "read", arguments: { file_path: "/tmp/x" } },
      ] } }),
    ].join("\n");
    const tool = parseOmpTranscript(noIntent)[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.summary : "").toBe("/tmp/x");
  });

  it("survives a torn tail line while omp is mid-append", () => {
    expect(parseOmpTranscript(`${ompLines}\n{"type":"mess`).length).toBe(2);
  });

  it("trims a huge tool result and caps the turn list", () => {
    const big = [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [
        { type: "toolCall", id: "t", name: "bash", arguments: { command: "cat /etc/big" } },
      ] } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "t", content: [
        { type: "text", text: "x".repeat(10_000) },
      ] } }),
    ].join("\n");
    const tool = parseOmpTranscript(big)[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.output.length : 0).toBeLessThanOrEqual(4100);

    const many = Array.from({ length: MAX_TURNS + 50 }, (_, i) =>
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `m${i}` }] } }),
    ).join("\n");
    expect(parseOmpTranscript(many).length).toBe(MAX_TURNS);
  });
});

describe("omo transcript resolution", () => {
  it("recognizes omo from a pane's foreground processes, not from herdr's label", () => {
    // argv exactly as herdr's pane.process_info reported them for an omo pane
    expect(isOmoProcess(["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeTrue();
    expect(isOmoProcess(["bun", "/home/u/lib/node_modules/omo-ai/bin/omo.js"])).toBeTrue();
    expect(isOmoProcess(["bun", "/home/u/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js", "--extension", "/home/u/lib/node_modules/omo-ai/plugin"])).toBeTrue();
    // the pane herdr labels `claude` because of omo's child still names omo
    expect(isOmoProcess(["/home/u/lib/node_modules/omo-ai/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude", "--output-format", "stream-json"])).toBeTrue();

    expect(isOmoProcess(["/home/u/.local/bin/claude"])).toBeFalse();
    expect(isOmoProcess(["omp"])).toBeFalse();
    expect(isOmoProcess(["node", "/home/u/omo-tools/watch.js"])).toBeFalse();
    // a shell rc file printing a PATH that has omo-ai's bin directory in it
    expect(isOmoProcess(["printf", "%s\\n", "/home/u/.local/bin:/home/u/lib/node_modules/omo-ai/node_modules/.bin:/usr/bin"])).toBeFalse();
    expect(isOmoProcess(["printf", "%s\\n", "/usr/bin:/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeFalse();
  });
});

describe("omp session store", () => {
  it("accepts the path herdr reports only inside the user's own store", () => {
    const home = "/home/u", store = "/home/u/.omp/agent/sessions";
    expect(ompSessionStore(`${store}/project/session.jsonl`, home)).toBe(store);
    expect(ompSessionStore(`${store}-evil/project/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${store}/../../../../etc/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${store}/project/notes.txt`, home)).toBeNull();
    expect(ompSessionStore(".omp/agent/sessions/project/session.jsonl", home)).toBeNull();
    expect(ompSessionStore(undefined, home)).toBeNull();
  });

  it("accepts an `omp --profile` store, and only its sessions directory", () => {
    const home = "/home/u", profiles = "/home/u/.omp/profiles", store = `${profiles}/personal/agent/sessions`;
    expect(ompSessionStore(`${store}/-project/session.jsonl`, home)).toBe(store);
    expect(ompSessionStore(`${store}/session.jsonl`, home)).toBe(store);
    expect(ompSessionStore(`${profiles}/personal/agent/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}/personal/agent/logs/x/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}/personal/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}/../agent/sessions-evil/x/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}/personal/agent/sessions/../../../../../etc/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}-evil/personal/agent/sessions/x/session.jsonl`, home)).toBeNull();
  });

  it("accepts a Windows PC's native path, and refuses the same ways out", () => {
    const home = "C:\\Users\\u", store = "C:\\Users\\u\\.omp\\agent\\sessions";
    const session = `${store}\\project\\session.jsonl`;
    expect(ompSessionStore(session, home, win32)).toBe(store);
    expect(ompSessionStore(session.replaceAll("\\", "/"), home, win32)).toBe(store);
    expect(ompSessionStore(`${store}-evil\\project\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionStore(`${store}\\..\\sessions-evil\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionStore(`${store}\\project\\..\\..\\..\\..\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionStore(`D:${session.slice(2)}`, home, win32)).toBeNull();
    expect(ompSessionStore(`\\\\server\\share\\.omp\\agent\\sessions\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionStore(`${store}\\project\\notes.txt`, home, win32)).toBeNull();
    const profile = "C:\\Users\\u\\.omp\\profiles\\work\\agent\\sessions";
    expect(ompSessionStore(`${profile}\\project\\session.jsonl`, home, win32)).toBe(profile);
    expect(ompSessionStore(`C:\\Users\\u\\.omp\\profiles\\work\\session.jsonl`, home, win32)).toBeNull();
  });
});

describe("gjc sessions", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const session = (dir: string, name: string, cwd: string, mtime: string) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 5, cwd })}\n`);
    utimesSync(path, new Date(mtime), new Date(mtime));
    return path;
  };

  it("does not infer a session from cwd, even if there is only one file", async () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-gjc-")); roots.push(home);
    const dir = join(home, ".gjc", "agent", "sessions", "v2-abc");
    session(dir, "only.jsonl", "/home/u/project", "2026-09-20T00:00:00.000Z");
    writeFileSync(join(dir, ".gjc-managed-session-scope.v2.json"), JSON.stringify({ canonicalPath: "/home/u/project" }));
    await expect(gjcTranscriptPath("w9999:p9999", "/home/u/project", home)).rejects.toThrow(ConversationUnavailable);
  });

  it("shows a failed request's error instead of an empty answer", () => {
    const text = [
      JSON.stringify({ type: "message", timestamp: "2026-09-25T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "message", timestamp: "2026-09-25T00:00:01.000Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Authentication Failed" } }),
    ].join("\n");
    expect(parseOmpTranscript(text).at(-1)?.parts).toEqual([{ kind: "text", text: "Error: 401 Authentication Failed" }]);
  });

  it("ends a turn at a background result gjc delivers, so the answer before it stays the answer", () => {
    const assistant = (ts: string, text: string) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
    const text = [
      JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "run it in the background" }] } }),
      assistant("2026-10-01T00:00:01.000Z", "Started; here is the summary."),
      JSON.stringify({ type: "custom_message", customType: "async-result", display: true, timestamp: "2026-10-01T00:05:00.000Z", content: "<system-notice>\nBackground job bg_1 has completed.\nPASS all\n</system-notice>" }),
      assistant("2026-10-01T00:05:02.000Z", "CI is green."),
      JSON.stringify({ type: "custom_message", customType: "async-result", display: false, timestamp: "2026-10-01T00:06:00.000Z", content: "<system-notice>hidden</system-notice>" }),
      JSON.stringify({ type: "custom", customType: "workflow-intent-diff", data: { route: "direct" } }),
      assistant("2026-10-01T00:06:01.000Z", "Still green."),
    ].join("\n");
    expect(parseOmpTranscript(text)).toEqual([
      { role: "user", ts: "2026-10-01T00:00:00.000Z", parts: [{ kind: "text", text: "run it in the background" }] },
      { role: "assistant", ts: "2026-10-01T00:00:01.000Z", end_ts: "2026-10-01T00:00:01.000Z", parts: [{ kind: "text", text: "Started; here is the summary." }] },
      { role: "user", ts: "2026-10-01T00:05:00.000Z", parts: [{ kind: "notice", text: "Background job bg_1 has completed.\nPASS all", source: "async-result" }] },
      { role: "assistant", ts: "2026-10-01T00:05:02.000Z", end_ts: "2026-10-01T00:06:01.000Z", parts: [{ kind: "text", text: "CI is green." }, { kind: "text", text: "Still green." }] },
    ]);
  });

  it("ends a turn at an answer that stopped, so a hidden wake-up's work does not fold that answer away", () => {
    // omo 5.x: a monitor notification (display:false) wakes the agent after its final answer
    const assistant = (ts: string, stopReason: string, content: unknown[]) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content, stopReason } });
    const text = [
      JSON.stringify({ type: "message", timestamp: "2026-10-05T22:09:00.000Z", message: { role: "user", content: [{ type: "text", text: "review #368" }] } }),
      assistant("2026-10-05T22:09:15.000Z", "toolUse", [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }]),
      JSON.stringify({ type: "message", timestamp: "2026-10-05T22:09:16.000Z", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] } }),
      assistant("2026-10-05T22:14:54.000Z", "stop", [{ type: "thinking", thinking: "done" }, { type: "text", text: "The full review." }]),
      JSON.stringify({ type: "custom_message", customType: "senpi-monitor:notification", display: false, timestamp: "2026-10-05T22:14:54.500Z", content: "<system-reminder>READY</system-reminder>" }),
      assistant("2026-10-05T22:14:58.000Z", "stop", [{ type: "thinking", thinking: "nothing new" }, { type: "text", text: "Nothing new to do." }]),
    ].join("\n");
    const turns = parseOmpTranscript(text);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "assistant"]);
    expect(turns[1]!.parts.at(-1)).toEqual({ kind: "text", text: "The full review." });
    expect(turns[2]).toEqual({ role: "assistant", ts: "2026-10-05T22:14:58.000Z", end_ts: "2026-10-05T22:14:58.000Z", parts: [{ kind: "thinking", text: "nothing new" }, { kind: "text", text: "Nothing new to do." }] });
  });

  it("says which kind of notice the runtime delivered, and nothing where the runtime named none", () => {
    const notice = (fields: Record<string, unknown>) => JSON.stringify({ type: "custom_message", display: true, timestamp: "2026-10-01T00:00:00.000Z", ...fields });
    const text = [
      notice({ customType: "omo-model-profile:unavailable", content: "Model profile unavailable\nFalling back to the default." }),
      notice({ content: "<system-notice>unnamed</system-notice>" }),
    ].join("\n");
    expect(parseOmpTranscript(text).map((turn) => turn.parts)).toEqual([
      [{ kind: "notice", text: "Model profile unavailable\nFalling back to the default.", source: "omo-model-profile:unavailable" }],
      [{ kind: "notice", text: "unnamed" }],
    ]);
  });
});

describe("OmO background task results", () => {
  it("draws the background tasks an OmO wake reports as one card in the user's seat, titled by the call that started them", () => {
    const text = [
      omoUser("2026-10-05T00:00:00.000Z", "look into it"),
      omoSpawn("2026-10-05T00:00:01.000Z", "c1", { description: "record location", task_summary: "Find where task records live", subagent_type: "explore", prompt: "TASK: find" }, { task_id: "st_1", task_summary: "Find where task records live" }),
      omoSpawn("2026-10-05T00:00:02.000Z", "c2", { tasks: [{ task_summary: "Read shots 1-7", prompt: "a" }, { description: "shots 8-14", prompt: "b" }] }, { items: [{ task_id: "st_2", task_summary: "Read shots 1-7" }, { task_id: "st_3" }] }),
      omoWake("2026-10-05T00:01:00.000Z", [
        completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", resolved_model: { display: "lab/luna" }, model: "lab/luna-raw", duration_ms: 58_350, run_stats: { turns: 6, tool_calls: 14, total_tokens: 210_304 }, final_response: "**Found** it." }),
        completion({ task_id: "st_2", name: "st_2", status: "error", category: "visual-engineering", model: "lab/kimi", duration_ms: 9087, run_stats: { turns: 0, tool_calls: 0 }, final_response: "Invalid native tool call event order" }),
        // the batch result named no summary for it, and its name is its id: the agent it ran as
        completion({ task_id: "st_3", name: "st_3", status: "cancelled", category: "quick" }),
        completion({ task_id: "st_4", name: "named-run", status: "completed", final_response: "x".repeat(16_005) }),
      ]),
      JSON.stringify({ type: "message", timestamp: "2026-10-05T00:01:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "The record lives in .omo." }] } }),
    ].join("\n");
    const turns = parseOmpTranscript(text);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[2]).toEqual({ role: "user", ts: "2026-10-05T00:01:00.000Z", parts: [{ kind: "task_result", tasks: [
      { id: "st_1", title: "Find where task records live", agent: "explore", model: "lab/luna", status: "completed", duration_ms: 58_350, turns: 6, tool_calls: 14, tokens: 210_304, result: "**Found** it." },
      { id: "st_2", title: "Read shots 1-7", agent: "visual-engineering", model: "lab/kimi", status: "failed", duration_ms: 9087, turns: 0, tool_calls: 0, tokens: null, result: "Invalid native tool call event order" },
      { id: "st_3", title: "quick", agent: "quick", model: null, status: "cancelled", duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "" },
      { id: "st_4", title: "named-run", agent: null, model: null, status: "completed", duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "x".repeat(16_000), result_cut: true },
    ] }] });
    // the row of the call reads the summary it gave, one per task of a batch
    expect(turns[1]!.parts.map((part) => part.kind === "tool" ? part.summary : part.kind)).toEqual(["Find where task records live", "Read shots 1-7 · shots 8-14"]);
  });

  it("leaves a wake that reports no task result to the runtime", () => {
    const text = [
      omoUser("2026-10-05T00:00:00.000Z", "watch the build"),
      JSON.stringify({ type: "custom_message", customType: "omo-senpi:wake", display: false, timestamp: "2026-10-05T00:01:00.000Z", content: "monitor fired", details: [{ customType: "senpi-monitor:notification", details: [{ line: "READY" }] }] }),
      JSON.stringify({ type: "custom_message", customType: "omo-senpi:wake", display: false, timestamp: "2026-10-05T00:01:01.000Z", content: "empty", details: [{ customType: "senpi-task.completion", details: [{ name: "no id", status: "completed" }] }] }),
    ].join("\n");
    expect(parseOmpTranscript(text).map((turn) => turn.parts.map((part) => part.kind))).toEqual([["text"]]);
  });

  it("draws a task reported twice in one wake once, as its later report", () => {
    const text = [
      omoUser("2026-10-05T00:00:00.000Z", "go"),
      omoWake("2026-10-05T00:01:00.000Z", [
        completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", final_response: "first" }),
        completion({ task_id: "st_2", name: "st_2", status: "completed", agent_type: "explore", final_response: "other" }),
        completion({ task_id: "st_1", name: "st_1", status: "error", agent_type: "explore", final_response: "again" }),
      ]),
    ].join("\n");
    const ended = parseOmpTranscript(text)[1]?.parts[0];
    expect(ended?.kind === "task_result" ? ended.tasks.map((task) => `${task.id} ${task.status} ${task.result}`) : ended).toEqual(["st_1 failed again", "st_2 completed other"]);
  });
});

const omoUser = (ts: string, text: string) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
/** an OmO `task` call and the result that names the tasks it started */
const omoSpawn = (ts: string, id: string, input: Record<string, unknown>, details: Record<string, unknown>) => [
  JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id, name: "task", arguments: { run_in_background: true, ...input } }] } }),
  JSON.stringify({ type: "message", timestamp: ts, message: { role: "toolResult", toolCallId: id, toolName: "task", content: [{ type: "text", text: "Started task (running)." }], details: { status: "running", mode: "spawn", ...details } } }),
].join("\n");
const completion = (fields: Record<string, unknown>) => ({ continuation_hint: "Use task_send to continue.", ...fields });
/** how OmO wakes its agent when background tasks end */
const omoWake = (ts: string, tasks: Record<string, unknown>[]) => JSON.stringify({
  type: "custom_message", customType: "omo-senpi:wake", display: false, timestamp: ts,
  content: "task completion …", details: [{ customType: "senpi-task.completion", details: tasks }],
});

describe("transcript pages", () => {
  const roots: string[] = [];
  afterEach(() => {
    forgetTranscriptState();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const temp = (): string => { const root = mkdtempSync(join(tmpdir(), "herdr-pages-")); roots.push(root); return root; };
  /** a prompt, a tool call and its result: the result answers the turn, never the next page */
  const claudeTurn = (n: number) => [
    { type: "user", timestamp: `2026-09-23T00:00:${String(n % 60).padStart(2, "0")}.000Z`, message: { role: "user", content: `prompt ${n}` } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `echo ${n}` } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: `out ${n}` }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const texts = (turns: { parts: { kind: string; text?: string; output?: string }[] }[]) =>
    turns.map((turn) => turn.parts.map((part) => part.kind === "tool" ? `[${part.output}]` : part.text).join(" "));

  it("shows another session's message as its own notice turn, so the work it starts is not appended to the answer before it", () => {
    const path = join(temp(), "peer.jsonl");
    const envelope = (body: string) => `<cross-session-message from="uds:x" from-name="FUSION" from-mode="bypass">\n${body}\n</cross-session-message>`;
    let delivered = 0;
    const origin = (body: string) => ({ kind: "peer", from: "uds:x", msg_id: `m${++delivered}`, name: "FUSION", body });
    const say = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    writeFileSync(path, `${[
      { type: "user", timestamp: "2026-10-08T03:04:00.000Z", message: { role: "user", content: "deck status?" } },
      say("the deck is done"),
      // arrives between turns: a meta user entry
      { type: "user", isMeta: true, timestamp: "2026-10-08T03:05:01.000Z", origin: origin("R18 is ready"), message: { role: "user", content: `Another Claude session sent a message:\n${envelope("R18 is ready")}` } },
      say("recorded both decisions"),
      // arrives mid-turn: a queued attachment, its own turn in the order it was taken in
      { type: "attachment", timestamp: "2026-10-08T03:06:00.000Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: envelope("coordinates sent"), origin: origin("coordinates sent") } },
      say("rebuilt slide 4"),
      // a meta entry that is not another session's message stays hidden
      { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>x</local-command-caveat>" } },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const page = transcriptPage("claude-transcript", path);
    expect(page.turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind === "notice" ? `${part.source}|${part.text}` : part.kind === "text" ? part.text : part.kind).join(" ")])).toEqual([
      ["user", "deck status?"],
      ["assistant", "the deck is done"],
      ["user", "peer:FUSION|R18 is ready"],
      ["assistant", "recorded both decisions"],
      ["user", "peer:FUSION|coordinates sent"],
      ["assistant", "rebuilt slide 4"],
    ]);
  });

  it("shows one notice for a delivery Claude recorded twice, and says 'another session' for an unnamed sender", () => {
    const path = join(temp(), "peer-echo.jsonl");
    const origin = { kind: "peer", from: "uds:x", msg_id: "m7", name: "FUSION", body: "R18 is ready" };
    writeFileSync(path, `${[
      { type: "user", timestamp: "2026-10-08T03:04:00.000Z", message: { role: "user", content: "deck status?" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } },
      // queued mid-turn, then echoed as a meta entry once the turn ended: one message
      { type: "attachment", timestamp: "2026-10-08T03:05:00.000Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: "<cross-session-message from-name=\"FUSION\">\nR18 is ready\n</cross-session-message>", origin } },
      { type: "user", isMeta: true, timestamp: "2026-10-08T03:05:01.000Z", origin, message: { role: "user", content: "Another Claude session sent a message:\n<cross-session-message from-name=\"FUSION\">\nR18 is ready\n</cross-session-message>" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "noted" }] } },
      // a sender without a name
      { type: "user", isMeta: true, timestamp: "2026-10-08T03:06:00.000Z", origin: { kind: "peer", from: "uds:y", msg_id: "m8", body: "ping" }, message: { role: "user", content: "Another Claude session sent a message:\n<cross-session-message>\nping\n</cross-session-message>" } },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const page = transcriptPage("claude-transcript", path);
    expect(page.turns.map((turn) => turn.parts.map((part) => part.kind === "notice" ? `${part.source}|${part.text}` : part.kind === "text" ? part.text : part.kind).join(" "))).toEqual([
      "deck status?", "working on it", "peer:FUSION|R18 is ready", "noted", "peer:|ping",
    ]);
  });

  it("pages back across other sessions' messages without gaps or overlaps", () => {
    const path = join(temp(), "peer-pages.jsonl");
    const envelope = (n: number) => `<cross-session-message from-name="FUSION">\nreply ${n}\n</cross-session-message>`;
    const origin = (n: number) => ({ kind: "peer", from: "uds:x", msg_id: `m${n}`, name: "FUSION", body: `reply ${n}` });
    // in both forms Claude records them: the meta entry between turns, the queued attachment mid-turn
    const peer = (n: number) => JSON.stringify(n % 2 === 0
      ? { type: "user", isMeta: true, timestamp: "2026-10-08T00:00:00.000Z", origin: origin(n), message: { role: "user", content: `Another Claude session sent a message:\n${envelope(n)}` } }
      : { type: "attachment", timestamp: "2026-10-08T00:00:00.000Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: envelope(n), origin: origin(n) } })
      + "\n" + JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `handled ${n}` }] } });
    writeFileSync(path, `${Array.from({ length: 120 }, (_, n) => n % 3 === 0 ? peer(n) : claudeTurn(n)).join("\n")}\n`);
    const seen: string[] = [];
    let page = transcriptPage("claude-transcript", path);
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(20);
      seen.unshift(...texts(page.turns));
      if (!page.cursor) break;
      page = transcriptPage("claude-transcript", path, { before: page.cursor });
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((text) => text.startsWith("reply ")).length).toBe(40);
    expect(seen.filter((text) => text.startsWith("prompt ")).length).toBe(80);
  });

  it("titles a background task that ends a prompt after the one that started it, live and cold alike", () => {
    const root = temp();
    const path = join(root, "omo.jsonl");
    writeFileSync(path, `${[
      omoUser("2026-10-05T00:00:00.000Z", "start it"),
      omoSpawn("2026-10-05T00:00:01.000Z", "c1", { task_summary: "Survey the repo", subagent_type: "explore", prompt: "go" }, { task_id: "st_1", task_summary: "Survey the repo" }),
    ].join("\n")}\n`);
    // the first read settles nothing yet; the next prompt makes the spawn's turn settled
    expect(transcriptPage("omo-transcript", path).turns).toHaveLength(2);
    appendFileSync(path, `${omoUser("2026-10-05T00:02:00.000Z", "meanwhile, something else")}\n`);
    expect(transcriptPage("omo-transcript", path).turns).toHaveLength(3);
    appendFileSync(path, `${omoWake("2026-10-05T00:03:00.000Z", [completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", final_response: "done" })])}\n`);
    const cold = join(root, "cold.jsonl");
    copyFileSync(path, cold);
    for (const page of [transcriptPage("omo-transcript", path), transcriptPage("omo-transcript", cold)]) {
      const ended = page.turns.at(-1)?.parts[0];
      expect(ended?.kind === "task_result" ? ended.tasks.map((task) => task.title) : ended).toEqual(["Survey the repo"]);
    }
  });

  const endedTitles = (page: { turns: ConversationTurn[] }): unknown => {
    const ended = page.turns.at(-1)?.parts[0];
    return ended?.kind === "task_result" ? ended.tasks.map((task) => task.title) : ended;
  };

  const spawning = (taskId: string) => `${[
    omoUser("2026-10-05T00:00:00.000Z", "start it"),
    omoSpawn("2026-10-05T00:00:01.000Z", "c1", { task_summary: "Survey the repo", subagent_type: "explore", prompt: "go" }, { task_id: taskId, task_summary: "Survey the repo" }),
  ].join("\n")}\n`;
  /** polled as it grows until the page start passes the first turn, then st_1 ends */
  const pollPastFirstTurn = (path: string) => {
    // the page start passes the first turn once more prompts than a page holds followed
    for (let n = 0; n < MAX_TURNS / 2 + 2; n += 1) {
      expect(transcriptPage("omo-transcript", path).turns.length).toBeGreaterThan(0);
      appendFileSync(path, `${omoUser(`2026-10-05T00:${String(10 + Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`, `prompt ${n}`)}\n`);
    }
    expect(transcriptPage("omo-transcript", path).turns[0]?.parts[0]).toEqual({ kind: "text", text: "prompt 2" });
    appendFileSync(path, `${omoWake("2026-10-05T00:20:00.000Z", [completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", final_response: "done" })])}\n`);
    return endedTitles(transcriptPage("omo-transcript", path));
  };

  it("keeps a task's title when the newest page moves past the turn that started it, while the file is watched", () => {
    const path = join(temp(), "omo.jsonl");
    writeFileSync(path, spawning("st_1"));
    expect(pollPastFirstTurn(path)).toEqual(["Survey the repo"]);
  });

  it("keeps the last observed task title when many prompts arrive between polls", () => {
    const path = join(temp(), "omo.jsonl");
    writeFileSync(path, spawning("st_1"));
    transcriptPage("omo-transcript", path);
    for (let n = 0; n < MAX_TURNS / 2 + 2; n++) {
      appendFileSync(path, `${omoUser(`2026-10-05T00:10:${String(n % 60).padStart(2, "0")}.000Z`, `prompt ${n}`)}\n`);
    }
    appendFileSync(path, `${omoWake("2026-10-05T00:20:00.000Z", [completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", final_response: "done" })])}\n`);
    expect(endedTitles(transcriptPage("omo-transcript", path))).toEqual(["Survey the repo"]);
  });

  it("never titles a task from another file that had the same inode", () => {
    const root = temp();
    const gone = join(root, "gone.jsonl");
    writeFileSync(gone, spawning("st_1"));
    transcriptPage("omo-transcript", gone);
    appendFileSync(gone, `${omoUser("2026-10-05T00:02:00.000Z", "meanwhile, something else")}\n`);
    transcriptPage("omo-transcript", gone);
    // Linux gives a deleted file's inode to the next file; a hard link rewritten in place does so anywhere
    const path = join(root, "omo.jsonl");
    linkSync(gone, path);
    writeFileSync(path, spawning("st_2"));
    expect(pollPastFirstTurn(path)).toEqual(["explore"]);
  });

  it("titles a wake read before the call that names its task as a cold read does, on every poll", () => {
    const root = temp();
    const path = join(root, "omo.jsonl");
    writeFileSync(path, `${[
      omoUser("2026-10-05T00:00:00.000Z", "start it"),
      omoWake("2026-10-05T00:00:01.000Z", [completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", final_response: "done" })]),
      omoSpawn("2026-10-05T00:00:02.000Z", "c1", { task_summary: "Survey the repo", subagent_type: "explore", prompt: "go" }, { task_id: "st_1", task_summary: "Survey the repo" }),
    ].join("\n")}\n`);
    const titles = (page: { turns: ConversationTurn[] }) => page.turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "task_result" ? part.tasks.map((task) => task.title) : []));
    expect(titles(transcriptPage("omo-transcript", path))).toEqual(["explore"]);
    appendFileSync(path, `${JSON.stringify({ type: "message", timestamp: "2026-10-05T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "noted" }] } })}\n`);
    const cold = join(root, "cold.jsonl");
    copyFileSync(path, cold);
    expect(titles(transcriptPage("omo-transcript", path))).toEqual(titles(transcriptPage("omo-transcript", cold)));
  });

  it("reads a growing file's newest page incrementally, exactly as a cold read of it", () => {
    const root = temp();
    const path = join(root, "session.jsonl");
    const whole = Buffer.from(`${Array.from({ length: 80 }, (_, n) => claudeTurn(n)).join("\n")}\n`);
    writeFileSync(path, whole.subarray(0, 1000));
    // appends of every size, cut mid-line too, including one that ends the file without a newline
    for (let at = 1000, step = 1; at < whole.length; step = (step * 7) % 997 + 1) {
      appendFileSync(path, whole.subarray(at, at + step * 23));
      at += step * 23;
      const cold = join(root, `cold-${at}.jsonl`);
      copyFileSync(path, cold);
      const live = transcriptPage("claude-transcript", path);
      const reference = transcriptPage("claude-transcript", cold);
      rmSync(cold);
      expect(texts(live.turns)).toEqual(texts(reference.turns));
      expect(live.metadata).toEqual(reference.metadata);
      expect(live.cursor?.split(":").at(-1)).toBe(reference.cursor?.split(":").at(-1));
    }
  });

  it("pages back through a long conversation without gaps, overlaps or split turns", () => {
    const path = join(temp(), "session.jsonl");
    const whole = Array.from({ length: 120 }, (_, n) => claudeTurn(n)).join("\n");
    writeFileSync(path, `${whole}\n`);

    const newest = transcriptPage("claude-transcript", path);
    expect(newest.turns).toHaveLength(MAX_TURNS);
    expect(texts(newest.turns)[0]).toBe("prompt 70");
    expect(newest.cursor).not.toBeNull();
    const middle = transcriptPage("claude-transcript", path, { before: newest.cursor! });
    expect(texts(middle.turns)[0]).toBe("prompt 20");
    const first = transcriptPage("claude-transcript", path, { before: middle.cursor! });
    expect(first.cursor).toBeNull();
    expect(texts([...first.turns, ...middle.turns, ...newest.turns])).toEqual(texts(parseClaudeTranscript(whole, Infinity)));
    expect(texts(middle.turns).at(-1)).toBe("[out 69] answer 69");
  });

  it("keeps a held start while it is inside the newest page, then fills the turns it moved past a page at a time", () => {
    const path = join(temp(), "session.jsonl");
    writeFileSync(path, `${Array.from({ length: 60 }, (_, n) => claudeTurn(n)).join("\n")}\n`);
    const held = transcriptPage("claude-transcript", path).cursor!;
    // while the last turn grows, the held start (prompt 10) is still inside the newest page
    const more = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "still working" }] } });
    writeFileSync(path, `${Array.from({ length: 60 }, (_, n) => claudeTurn(n)).join("\n")}\n${more}\n`);
    const growing = transcriptPage("claude-transcript", path, { from: held });
    expect(growing.cursor).toBe(held);
    expect(texts(growing.turns).at(-1)).toBe("[out 59] answer 59 still working");
    writeFileSync(path, `${Array.from({ length: 70 }, (_, n) => claudeTurn(n)).join("\n")}\n`);
    // the newest page slid past it: the answer is the newest page, never more than a page
    const newest = transcriptPage("claude-transcript", path, { from: held });
    expect(newest.cursor).not.toBe(held);
    expect(texts(newest.turns)[0]).toBe("prompt 20");
    // the turns in between come from `before` the newest page, `since` the held start
    const gap = transcriptPage("claude-transcript", path, { before: newest.cursor!, since: held });
    expect(gap.cursor).toBe(held);
    expect(texts(gap.turns)[0]).toBe("prompt 10");
    expect(texts(gap.turns).at(-1)).toBe("[out 19] answer 19");
    for (const cursor of ["another-file:10", `${held.split(":")[0]}:999999999`, "garbage"]) {
      expect(() => transcriptPage("claude-transcript", path, { before: cursor })).toThrow(HistoryChanged);
    }
    expect(() => transcriptPage("claude-transcript", path, { before: held, since: newest.cursor! })).toThrow(HistoryChanged);
  });

  it("reads one window for the newest page even when no turn starts in it; an older page reaches the turn's start", () => {
    const path = join(temp(), "session.jsonl");
    const prompt = JSON.stringify({ type: "user", message: { role: "user", content: "run the long job" } });
    // one turn of 20MB of tool output: no turn starts in the newest window
    const output = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(1024 * 1024) }] } });
    writeFileSync(path, `${claudeTurn(0)}\n${prompt}\n${Array.from({ length: 20 }, () => output).join("\n")}\n`);
    const size = Buffer.byteLength(`${claudeTurn(0)}\n${prompt}\n`) + 20 * (Buffer.byteLength(output) + 1);
    const newest = transcriptPage("claude-transcript", path);
    const start = Number(newest.cursor!.split(":").at(-1));
    expect(size - start).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(newest.turns.every((turn) => turn.role === "assistant")).toBe(true);
    const older = transcriptPage("claude-transcript", path, { before: newest.cursor! });
    expect(texts(older.turns).slice(0, 3)).toEqual(["prompt 0", "[out 0] answer 0", "run the long job"]);
  });

  it("refuses a cursor once the rollouts before the live file change, instead of pointing at other turns", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 20 }, (_, n) => task(n)).join("\n")}\n`;
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: kept.split("\n").length - 1, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 60 }, (_, n) => task(20 + n)).join("\n")}\n`);
    // the earlier rollout is not there yet: the chain stops at the segment
    forgetHistoryChains();
    const newest = transcriptPage("codex-transcript", segment, {}, home);
    const older = transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home);
    expect(texts(older.turns)[0]).toBe("prompt 20");
    // it appears: positions now count from its start, and the old cursors name another chain
    writeFileSync(join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`), kept);
    forgetHistoryChains();
    expect(() => transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home)).toThrow(HistoryChanged);
    expect(() => transcriptPage("codex-transcript", segment, { from: newest.cursor! }, home)).toThrow(HistoryChanged);
    // read afresh, the pages reach the earlier rollout
    const again = transcriptPage("codex-transcript", segment, {}, home);
    const all = [...transcriptPage("codex-transcript", segment, { before: again.cursor! }, home).turns, ...again.turns];
    expect(texts(all)[0]).toBe("prompt 0");
  });

  it("looks a remembered chain up again once a rollout in it is archived, instead of failing every read", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    mkdirSync(join(home, "archived_sessions"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 80 }, (_, n) => task(n)).join("\n")}\n`;
    const parent = join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`);
    writeFileSync(parent, kept);
    // right after a backtrack the live file is small: its newest page reaches into the parent
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: kept.split("\n").length - 1, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 3 }, (_, n) => task(80 + n)).join("\n")}\n`);
    forgetHistoryChains();
    const before = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(before.turns)[0]).toBe("prompt 33");
    expect(before.cursor).not.toBeNull();
    // archived while the complete chain is remembered
    renameSync(parent, join(home, "archived_sessions", `rollout-2026-09-15T12-58-12-${thread}.jsonl`));
    const after = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(after.turns)).toEqual(["prompt 80", "answer 80", "prompt 81", "answer 81", "prompt 82", "answer 82"]);
    // a reader holding a position in the old chain reloads once
    expect(() => transcriptPage("codex-transcript", segment, { before: before.cursor! }, home)).toThrow(HistoryChanged);
  });

  it("pages across the rollouts a backtracked Codex conversation continues", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 60 }, (_, n) => task(n)).join("\n")}\n`;
    const keptLines = kept.split("\n").length - 1;
    writeFileSync(join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`), `${kept}${task(999)}\n`);
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: keptLines, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 10 }, (_, n) => task(60 + n)).join("\n")}\n`);

    const newest = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(newest.turns)[0]).toBe("prompt 20");
    const older = transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home);
    expect(older.cursor).toBeNull();
    const all = texts([...older.turns, ...newest.turns]);
    expect(all).toEqual(Array.from({ length: 70 }, (_, n) => [`prompt ${n}`, `answer ${n}`]).flat());
  });
});

describe("tool calls that failed", () => {
  const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
  it("keeps Claude's is_error and omp's isError on the call they answer", () => {
    const claude = parseClaudeTranscript(lines(
      { type: "assistant", timestamp: "2026-09-27T00:00:00Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "true" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "exit 1", is_error: true }, { type: "tool_result", tool_use_id: "t2", content: "" }] } },
    ));
    expect(claude.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool").map((part) => part.error === true)).toEqual([true, false]);
    const omp = parseOmpTranscript(lines(
      { type: "message", timestamp: "2026-09-27T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: "exit 1" }] } },
    ));
    expect(omp.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool").map((part) => part.error === true)).toEqual([true]);
  });
});

describe("images and compactions in a Claude transcript", () => {
  const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
  it("names a pasted image by its entry and block, and never carries its data", () => {
    const turns = parseClaudeTranscript(lines(
      { type: "user", uuid: "11111111-2222-3333-4444-555555555555", timestamp: "2026-09-27T00:00:00Z", message: { content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } },
      ] } },
      { type: "user", uuid: "66666666-2222-3333-4444-555555555555", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } }] } },
    ));
    expect(turns.map((turn) => turn.parts)).toEqual([
      [{ kind: "image", media_type: "image/png", ref: "11111111-2222-3333-4444-555555555555:0" }, { kind: "text", text: "what is this?" }],
      [{ kind: "image", media_type: "image/jpeg", ref: "66666666-2222-3333-4444-555555555555:0" }],
    ]);
    expect(JSON.stringify(turns)).not.toContain("iVBOR");
  });

  it("marks where a compaction folded the conversation, with its summary", () => {
    const turns = parseClaudeTranscript(lines(
      { type: "user", timestamp: "2026-09-27T00:00:00Z", message: { content: "before" } },
      { type: "user", isCompactSummary: true, timestamp: "2026-09-27T01:00:00Z", message: { content: "This session is being continued. Summary: X" } },
    ));
    expect(turns.at(-1)).toEqual({ role: "user", ts: "2026-09-27T01:00:00Z", parts: [{ kind: "compact", text: "This session is being continued. Summary: X" }] });
  });
});

describe("transcriptImage", () => {
  it("decodes the image a ref names, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    try {
      const path = join(dir, "session.jsonl");
      const uuid = "11111111-2222-3333-4444-555555555555";
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      writeFileSync(path, [
        { type: "user", uuid: "99999999-2222-3333-4444-555555555555", message: { content: [{ type: "text", text: "x" }] } },
        { type: "user", uuid, message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }, { type: "text", text: "what?" }, { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      const image = transcriptImage(path, `${uuid}:0`);
      expect(image?.mediaType).toBe("image/png");
      expect(Buffer.from(image!.bytes).equals(png)).toBe(true);
      // a text block, a type a page never shows, another entry's index, a ref that is no ref
      expect(transcriptImage(path, `${uuid}:1`)).toBeNull();
      expect(transcriptImage(path, `${uuid}:2`)).toBeNull();
      expect(transcriptImage(path, "99999999-2222-3333-4444-555555555555:0")).toBeNull();
      expect(transcriptImage(path, "../../etc/passwd:0")).toBeNull();
      expect(transcriptImage(join(dir, "missing.jsonl"), `${uuid}:0`)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("a cut tool output and the whole of it", () => {
  it("keeps the call id of an output cut for the page, and finds the whole one by it", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-output-"));
    try {
      const long = "x".repeat(9_000);
      const claude = [
        { type: "assistant", timestamp: "2026-09-27T00:00:00Z", message: { content: [{ type: "tool_use", id: "toolu_long", name: "Bash", input: { command: "big" } }, { type: "tool_use", id: "toolu_short", name: "Bash", input: { command: "small" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_long", content: long }, { type: "tool_result", tool_use_id: "toolu_short", content: "ok" }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n");
      const tools = parseClaudeTranscript(claude).flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
      expect(tools.map((tool) => [tool.output_ref, tool.output_size])).toEqual([["toolu_long", 9_000], [undefined, undefined]]);
      expect(tools[0]!.output.length).toBeLessThan(4_100);
      const path = join(dir, "claude.jsonl");
      writeFileSync(path, claude);
      expect(transcriptToolOutput("claude-transcript", path, "toolu_long")).toBe(long);
      expect(transcriptToolOutput("claude-transcript", path, "toolu_none")).toBeNull();
      expect(transcriptToolOutput("claude-transcript", path, "../etc")).toBeNull();
      const omp = join(dir, "omp.jsonl");
      writeFileSync(omp, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: long }] } }));
      expect(transcriptToolOutput("omp-transcript", omp, "call_1")).toBe(long);
      const codex = join(dir, "codex.jsonl");
      writeFileSync(codex, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call_x", output: long } }));
      expect(transcriptToolOutput("codex-transcript", codex, "call_x")).toBe(long);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


it("preserves literal paste lookalikes, partial wrappers and mismatched ids", () => {
  const cases = [
    '<pasted_content id="a">\nverbatim\n</pasted_content id="b">',
    '<pasted_content>\nverbatim\n</pasted_content>',
    '<pasted_content id="a">verbatim</pasted_content id="a">',
    '<pasted_content id="a">\nunfinished',
    '\n\nordinary prompt\n',
  ];
  for (const text of cases) expect(unwrapPastes(text)).toBe(text);
  expect(unwrapPastes('before\n<pasted_content id="a_1">\r\nfirst\r\n</pasted_content id="a_1">\nafter')).toBe("before\nfirst\nafter");
});

it("incrementally reads one growing Codex task across split UTF-8, partial records and a rewrite", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-growing-"));
  try {
    const path = join(root, "live.jsonl");
    const cold = join(root, "cold.jsonl");
    const records = [
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload: { type: "user_message", message: "한글 👋" } },
      { type: "turn_context", payload: { model: "model-a", effort: "high" } },
      ...Array.from({ length: 30 }, (_, n) => [
        { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: `c${n}`, arguments: '{"cmd":"ls"}' } },
        { type: "response_item", payload: { type: "function_call_output", call_id: `c${n}`, output: "x".repeat(5000) } },
      ]).flat(),
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "끝났어요" }] } },
    ];
    const whole = Buffer.from(records.map((entry) => JSON.stringify(entry)).join("\n"));
    writeFileSync(path, "");
    for (let at = 0, step = 1; at < whole.length; step = (step * 13) % 571 + 1) {
      const next = whole.subarray(at, at + step * 7);
      appendFileSync(path, next); at += next.length;
      writeFileSync(cold, whole.subarray(0, at));
      const live = transcriptPage("codex-transcript", path);
      const reference = transcriptPage("codex-transcript", cold);
      expect(live.turns).toEqual(reference.turns);
      expect(live.metadata).toEqual(reference.metadata);
    }
    const original = transcriptPage("codex-transcript", path);
    writeFileSync(path, whole.toString("utf8").replace("model-a", "model-b"));
    // Some filesystems coalesce immediate writes into one timestamp tick.
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    expect(transcriptPage("codex-transcript", path).metadata.model).toBe("model-b");
    expect(original.metadata.model).toBe("model-a");
    writeFileSync(path, records.slice(0, 2).map((entry) => JSON.stringify(entry)).join("\n"));
    expect(transcriptPage("codex-transcript", path).turns).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("expands inherited Codex tool output without exposing output discarded by a backtrack", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-tool-history-"));
  try {
    const directory = join(home, "sessions", "2026", "09", "30");
    mkdirSync(directory, { recursive: true });
    const thread = "11111111-1111-4111-8111-111111111111";
    const parent = join(directory, `rollout-2026-09-30T01-00-00-${thread}.jsonl`);
    const leaf = join(directory, `rollout-2026-09-30T01-00-01-${thread}_1.jsonl`);
    const line = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + "\n";
    const meta = (extra = {}) => line("session_meta", { id: thread, source: "cli", thread_source: "user", ...extra });
    const long = "inherited output ".repeat(1000);
    const kept = meta()
      + line("event_msg", { type: "user_message", message: "earlier request" })
      + line("response_item", { type: "function_call", name: "exec_command", call_id: "kept", arguments: "{}" })
      + line("response_item", { type: "function_call_output", call_id: "kept", output: long });
    writeFileSync(parent, kept + line("response_item", { type: "function_call_output", call_id: "discarded", output: "discarded output" }));
    writeFileSync(leaf, meta({ history_base: { thread_id: thread, end_ordinal_exclusive: 4, end_byte_offset: Buffer.byteLength(kept) } })
      + line("response_item", { type: "function_call_output", call_id: "current", output: "current output" }));
    const page = transcriptPage("codex-transcript", leaf, {}, home);
    expect(page.turns.flatMap((turn) => turn.parts).some((part) => part.kind === "tool" && part.output_ref === "kept")).toBe(true);
    expect(transcriptToolOutput("codex-transcript", leaf, "kept", home)).toBe(long);
    expect(transcriptToolOutput("codex-transcript", leaf, "current", home)).toBe("current output");
    expect(transcriptToolOutput("codex-transcript", leaf, "discarded", home)).toBeNull();
    // an inherited rollout that can no longer be read costs its own output, not the leaf's
    // (a directory in its place fails to read even for root, unlike a mode change)
    rmSync(parent);
    mkdirSync(parent);
    expect(transcriptToolOutput("codex-transcript", leaf, "current", home)).toBe("current output");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

describe("Agy native ledger through shared paging", () => {
  let root: string, path: string, db: Database;
  const row = (step_index: number, type: string, content = "", extra = {}) => JSON.stringify({ step_index, type, status: "DONE", created_at: "2026-01-01T00:00:00Z", content, ...extra }) + "\n";
  const add = (index: number, type: string, content = "", extra = {}) => {
    db.query("INSERT OR REPLACE INTO steps VALUES (?)").run(index);
    appendFileSync(path, row(index, type, content, extra));
  };
  const page = () => transcriptPage("agy-transcript", path);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "herdr-agy-unit-"));
    const session = "00000000-0000-4000-8000-000000000001";
    path = join(root, "brain", session, ".system_generated", "logs", "transcript_full.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    mkdirSync(join(root, "conversations"));
    db = new Database(join(root, "conversations", `${session}.db`));
    db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY)");
    writeFileSync(path, "");
    forgetTranscriptState();
  });
  afterEach(() => { db.close(); forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); });
  it("tracks native turn boundaries without treating each DONE tool step as completion", () => {
    expect(page().activity).toBe("idle");
    // Agy 1.3.3's captured native sequence: user, context, planner call, result,
    // context, another call/result, then the tool-free final planner answer.
    add(0, "USER_INPUT", "fictional request");
    add(1, "EPHEMERAL_MESSAGE", "hidden context");
    expect(page().activity).toBe("working");
    add(2, "PLANNER_RESPONSE", "", { thinking: "saved reasoning", tool_calls: [{ name: "run_command", args: { CommandLine: "echo fiction" } }] });
    add(3, "GENERIC", "fictional output");
    add(4, "EPHEMERAL_MESSAGE", "hidden context");
    expect(page().activity).toBe("working");
    expect(JSON.stringify(page().turns)).not.toContain("saved reasoning");
    add(5, "PLANNER_RESPONSE", "More work", { tool_calls: [{ name: "view_file", args: { AbsolutePath: "/fiction.txt" } }] });
    add(6, "GENERIC", "another output");
    expect(page().activity).toBe("working");
    add(7, "PLANNER_RESPONSE", "Finished", { tool_calls: [] });
    expect(page().activity).toBe("idle");
    add(8, "GENERIC", "late result");
    add(9, "EPHEMERAL_MESSAGE", "late context");
    expect(page().activity).toBe("idle");
    add(10, "USER_INPUT", "next turn");
    expect(page().activity).toBe("working");
    // Rewind the new prompt; completion of the retained turn still clears activity.
    db.exec("DELETE FROM steps WHERE idx >= 10");
    expect(page().activity).toBe("idle");
    forgetTranscriptState();
    expect(page().activity).toBe("idle");
  });
  it("does not complete activity from a partial, unadmitted or unfinished planner answer", () => {
    add(0, "USER_INPUT", "one");
    add(1, "PLANNER_RESPONSE", "", { thinking: "saved reasoning" });
    expect(page().activity).toBe("working");
    add(2, "PLANNER_RESPONSE", "unfinished", { status: "RUNNING" });
    expect(page().activity).toBe("working");
    db.exec("INSERT INTO steps VALUES (3)");
    const final = row(3, "PLANNER_RESPONSE", "complete");
    appendFileSync(path, final.slice(0, -2));
    expect(page().activity).toBe("working");
    appendFileSync(path, final.slice(-2));
    expect(page().activity).toBe("idle");
    appendFileSync(path, row(4, "USER_INPUT", "export ahead of DB"));
    expect(page().activity).toBe("idle");
    db.exec("INSERT INTO steps VALUES (4)");
    expect(page().activity).toBe("working");
    forgetTranscriptState();
    expect(page().activity).toBe("working");
  });
  it("renders native messages, multiple planner calls and independent results without guessed pairing", () => {
    add(0, "USER_INPUT", "<USER_REQUEST>Keep <USER_REQUEST>literal</USER_REQUEST> tags</USER_REQUEST>\n<ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>");
    add(1, "EPHEMERAL_MESSAGE", "hidden context");
    add(2, "PLANNER_RESPONSE", "Checking", { tool_calls: [{ name: "run_command", args: { CommandLine: "echo fiction" } }, { name: "view_file", args: { AbsolutePath: "/fiction.txt" } }] });
    add(3, "GENERIC", "independent output");
    add(4, "CHECKPOINT", "not a result");
    add(5, "USER_INPUT", "next");
    const turns = page().turns;
    expect(turns[0]!.parts).toEqual([{ kind: "text", text: "Keep <USER_REQUEST>literal</USER_REQUEST> tags" }]);
    expect(turns[1]!.parts.map((p) => p.kind === "tool" ? [p.name, p.summary, p.output] : p.kind === "text" ? p.text : p.kind)).toEqual([
      "Checking", ["run_command", "echo fiction", ""], ["view_file", "/fiction.txt", ""], ["Tool output", "Step 3", "independent output"],
    ]);
    expect(turns[2]!.role).toBe("user");
  });
  it("keeps paging and refs stable on append, then rejects them on a DB-only idle rewind", () => {
    for (let i = 0; i < 80; i++) { add(i * 2, "USER_INPUT", `prompt ${i}`); add(i * 2 + 1, "GENERIC", "x".repeat(5000)); }
    const first = page();
    expect(first.cursor).not.toBeNull();
    const older = transcriptPage("agy-transcript", path, { before: first.cursor! });
    const tool = first.turns.flatMap((t) => t.parts).find((p) => p.kind === "tool")!;
    if (tool.kind !== "tool") throw new Error("missing result");
    expect(transcriptToolOutput("agy-transcript", path, tool.output_ref!)).toBe("x".repeat(5000));
    add(160, "USER_INPUT", "append");
    expect(page().history_id).toBe(first.history_id);
    expect(transcriptPage("agy-transcript", path, { before: first.cursor! })).toEqual(older);
    db.exec("DELETE FROM steps WHERE idx >= 4");
    const rewound = page();
    expect(rewound.turns).toHaveLength(4);
    expect(rewound.history_id).not.toBe(first.history_id);
    expect(() => transcriptPage("agy-transcript", path, { before: first.cursor! })).toThrow(HistoryChanged);
    expect(transcriptToolOutput("agy-transcript", path, tool.output_ref!)).toBeNull();
    forgetTranscriptState();
    expect(page().turns).toEqual(rewound.turns.map((turn) => ({ ...turn, parts: turn.parts.map((part) => part.kind === "tool" ? { ...part, output_ref: expect.any(String) } : part) })));
  });
  it("replays repeated/backward indices and allows database-only rows", () => {
    add(0, "USER_INPUT", "one"); add(1, "PLANNER_RESPONSE", "old");
    db.query("INSERT INTO steps VALUES (?)").run(2);
    add(3, "USER_INPUT", "two"); add(4, "PLANNER_RESPONSE", "discard");
    const before = page();
    add(3, "USER_INPUT", "replacement");
    expect(page().turns.map((t) => t.parts[0])).toEqual([{ kind: "text", text: "one" }, { kind: "text", text: "old" }, { kind: "text", text: "replacement" }]);
    const revision = page().history_id;
    expect(revision).not.toBe(before.history_id);
    add(4, "PLANNER_RESPONSE", "new");
    expect(page().history_id).toBe(revision);
    add(3, "USER_INPUT", "equal repeat");
    expect(page().history_id).not.toBe(revision);
    const warm = page().turns;
    forgetTranscriptState();
    expect(page().turns).toEqual(warm);
  });
  it("ignores an incomplete tail and does not settle a running row", () => {
    add(0, "USER_INPUT", "one");
    db.query("INSERT INTO steps VALUES (1)").run();
    const text = row(1, "PLANNER_RESPONSE", "complete");
    appendFileSync(path, text.slice(0, -3));
    expect(page().turns).toHaveLength(1);
    appendFileSync(path, text.slice(-3));
    expect(page().turns).toHaveLength(2);
    add(2, "PLANNER_RESPONSE", "unfinished", { status: "RUNNING" });
    expect(JSON.stringify(page().turns)).not.toContain("unfinished");
    add(2, "PLANNER_RESPONSE", "finished");
    expect(JSON.stringify(page().turns)).toContain("finished");
  });
  it("admits a ledger tail when the DB catches up without changing older cursors", () => {
    add(0, "USER_INPUT", "first");
    const initial = page();
    appendFileSync(path, row(1, "PLANNER_RESPONSE", "lagged"));
    expect(page().turns).toHaveLength(1);
    db.exec("INSERT INTO steps VALUES (1)");
    const caughtUp = page();
    expect(caughtUp.history_id).toBe(initial.history_id);
    expect(caughtUp.turns).toHaveLength(2);
    add(2, "PLANNER_RESPONSE", "partial", { status: "RUNNING" });
    const running = page();
    add(2, "PLANNER_RESPONSE", "complete");
    expect(page().history_id).toBe(running.history_id);
    expect(transcriptPage("agy-transcript", path, { from: `${initial.history_id}:0` }).turns).toHaveLength(2);
  });
  it("never resurrects an observed rewind when replacement DB indices precede their ledger rows", () => {
    add(0, "USER_INPUT", "kept"); add(1, "GENERIC", "removed".repeat(1000));
    const before = page();
    db.exec("DELETE FROM steps WHERE idx=1");
    const cut = page();
    db.exec("INSERT INTO steps VALUES (1)");
    expect(page().turns).toEqual(cut.turns);
    expect(page().history_id).toBe(cut.history_id);
    add(1, "GENERIC", "replacement");
    expect(JSON.stringify(page().turns)).toContain("replacement");
    expect(JSON.stringify(page().turns)).not.toContain("removed");
    const part = before.turns[1]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("missing tool");
    expect(transcriptToolOutput("agy-transcript", path, part.output_ref!)).toBeNull();
  });
  it("does not hide later turns behind an unfinished or unknown-status historical row", () => {
    add(0, "USER_INPUT", "first");
    add(1, "GENERIC", "unfinished", { status: "UNKNOWN" });
    expect(page().turns).toHaveLength(1);
    add(2, "USER_INPUT", "later"); add(3, "PLANNER_RESPONSE", "answer");
    expect(page().turns.map(t => t.parts[0])).toEqual([
      { kind: "text", text: "first" }, { kind: "text", text: "later" }, { kind: "text", text: "answer" },
    ]);
  });
  it("uses the same assistant boundaries in full and paged replay around a skipped user row", () => {
    add(0, "USER_INPUT", "first"); add(1, "PLANNER_RESPONSE", "before");
    add(2, "USER_INPUT", "hidden", { status: "UNKNOWN" });
    add(3, "PLANNER_RESPONSE", "after");
    const full = parseAgyTranscript(row(0, "USER_INPUT", "first") + row(1, "PLANNER_RESPONSE", "before")
      + row(2, "USER_INPUT", "hidden", { status: "UNKNOWN" }) + row(3, "PLANNER_RESPONSE", "after"));
    expect(page().turns).toEqual(full);
    expect(full).toHaveLength(2);
  });
  it("continues a bounded cold scan on the next poll", () => {
    add(0, "USER_INPUT", "start");
    for (let i=1; i<=34; i++) add(i, "EPHEMERAL_MESSAGE", "x".repeat(1024 * 1024));
    add(35, "USER_INPUT", "end");
    expect(page).toThrow(ConversationUnavailable);
    expect(page().turns.at(-1)!.parts[0]).toEqual({ kind: "text", text: "end" });
  });
  it("preserves standalone literal user wrapper text", () => {
    add(0, "USER_INPUT", "<USER_REQUEST>literal</USER_REQUEST>");
    expect(page().turns[0]!.parts[0]).toEqual({ kind: "text", text: "<USER_REQUEST>literal</USER_REQUEST>" });
  });
  it.skipIf(process.platform === "win32")("canonicalizes held locks and never chooses among sessions or unheld files", () => {
    const presence = join(root, "presence"); mkdirSync(presence);
    const one = join(presence, "00000000-0000-4000-8000-000000000001.lock");
    const two = join(presence, "00000000-0000-4000-8000-000000000002.lock");
    writeFileSync(one, ""); writeFileSync(two, "");
    expect(agyStoreFromLocks([])).toBeNull();
    expect(agyStoreFromLocks([one, two])).toBeNull();
    expect(agyStoreFromLocks([one])?.path).toBe(path);
    const alias = join(root, "alias"); symlinkSync(presence, alias);
    // Alias a parent of presence, preserving the native held-path shape.
    const link = join(root, "linked-root"); symlinkSync(root, link);
    expect(agyStoreFromLocks([join(link, "presence", one.split("/").at(-1)!)])?.path).toBe(path);
  });
  it("distinguishes unreadable database from verified empty history", () => {
    add(0, "USER_INPUT", "one");
    page();
    db.exec("DROP TABLE steps");
    expect(page).toThrow(ConversationUnavailable);
  });
  it("falls back when the transcript path cannot be inspected", async () => {
    const loop = join(root, "loop"); symlinkSync(loop, loop);
    const pane = { pane_id: "agy-pane", cwd: root, agent: "agy" } as HerdrPane;
    const store = spyOn(agyStore, "resolveAgyStore").mockResolvedValue({ root, session: "test", path: loop, pid: 2, started: "test" });
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never);
    try {
      await expect(paneTranscript(pane.pane_id, undefined, { panes: [pane] } as SessionSnapshot)).rejects.toMatchObject({
        name: "ConversationUnavailable", message: "transcript_missing",
      });
    } finally { store.mockRestore(); rpc.mockRestore(); }
  });
});
