/**
 * herdr-web-ui's own HTTP/WebSocket contract, shared by the Bun server and the React client.
 *
 * The herdr WIRE types are NOT hand-written here: they are generated from herdr's
 * published API schema into ./herdr-api.generated.ts and re-exported below, so a
 * herdr upgrade shows up as a failing `bun run generate:types --check` instead of
 * types that quietly disagree with the server.
 */

export type {
  AgentInfo,
  AgentSessionInfo,
  AgentStatus,
  PaneInfo,
  PaneMoveReason,
  PaneMoveResult,
  PaneLayoutPane,
  PaneLayoutRect,
  PaneLayoutSnapshot,
  PaneReadResult,
  PaneScrollInfo,
  ReadFormat,
  ReadSource,
  SessionSnapshot,
  SplitDirection,
  Subscription as HerdrSubscriptionSpec,
  TabInfo,
  WorkspaceInfo,
} from "./herdr-api.generated.ts";

import type { AgentStatus, PaneInfo, PaneMoveResult, PaneScrollInfo, SessionSnapshot, SplitDirection, TabInfo, WorkspaceInfo } from "./herdr-api.generated.ts";

/** Friendly aliases used across the UI. */
export type HerdrWorkspace = WorkspaceInfo;
export type HerdrTab = TabInfo;
/**
 * `background_tasks`: an OmO pane's `task` children, or a Claude Code pane's subagents and background commands, still running, counted by the server; absent when none.
 * `background_wait`: the pane is at rest while work its turn started still runs, and the turn goes on when it ends (server/background-wait.ts); absent when not.
 * `plan`: how far the pane's agent's task list or checklist has progressed; absent when it keeps none.
 */
export type HerdrPane = PaneInfo & { background_tasks?: number; background_wait?: true; plan?: PlanSummary };

export type { Machine, MachineEvent, PaneTarget, SetupJob, SetupRequest, SetupAction, BridgeIdentity, BridgeHealth } from "./machines.ts";

/** Machine API (same token gate; mutations require X-Herdr-Machine: 1 + same origin)
 * GET /api/health?scope=bridge -> BridgeHealth, never waits for herdr
 * GET /api/bridge -> authenticated BridgeIdentity (socket + runtime compatibility)
 * GET /api/machines -> { machines: Machine[] }; GET /api/machines/events -> MachineEvent SSE
 * Machine action_required=connect: a saved herdr PC awaits explicit POST /api/machines/setup before SSH.
 * Connection permission survives successful setup; installation/startup approval remains separate.
 * SetupJob/Machine action_required=bridge_conflict: align app versions, then retry setup without update_remote.
 * POST /api/machines/setup -> SetupJob; GET/POST/DELETE /api/machines/setup/:job_id
 * PATCH /api/machines/:id { name?, enabled? }; DELETE /api/machines/:id
 * /api/machines/:id/{session,agents,pane/*,workspace/*} -> existing target-local API
 * /ws?machine_id=:id -> immutable target, unchanged role + output ACK protocol
 * Legacy paths and missing machine IDs continue to mean local.
 */

/** HTTP API
 *  GET    /api/health                    -> { ok: true, herdr: HerdrIdentity (shared/machines.ts; terminal_attach false on a
 *                                          Windows herdr and on a bridge that cannot run the PTY sidecar; terminal_mirror: its
 *                                          terminal lens is the pane's screen, repainted; /api/bridge tells the same herdr), auth: HealthAuth,
 *                                          web_ui: { boot_id: string | null, revision: string | null } }
 *  GET    /api/session                   -> { snapshot: SessionSnapshot }
 *  GET    /api/access                    -> RemoteAccess (how a phone can reach this server: what
 *         Tailscale on this PC already serves, or the command to run), no-store
 *  GET    /api/portal                    -> PortalStatus (an optional public HTTPS address through
 *         Portal, server/portal.ts), no-store
 *  POST   /api/portal/start              -> 202 { accepted: true }; body { relay }; 400 invalid_relay,
 *         409 token_required / serve_only / portal_busy / portal_state_in_use / portal_unsupported
 *  POST   /api/portal/stop               -> 202 { accepted: true }; 409 portal_unsupported
 *         Portal POSTs require X-Herdr-Update: 1 and same-origin, like the update POSTs:
 *         403 invalid_portal_request (or invalid_origin from the outer origin gate).
 *         Unsupported methods/actions get 405 method_not_allowed; a watch-only device gets
 *         403 read_only. Startup holds HTTP/WS requests until leftover Portal cleanup completes;
 *         unreadable saved state or unverifiable cleanup fails closed with 500 internal_error.
 *  GET    /api/updates                   -> UpdateStatus (shared/update.ts), no-store
 *  POST   /api/updates/check             -> 202 { accepted: true }
 *  POST   /api/updates/install           -> 202 { accepted: true }
 *         Update POSTs require X-Herdr-Update: 1, same-origin browser requests,
 *         and the usual token gate. Managed starts only; status is polled during restart.
 *  GET    /api/telemetry                 -> TelemetryStatus (shared/telemetry.ts), no-store
 *  POST   /api/telemetry                 -> TelemetryStatus; TelemetryChange (shared/telemetry.ts):
 *         { enabled?, notice_seen?: true, notice_version?, settings? }. A notice acknowledgement
 *         requires the current NOTICE_VERSION. X-Herdr-Update: 1 and same-origin.
 *         404 from a server that sends no telemetry.
 *  GET    /api/agents                    -> { agents: AgentKind[] } (herdr's agent manifests: the
 *         kinds `agent.start` accepts, plus omo and gjc when they are on this server's PATH,
 *         for the new-session dialog)
 *  GET    /api/integrations              -> IntegrationsResponse (herdr's `integration.list`, in
 *         herdr's order; read only: nothing here installs or removes one, Settings shows the
 *         `herdr integration install` command instead)
 *  GET    /api/plugins/actions           -> PluginActionsResponse (plugin.list + plugin.action.list:
 *         every installed plugin with its enabled state and the manifest actions this PC's
 *         platform can run; herdr lists a disabled plugin's actions too, and refuses to run them)
 *  POST   /api/plugin/action { plugin_id, action_id, pane_id? } -> PluginActionResult
 *         (plugin.action.invoke. With pane_id the action gets that pane's whole context: herdr
 *         fills a field the caller left out from its OWN focus, not from the pane named, so what
 *         the pane does not have (an agent, a git checkout, a cwd) goes as empty strings, never
 *         left out. Without pane_id herdr uses its focus throughout. herdr answers as soon as the
 *         command started, so the server waits a few seconds for its log entry: `running` means it
 *         had not ended by then, and the GET below says how it ended. A failed command is a 200
 *         with status `failed`; a refused invoke is herdr's own error: plugin_not_found,
 *         plugin_action_not_found, plugin_disabled, platform_unsupported)
 *  GET    /api/plugin/action?plugin_id=&log_id= -> PluginActionResult (plugin.log.list: where the
 *         run a POST answered `running` for stands now; `log_id` is that answer's. 404
 *         plugin_log_not_found once herdr's log no longer holds it)
 *  GET    /api/pane/read?pane_id=&source=&format=&lines=  -> { read: PaneReadResult }
 *  GET    /api/pane/scroll?pane_id=      -> { scroll: PaneScrollInfo | null } (where the
 *         viewport sits: its top row in the history is max_offset_from_bottom - offset_from_bottom)
 *  POST   /api/pane/scroll { pane_id, offset_from_bottom } -> { scroll } (pane.scroll; herdr
 *         redraws every attached terminal)
 *  POST   /api/pane/find -> PaneFindResponse; PaneFindRequest searches literal text in herdr's
 *         stored history and scrolls the shared viewport to the match, unless jump:false only
 *         reads the native match window. No copy mode is entered. The answer includes at most
 *         1024 matches around the current result and the shared scroll position; total is exact.
 *         A previous match is reused only while content_revision still matches; 409 stale_content
 *         means output or the viewport changed during the read, so the user can search again.
 *  GET    /api/pane/selection?pane_id=&anchor_row=&anchor_col=&cursor_row=&cursor_col=
 *         -> { text } (pane.selection.read: both cells inclusive, rows from the top of the
 *         history, soft-wrapped lines joined; a terminal selection that outlives one screen)
 *  POST   /api/pane/input  { pane_id, text }   -> { ok: true }
 *  GET    /api/pane/conversation?pane_id=    -> ConversationResponse (structured agent
 *         transcript turns - claude, codex, omp, omo, gjc, pi, devin, OpenCode, hermes, grok or agy;
 *         source:"scrollback" when the pane has no recognized, readable store.
 *         Grok requires exact live process/session evidence, Agy live process/session evidence;
 *         rewinds invalidate cursors.
 *         Grok/Agy optional activity describes the latest native turn, independently of pane status.)
 *  POST   /api/pane/close { pane_id }         -> { ok: true } (pane.close RPC; the collector's
 *         session-changed broadcast removes it from every client's sidebar)
 *  POST   /api/pane/rename { pane_id, label } -> { ok: true } (pane.rename; empty label clears it)
 *  POST   /api/pane/focus { pane_id } -> { ok: true } (pane.focus: herdr brings its workspace,
 *         tab and pane to the front, also while the tab is zoomed)
 *  POST   /api/pane/move   { pane_id, destination, focus? } -> PaneMoved (pane.move: the pane into
 *         another tab of its workspace, a new tab there or in another workspace, or a new workspace;
 *         a pane that leaves its workspace gets a NEW pane id, reported beside previous_pane_id; an
 *         emptied tab or workspace closes behind it; focus defaults to false, so herdr's own focus
 *         stays where it was and only the caller follows the pane)
 *  POST   /api/agent/rename { pane_id, name } -> { ok: true } (agent.rename on the pane's live agent:
 *         the name other tools address it by, `herdr agent prompt <name>`; null clears it. herdr
 *         owns the rule (shared/agent-name.ts) and answers invalid_agent_name, agent_name_taken or,
 *         for a pane without a live agent, agent_not_found; the name is read back from
 *         `snapshot.agents[].name`, and pane.updated carries the change to every client)
 *  POST   /api/pane/split  { pane_id, direction: right|down, focus? } -> PaneSplit { ok: true, pane }
 *         (pane.split beside that pane, herdr's prefix+v and prefix+-: `pane` is the new one; focus
 *         false, the default, leaves herdr's focus where it is, true moves it to the new pane as --focus does)
 *  POST   /api/pane/zoom   { pane_id, mode?: toggle|on|off } -> PaneZoomed { ok: true, zoomed, changed, reason }
 *         (pane.zoom, prefix+z: the tab shows that pane alone; herdr focuses the pane it zooms; changed
 *         false names why: single_pane, already_zoomed, already_unzoomed)
 *  POST   /api/pane/swap   { pane_id, direction: left|right|up|down } OR { pane_id, target_pane_id }
 *         -> PaneSwapped { ok: true, changed, reason, target_pane_id } (pane.swap with the neighbour
 *         on that side, prefix+shift+hjkl, or an explicit pane; exactly one destination is required;
 *         changed false names no_neighbor, same_pane, cross_tab or not_found)
 *  POST   /api/pane/resize { pane_id, direction: left|right|up|down, amount? } -> PaneResized { ok: true, changed, reason }
 *         (pane.resize, herdr's resize mode: the border the pane shares with a neighbour moves that way
 *         by `amount` of the split the border belongs to, not of the tab (0 < amount <= 0.5, herdr's
 *         own cap; its 0.05 when absent); changed false, reason unchanged, when no border of the
 *         pane can move that way)
 *  POST   /api/pane/clear  { pane_id } -> { ok: true } (pane.clear: clears the pane's terminal screen)
 *  POST   /api/layout/ratio { tab_id, path: boolean[], ratio } -> { ok: true }
 *         (layout.set_split_ratio: a split in that tab, root at [], false follows the first child,
 *         true the second; finite ratio in 0.1..0.9; an absent split answers split_not_found)
 *  POST   /api/pane/image  { pane_id, content_type, data_base64 } -> { ok: true, path }
 *         pasted image -> file under <pane cwd>/.herdr-web-ui/ (under HERDR_WEB_PASTE_DIR when the
 *         server's environment sets it), path for the prompt
 *  GET    /api/pane/commands?pane_id=   -> { commands: SlashCommand[] } (the agent's slash
 *         commands: built-ins per agent kind + the user's and the project's custom commands)
 *  GET    /api/pane/omo-tasks?pane_id=  -> OmoActivity (the background tasks and workflows the
 *         pane's OmO session started, or a Claude Code pane's subagents (no workflows): running ones, then
 *         those that ended in the last day; empty for any other pane or one whose session is not
 *         known yet. server_time: that PC's clock, which the times are on)
 *  GET    /api/pane/plan?pane_id=       -> PanePlan (the plan the pane's Claude Code or Codex session
 *         keeps: its task list or checklist, read from the transcript; null when it keeps none)
 *  GET    /api/pane/files?pane_id=&q=&limit=  -> { files: string[] } (paths relative to the pane
 *         cwd matching q, for @-mentions; git ls-files when the cwd is a repo, bounded walk otherwise)
 *  GET    /api/workspace/diff/files?pane_id=&directory=&scope=&base=&head= -> RepoDiffFileList
 *         (what changed in the git repository the pane's folder, or `directory`, is inside: read
 *         only, on the PC that owns the pane. `directory` is absolute, `~/…`, or relative to the
 *         pane's folder; one of pane_id and directory is required. scope: workspace (the default:
 *         working tree against the index, plus untracked files), staged (index against HEAD) or
 *         commit (`base` against `head`, HEAD when absent; each one commit). The list is capped
 *         (`limits`), and `truncated` says when it was. 400 invalid_scope / invalid_revision /
 *         invalid_cwd / missing_directory, 404 revision_not_found, 409 not_a_repository,
 *         503 git_unavailable, 504 git_timeout; 403 read_only for a watching device, as a file read)
 *  GET    /api/workspace/diff/file?pane_id=&directory=&scope=&base=&head=&path=&old_path=
 *         -> RepoDiffFilePatch (one file of that comparison as a standard `diff --git` unified
 *         patch; `path` and, for a rename, `old_path` are the list's own, relative to the
 *         repository root. The patch is whole or null: `unavailable` says why it is null, and no
 *         cut hunk is ever sent. 400 invalid_path, 404 not_found when nothing changed there)
 *  GET    /api/pane/prompt?pane_id=     -> { prompt: InteractivePrompt | null, suggestion: string | null, restored: string | null }
 *         (the agent's TUI question/approval menu currently on screen, parsed from the visible pane
 *         text; with no menu, the next prompt Claude Code suggests, grey in its empty input box, and
 *         `restored`: the chat's last message when Claude Code put it back as typed text in that box,
 *         as it does for a send cancelled before any reply; older servers send neither)
 *  POST   /api/pane/prompt/answer { pane_id, prompt_id, option_index?, option_indices?, custom_text? }
 *         -> { ok: true } | 409 prompt_changed (the screen no longer shows that prompt)
 *  POST   /api/workspace/create { cwd?, label?, agent?: { kind, name?, args? } }
 *         -> WorkspaceCreated (workspace.create, then agent.start in the root pane when `agent` is given;
 *         omo and gjc, which herdr cannot start, are typed into the root pane's shell)
 *  POST   /api/tab/create { workspace_id, cwd?, label?, agent?: { kind, name?, args? } }
 *         -> TabCreated (tab.create in that workspace, then the same agent launch in the tab's root
 *         pane; without cwd herdr uses the workspace's folder, without label the tab's number)
 *  POST   /api/tab/rename { tab_id, label } -> { ok: true } (tab.rename; an empty label is refused:
 *         herdr would keep it as the name)
 *  POST   /api/tab/move { tab_id, insert_index } -> TabMoved
 *         (tab.move: an insertion boundary in the original workspace tab order, 0..tab count;
 *         preserves the active tab/pane and returns the authoritative workspace tab order)
 *  POST   /api/tab/close  { tab_id } -> { ok: true } (tab.close: every pane in the tab closes, and
 *         a workspace's last tab takes the workspace with it)
 *  POST   /api/workspace/rename { workspace_id, label } -> { ok: true }
 *  POST   /api/workspace/move   { workspace_id, insert_index } -> { ok: true } (sidebar reorder)
 *  POST   /api/workspace/close  { workspace_id, close_group? } -> { ok: true } (close_group takes the
 *         repository's open worktree workspaces with it; without it herdr refuses: workspace_group_close_required)
 *  POST   /api/worktree/create { workspace_id, branch, base?, label?, path?, agent?: { kind, name?, args? } } -> WorktreeOpened
 *         (worktree.create: a git worktree of that workspace's repo, checked out under herdr's
 *         worktree directory unless `path` says where, and opened as a new workspace grouped with it)
 *  GET    /api/worktree/list?workspace_id= -> WorktreeListing (worktree.list: the repo's checkouts)
 *  POST   /api/worktree/open   { workspace_id, path | branch, label? } -> WorktreeOpened
 *         (worktree.open: an existing checkout as a workspace; already_open names the one it has)
 *  POST   /api/worktree/remove { workspace_id, force? } -> WorktreeRemoved (worktree.remove: deletes the
 *         checkout and closes its workspace, keeps the branch; a dirty checkout is refused without force:
 *         dirty_worktree_requires_force)
 *  POST   /api/auth        { token }     -> 204 + Set-Cookie herdr_web_token (401 invalid_token on mismatch)
 *  DELETE /api/auth                      -> 204, clears the token and the device cookies
 *  GET    /api/devices                   -> { devices: PairedDevice[] } (the paired devices; `current` marks the caller's)
 *  POST   /api/devices/pair/start        -> PairingCode: a six-digit code good for ten minutes, replacing any pending one
 *         (X-Herdr-Machine: 1 + same origin, from a client with full access)
 *  POST   /api/devices/pair { code, label? } -> 204 + Set-Cookie herdr_web_device (public, like /api/auth;
 *         401 invalid_code when the code is wrong, spent after five tries, or expired)
 *  PATCH  /api/devices/:id  { label }    -> PairedDevice;  DELETE /api/devices/:id -> 204 (revoked at its next request)
 *  GET    /api/push                      -> PushKey (the VAPID application server key)
 *  POST   /api/push/subscribe { subscription }  -> 204 (a browser PushSubscription JSON; upsert by endpoint)
 *  DELETE /api/push/subscribe { endpoint }      -> 204
 *  POST   /api/push/test      { endpoint }      -> 204 | 404 subscription_not_found | 502 push_failed
 *  GET    /api/usage[?refresh=1]         -> UsageReport (plan limits of the AI subscriptions signed in on this PC)
 *  Errors: non-2xx with { error: { code, message } }
 *
 *  Access: every route above except /api/health, /api/auth and /api/devices/pair, plus the
 *  /ws upgrade, needs the request to be one of: from this PC itself (no proxy in front);
 *  the PC's own Tailscale login, as `tailscale serve` states it — or, where
 *  HERDR_WEB_TAILSCALE_SERVE_ONLY=1 declares serve the only ingress on a tailnet one login
 *  owns with no tagged node, a serve request that states no login; a paired device's cookie;
 *  the shared token (HERDR_WEB_TOKEN) as cookie or `Authorization: Bearer <token>`. With a
 *  token configured, only the last two count, this PC and its Tailscale login included. Without one, and while no
 *  device is paired, anything that reaches the server is let in as before (the startup
 *  warning says so). Refusals answer 401 `unauthorized` (403 `other_user` for another Tailscale
 *  login, when no token is configured); the upgrade is refused. Static files are always public.
 */
export interface ApiError {
  error: { code: string; message: string };
}

export interface PaneFindMatch {
  start: { row: number; col: number };
  end: { row: number; col: number };
}

export interface PaneFindRequest {
  pane_id: string;
  query: string;
  direction: "forward" | "backward";
  /** Defaults to true. False reads matches without moving the shared viewport. */
  jump?: boolean;
  previous?: PaneFindMatch;
  content_revision?: number;
}

export interface PaneFindResponse {
  total: number;
  /** One-based ordinal, or null when no match was found. */
  current: number | null;
  match: PaneFindMatch | null;
  content_revision: number;
  /** Native window around current, at most 1024; absent on older bridges. End cells are inclusive. */
  matches?: PaneFindMatch[];
  /** Viewport mapping at the searched revision; absent on older bridges. */
  scroll?: PaneScrollInfo | null;
}

/** The subscriptions whose plan limits GET /api/usage can read from a CLI's own sign-in. */
export type UsageProviderId = "claude" | "codex" | "cursor" | "copilot" | "grok" | "antigravity" | "opencode";

/** One limit of a plan: how much of it is used and when it starts over. */
export interface UsageWindow {
  /** the span the limit counts over: a rolling session (5 hours), a day, a week or a billing month */
  readonly kind: "session" | "day" | "week" | "month";
  /** the model or quota a plan limits on its own ("Sonnet", "Premium"); null for the plan-wide limit */
  readonly scope: string | null;
  /** 0 to 100 */
  readonly used_percent: number;
  /** ISO 8601; null when the provider does not say */
  readonly resets_at: string | null;
  /** ISO 8601 time this window began counting; null when the provider states neither it nor the window's length */
  readonly starts_at: string | null;
}

/**
 * Why a provider's numbers are missing or old: its sign-in expired or was refused; the provider
 * asked to slow down; the request failed; the macOS keychain holding the sign-in could not be
 * read from this server's session.
 */
export type UsageProblem = "expired" | "rate_limited" | "failed" | "locked";

export interface ProviderUsage {
  readonly id: UsageProviderId;
  /**
   * One account of one provider, stable across reads: the provider and its account id, or, for a
   * sign-in that does not say whose it is, the provider and where it was found. A PC signed in to
   * two accounts of one provider lists both.
   */
  readonly key: string;
  /** whose plan this is, as its owner knows the account: an email, or a GitHub login; null when unknown */
  readonly account: string | null;
  /** the plan's name as the provider states it ("max", "pro"), when it does */
  readonly plan: string | null;
  /** the last numbers read; kept through a later failure, which `problem` then names */
  readonly windows: readonly UsageWindow[];
  readonly problem: UsageProblem | null;
  /** ISO 8601 time `windows` were read; null when they never were */
  readonly checked_at: string | null;
}

/** GET /api/usage: only providers a CLI on this PC is signed in to are listed, once per account. */
export interface UsageReport {
  readonly providers: readonly ProviderUsage[];
}

/** How a request got in, when it did. */
export type AccessVia = "local" | "tailscale" | "device" | "token" | "open";
/** Why a request did not. */
export type AccessRefusal = "other_user" | "pairing_required" | "token_required";
/** What a paired device may do: drive (type, answer, manage) or only watch. */
export type DeviceRole = "drive" | "watch";

/** GET /api/health `auth`: `authenticated` is whether this request got in; `required` is the opposite, kept for older clients. */
export interface HealthAuth {
  readonly required: boolean;
  readonly authenticated: boolean;
  readonly via?: AccessVia;
  readonly role?: DeviceRole;
  readonly reason?: AccessRefusal;
}

/**
 * GET /api/health, authenticated requests only: this server answers on an address beyond this
 * PC while no access token is set and no device has ever been paired, so anything that can
 * reach that address is let in (`open` in `server/access.ts`). It is a warning, never a gate:
 * nothing about who is let in changes because this field exists.
 *
 * Never sent to a request that did not get in. "This host runs herdr-web-ui with no token"
 * is reconnaissance for whoever is asking, not help.
 */
export interface LanExposure {
  /** the address the server is bound to, so the warning can name where it is reachable */
  readonly host: string;
}

export interface PairedDevice {
  readonly id: string;
  readonly label: string;
  readonly role: DeviceRole;
  readonly created_at: string;
  readonly last_seen_at: string | null;
  /** the device this request came from */
  readonly current: boolean;
}

/** POST /api/devices/pair/start */
export interface PairingCode {
  readonly code: string;
  readonly expires_at: string;
}

/** GET /api/access: how a phone can reach this server, as far as the server can tell (Settings → Phone). */
export interface RemoteAccess {
  /** the port this server listens on; the tailscale command names it */
  readonly port: number;
  readonly tailscale: TailscaleAccess;
}

/** Read from `tailscale status --json` and `tailscale serve status --json`, never by changing anything. */
export interface TailscaleAccess {
  /** missing: no tailscale CLI on this PC; stopped: the CLI is there but the daemon is not running or not logged in */
  readonly state: "missing" | "stopped" | "running";
  /** this PC's MagicDNS name, without the trailing dot */
  readonly dns_name: string | null;
  /** the HTTPS address Tailscale already proxies to this server, when there is one */
  readonly serving_url: string | null;
  /** otherwise, the command that publishes it on the lowest free of the usual HTTPS ports ... */
  readonly serve_command: string | null;
  /** ... and the address that command gives, when the DNS name is known */
  readonly serve_url: string | null;
}

/**
 * GET /api/portal: a public HTTPS address for this server through the Portal on its PC
 * (gosuda/portal-tunnel), which the app starts and stops (Settings → Phone & devices).
 */
export interface PortalStatus {
  /** false on a server started without Portal (tests, the demo): the section stays hidden */
  readonly supported: boolean;
  /** what `portal version` says of the `portal` on PATH; null when there is none or it does not answer */
  readonly version: string | null;
  /** the oldest Portal that can run this app's tunnel */
  readonly min_version: string;
  /** `version` is `min_version` or later: Start is offered */
  readonly usable: boolean;
  readonly phase: "idle" | "starting" | "running" | "stopping" | "error";
  /** the relay the tunnel uses, or used last; an https origin */
  readonly relay: string | null;
  /** the public address while it runs, without the default port */
  readonly url: string | null;
  /** why a start would be refused now: no token set, or tailscale serve declared the only way in */
  readonly blocked: "token_required" | "serve_only" | null;
  /** what went wrong last; null after a success */
  readonly error: string | null;
  /** the tail of what Portal printed, for when the error alone does not say enough */
  readonly output: string | null;
}

/** GET /api/push: base64url VAPID public key, the `applicationServerKey` a browser subscribes with. */
export interface PushKey {
  readonly public_key: string;
}

/** One turn of a structured agent conversation (the chat lens source). */
export interface ConversationTurn {
  role: "user" | "assistant";
  ts: string | null;
  /** Last recorded assistant activity, never the next user's timestamp. */
  end_ts?: string;
  parts: ConversationPart[];
}

/** Evidence of skill activity, not a claim that the skill's workflow completed. */
export interface SkillActivity {
  name: string;
  evidence: "invocation" | "instructions";
  status: "requested" | "loaded" | "failed";
  path?: string;
}

export type ConversationPart =
  | { kind: "text"; text: string; phase?: "commentary" | "final_answer" }
  /** the agent's reasoning block; the client folds it and shows it only on request */
  | { kind: "thinking"; text: string }
  | { kind: "skill"; skill: SkillActivity }
  /** `error`: the call failed (the agent recorded it so, or its output says a command exited non-zero) */
  | {
    kind: "tool"; name: string; summary: string; input: string; output: string; error?: boolean;
    /** Hermes could not load a tool-call list whose arguments exceeded its page limit. */
    arguments_omitted?: true;
    skill?: SkillActivity;
    /** set when `output` was cut: the call's id, for GET /api/pane/conversation/tool-output, and the whole output's length */
    output_ref?: string; output_size?: number;
    /** Recorded images returned by Claude Code, Codex, OpenCode, pi, omp, omo or gjc; same on-demand fetch as a user image. */
    images?: { media_type: string; ref: string }[];
  }
  /** A native Claude Code/Codex/OpenCode/pi/omp/omo/gjc user image, addressed by an opaque ref and fetched on demand: GET /api/pane/conversation/image?pane_id=…&ref=… */
  | { kind: "image"; media_type: string; ref: string }
  /** the summary a compaction left; the conversation before it is what it sums up */
  | { kind: "compact"; text: string }
  /** a message the agent's runtime put in the user's seat (gjc's background-job result): it starts a turn, nobody typed it.
   * `source`: the runtime's name for it (pi's customType, e.g. "async-result", "irc:incoming", "omo-model-profile:unavailable") */
  | { kind: "notice"; text: string; source?: string }
  /** OmO's background tasks that ended, as OmO reported them back to the agent, or a Claude Code subagent that ended (its task notification): it starts a turn, nobody typed it */
  | { kind: "task_result"; tasks: OmoTaskResult[] };

/** One OmO background task that ended (the `senpi-task.completion` OmO wakes its agent with). */
export interface OmoTaskResult {
  id: string;
  /** the summary the `task` call gave it, else its name, else the agent it ran as, else its id */
  title: string;
  /** the agent type or category it ran as */
  agent: string | null;
  model: string | null;
  /** `failed`: OmO reported an error (its `result` says which) */
  status: "completed" | "failed" | "cancelled";
  duration_ms: number | null;
  turns: number | null;
  tool_calls: number | null;
  tokens: number | null;
  /** the task's last answer, or why it failed; at most 16,000 characters, `result_cut` when there was more */
  result: string;
  result_cut?: boolean;
}

/** Latest model settings actually recorded by this agent. */
export interface ConversationMetadata {
  model: string | null;
  /** Recorded reasoning effort / thinking level; null means not reported. */
  reasoning_effort: string | null;
  /**
   * How much of the model's context the last request filled, in tokens; absent until a
   * response reports its usage. `window` is null when the transcript does not say it.
   */
  context?: { used: number; window: number | null };
}

/** One background task of an OmO session, or one subagent of a Claude Code session (GET /api/pane/omo-tasks), from OmO's task record or the subagent's files. */
export interface OmoTask {
  id: string;
  /** the task's summary, else its description or name */
  title: string;
  /** the category or agent type it ran as */
  category: string | null;
  model: string | null;
  /** `lost`: OmO's process that ran it is gone, or the pane no longer runs the Claude Code session that started it */
  status: "running" | "completed" | "failed" | "cancelled" | "lost";
  started_at: string | null;
  ended_at: string | null;
  turns: number | null;
  tool_calls: number | null;
  tokens: number | null;
}

/** One step of an OmO workflow (a DAG node); `error` is why a failed one failed. */
export interface OmoRunNode {
  id: string;
  label: string;
  state: "pending" | "scheduled" | "running" | "blocked" | "completed" | "failed" | "skipped" | "cancelled";
  error: string | null;
}

/** One OmO workflow (a DAG run): its steps by wave, a wave's steps able to run side by side. */
export interface OmoRun {
  id: string;
  name: string;
  /** `pending` and `paused` have not ended either */
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
  started_at: string | null;
  ended_at: string | null;
  waves: OmoRunNode[][];
}

/** GET /api/pane/omo-tasks */
export interface OmoActivity {
  tasks: OmoTask[];
  runs: OmoRun[];
  /** the PC's clock, which the times are on */
  server_time: string;
}

/**
 * One step of the plan an agent keeps for its session (GET /api/pane/plan): a task of Claude
 * Code's task list (`TaskCreate`/`TaskUpdate`), or an item of Codex's `update_plan` checklist.
 */
export interface PlanStep {
  id: string;
  label: string;
  /** what it does now, in the agent's own words (Claude's `activeForm`), when it gave some */
  active: string | null;
  status: "pending" | "in_progress" | "completed";
  /** the steps it waits on: Claude's `blockedBy`, or for Codex the step before it */
  blocked_by: string[];
  /** the teammate it was given to, in a Claude Code agent team */
  owner: string | null;
  started_at: string | null;
  ended_at: string | null;
}

/** GET /api/pane/plan: the plan the pane's agent keeps now, null when it keeps none. */
export interface PanePlan {
  plan: { steps: PlanStep[] } | null;
  /** the PC's clock, which the times are on */
  server_time: string;
}

/** How far a pane's plan has got, for the sidebar: `current` names the step in progress. */
export interface PlanSummary {
  done: number;
  total: number;
  current: string | null;
}

/** GET /api/pane/conversation: native conversation with settings, or scrollback fallback. */
export interface ConversationResponse {
  /** Grok/Agy latest native turn; display feedback only, never input-delivery authority. */
  activity?: "thinking" | "working" | "idle";
  /** Stable across appends; changes on transcript replacement or native context clear. */
  history_id?: string;
  source: "grok-transcript" | "agy-transcript" | "claude-transcript" | "omp-transcript" | "omo-transcript" | "gjc-transcript" | "pi-transcript" | "codex-transcript" | "devin-transcript" | "opencode-transcript" | "hermes-transcript" | "scrollback";
  turns: ConversationTurn[];
  metadata?: ConversationMetadata;
  /**
   * Where the first turn sits in the transcript: pass it as `before` for the page
   * of turns before these (with `since`, never reaching back past that cursor), or
   * as `from` to keep polling from it. A `from` answer starts later than `from` when
   * the newest page has moved past it: the turns in between come from `before` +
   * `since`. null at the conversation's beginning; absent for scrollback and from
   * bridges without pages. A cursor the transcript no longer knows answers 409
   * `history_changed`.
   */
  cursor?: string | null;
  /**
   * Turns the transcript holds on paths a `/tree` walked away from, which no page of this
   * conversation can reach. pi moves its leaf pointer without writing an entry, so those turns
   * would otherwise leave the chat with no sign they were ever there. `summary` is pi's own account
   * of the abandoned path, kept when the user answered `/tree`'s "Summarize branch?" with one.
   * `branches` is how many separate paths were left behind — the places a live entry was given a
   * child that is not live — because the count alone reads the same for one abandoned path of four
   * turns and two of two, and the reader pluralizes on it. A session no `/tree` touched answers
   * zeroes — drawn as nothing — since zero and "unknown" are different answers. Absent for every
   * agent that keeps no entry tree.
   */
  abandoned?: { count: number; branches: number; summary: string | null };
}

/** Where a plugin manifest says an action applies. herdr may add more, so it stays open. */
export type PluginActionContext = "global" | "workspace" | "tab" | "pane" | "selection" | (string & {});

/** One manifest action of a herdr plugin. Its command line stays on the server. */
export interface PluginAction {
  /** local to its plugin: herdr's global name is `<plugin_id>.<action_id>` */
  action_id: string;
  title: string;
  description: string | null;
  /** empty when the manifest names none */
  contexts: PluginActionContext[];
}

/** GET /api/plugins/actions: one installed plugin and the actions this PC can run. */
export interface PluginActions {
  plugin_id: string;
  name: string;
  version: string;
  description: string | null;
  /** herdr refuses a disabled plugin's actions (`plugin_disabled`) */
  enabled: boolean;
  actions: PluginAction[];
}

export interface PluginActionsResponse {
  plugins: PluginActions[];
}

/** POST /api/plugin/action. Without `pane_id` herdr runs the action in its own focus. */
export interface PluginActionRequest {
  plugin_id: string;
  action_id: string;
  pane_id?: string;
}

/** POST /api/plugin/action: what herdr's plugin command log said by the time the server answered. */
export interface PluginActionResult {
  /** herdr's log entry of this run: what GET /api/plugin/action is asked about while it is `running` */
  log_id: string;
  /** `running`: the command had not ended when the wait ran out */
  status: "running" | "succeeded" | "failed";
  exit_code: number | null;
  /** a failed command's own words (spawn error, else the end of stderr, else of stdout); null otherwise */
  output: string | null;
  /**
   * The pane this run's own output says it opened with focus (the answer of `herdr plugin pane
   * open --focus`), while that pane still exists. Null for everything else: a command that
   * printed no such answer, a popup (it has no pane ID), and a pane that merely appeared while
   * the command ran, which nothing ties to it.
   */
  opened_pane_id: string | null;
}

/** GET /api/agents: one agent kind herdr can start (`agent.start` kind), with a display label. */
/** GET /api/workspace/directories: the folders inside one directory, for the folder browser. */
export interface DirectoryListing {
  /** the directory listed, absolute */
  path: string;
  /** its parent, or null at the root */
  parent: string | null;
  /** the user's home, so the browser can show `~` and offer a way back */
  home: string;
  /** folder names, sorted; hidden ones only when asked for */
  directories: string[];
  /** more folders than the list holds */
  truncated: boolean;
  /** the files beside the folders, when asked for (`files=1`), sorted, within the same cap */
  files?: { name: string; size: number }[];
}

/** How the file viewer shows a file. */
export type FileKind = "image" | "video" | "audio" | "pdf" | "text" | "binary";

/**
 * GET /api/fs/stat: a file the viewer can open (GET /api/fs/file streams it). An HTML page is
 * `text` with `mime` "text/html": `/api/fs/file` serves it as plain text, and as the page itself
 * only with `render=1`, in a sandbox with no origin and no network of its own.
 */
export interface FileInfo {
  path: string;
  name: string;
  size: number;
  /** ISO time of the last change */
  modified: string;
  mime: string;
  kind: FileKind;
}

/** Which two states of a repository are compared. */
export type RepoDiffScope = "workspace" | "staged" | "commit";

/** How one file changed. `untracked` exists only in the `workspace` scope. */
export type RepoDiffStatus = "added" | "deleted" | "modified" | "renamed" | "copied" | "type_changed" | "unmerged" | "untracked";

/** The repository a comparison was read from, on the PC that owns it. */
export interface RepoDiffRepository {
  /** the working tree's top folder, absolute */
  root: string;
  /** the checked-out branch; null on a detached HEAD */
  branch: string | null;
  /** HEAD's commit hash; null before the first commit */
  head: string | null;
  detached: boolean;
  /** no commit yet: `staged` then lists everything added so far */
  unborn: boolean;
}

export interface RepoDiffFile {
  /** relative to the repository root, forward slashes, as git names it (never quoted) */
  path: string;
  /** where a renamed or copied file came from; null otherwise */
  old_path: string | null;
  status: RepoDiffStatus;
  /** lines added and removed; null for a binary file, an untracked one, and past the list's byte cap */
  additions: number | null;
  deletions: number | null;
  /** null when not determined: an untracked file in a list is not opened to find out */
  binary: boolean | null;
}

/** GET /api/workspace/diff/files */
export interface RepoDiffFileList {
  repository: RepoDiffRepository;
  scope: RepoDiffScope;
  /** the commits compared, as full hashes, in the `commit` scope; null in the others */
  base: string | null;
  head: string | null;
  /** sorted by path, at most `limits.max_files` */
  files: RepoDiffFile[];
  /** how many files changed in all; null when git printed more than `limits.max_list_bytes` */
  total: number | null;
  /** `files` is not the whole list */
  truncated: boolean;
  limits: { max_files: number; max_list_bytes: number };
}

/**
 * GET /api/workspace/diff/file. `patch` is git's own output for that one file, from its
 * `diff --git` line on, and is either complete or null.
 */
export interface RepoDiffFilePatch {
  repository: RepoDiffRepository;
  scope: RepoDiffScope;
  base: string | null;
  head: string | null;
  file: RepoDiffFile;
  patch: string | null;
  /**
   * Why there is no patch: `binary` (no text to show), `too_large` (past `limits.max_patch_bytes`),
   * `unmerged` (a conflict: git prints a combined diff, which is not a unified patch) or
   * `unsupported` (an untracked path that is not a regular file). Null when `patch` is set.
   */
  unavailable: "binary" | "too_large" | "unmerged" | "unsupported" | null;
  /** the patch exists and was left out for its size */
  truncated: boolean;
  limits: { max_patch_bytes: number; context_lines: number };
}

export interface AgentKind {
  kind: string;
  label: string;
}

/**
 * GET /api/integrations: one of herdr's built-in agent integrations (`integration.list`, herdr
 * 0.9.3; the saved schema predates it, so the shape is written out here). `state` widens like the
 * generated enums: a newer herdr may report one this build does not know.
 */
export interface AgentIntegration {
  /** herdr's integration target, e.g. `claude`, `antigravity_cli` */
  target: string;
  /** the name herdr shows, also the argument `herdr integration install` takes */
  label: string;
  /** the agent's executable */
  command: string;
  /** whether that executable is on the PATH of the PC herdr runs on */
  available: boolean;
  state: "not_installed" | "current" | "outdated" | (string & {});
}

export interface IntegrationsResponse {
  integrations: AgentIntegration[];
}

export interface CreateWorkspaceRequest {
  cwd?: string | null;
  label?: string | null;
  agent?: { kind: string; name?: string; args?: string[] } | null;
}

/** POST /api/tab/move: the boundary is counted BEFORE removing the source tab. */
export interface MoveTabRequest { tab_id: string; insert_index: number; }
export interface TabMoved {
  ok: true;
  tabs: HerdrTab[];
}

/** POST /api/tab/create: the workspace is required; `label` names the new tab. */
export interface CreateTabRequest extends CreateWorkspaceRequest {
  workspace_id: string;
}

/** POST /api/workspace/create: the workspace herdr made and the pane the agent (if any) runs in. */
/** POST /api/worktree/create: branch is the new checkout's branch (created from base, or HEAD, unless it exists). */
export interface CreateWorktreeRequest {
  workspace_id: string;
  branch: string;
  base?: string | null;
  label?: string | null;
  /** an absolute checkout path; herdr's `<worktrees.directory>/<repo>/<branch>` when absent */
  path?: string | null;
  /** started in the new workspace's root pane, as /api/workspace/create starts one */
  agent?: { kind: string; name?: string; args?: string[] } | null;
}

/** POST /api/worktree/open: one of path or branch names the checkout. */
export interface OpenWorktreeRequest {
  workspace_id: string;
  path?: string | null;
  branch?: string | null;
  label?: string | null;
}

/** The workspace a worktree is open in, and its root pane. `already_open` when open before the call. */
export interface WorktreeOpened {
  workspace_id: string;
  pane_id: string;
  already_open: boolean;
  path: string;
  branch: string | null;
  /** create with `agent` only: whether herdr reported it ready in the root pane */
  agent_started?: boolean;
  /** The worktree's workspace still exists when its requested agent could not start. */
  error?: { code: string; message: string };
}

/** POST /api/agent/rename: the live name of the agent in the pane; null clears it. */
export interface AgentRenameRequest {
  pane_id: string;
  name: string | null;
}

/** POST /api/worktree/remove: `git worktree remove` of the workspace's checkout; force when git refuses a dirty one. */
export interface RemoveWorktreeRequest {
  workspace_id: string;
  force?: boolean;
}

export interface WorktreeRemoved {
  ok: true;
  path: string;
  forced: boolean;
}

/** One checkout of a repository, from herdr's `worktree.list` (git worktree list, annotated). */
export interface WorktreeEntry {
  path: string;
  branch: string | null;
  label: string;
  is_linked_worktree: boolean;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  /** the herdr workspace this checkout is open in, if any */
  open_workspace_id: string | null;
}

/** GET /api/worktree/list: the repository the workspace is in, and every checkout of it. */
export interface WorktreeListing {
  source: { repo_key: string; repo_name: string; repo_root: string; source_checkout_path: string; source_workspace_id: string | null };
  worktrees: WorktreeEntry[];
}

export interface WorkspaceCreated {
  workspace_id: string;
  pane_id: string;
  /** true when `agent` was requested and herdr reported it ready in the root pane */
  agent_started: boolean;
  /** The workspace still exists when its requested agent could not start. */
  error?: { code: string; message: string };
}

/**
 * POST /api/tab/create: the existing workspace and the new tab's root pane. A failed agent
 * launch leaves the tab there, reachable through pane_id, as workspace creation does.
 */
export type TabCreated = WorkspaceCreated;

/**
 * POST /api/pane/move: where the pane goes. herdr's PaneMoveDestination with the `type` the
 * generated union widens to a string spelled out, so a caller cannot send a kind herdr has not got.
 * `tab` lands beside the tab's focused pane (`target_pane_id` names another) on the side `split`
 * says, right when absent; `new_tab` without a workspace stays in the pane's own.
 */
export type MovePaneDestination =
  | { type: "tab"; tab_id: string; split?: SplitDirection; target_pane_id?: string | null; ratio?: number | null }
  | { type: "new_tab"; workspace_id?: string | null; label?: string | null }
  | { type: "new_workspace"; label?: string | null; tab_label?: string | null };

export interface MovePaneRequest {
  pane_id: string;
  destination: MovePaneDestination;
  /** herdr's focus follows the pane when true; absent or false leaves it where it was */
  focus?: boolean;
}

/**
 * POST /api/pane/move: herdr's move result. `pane` is the pane where it now stands, under a new
 * `pane_id` when it changed workspace (`previous_pane_id` is the one the caller sent); `changed`
 * false with `reason: "same_tab"` means it already was where it was asked to go. `created_tab`
 * and `created_workspace` name what the move made, `closed_tab_id` and `closed_workspace_id` what
 * it emptied and herdr closed behind it.
 */
export type PaneMoved = PaneMoveResult;

/** The two ways herdr splits a pane: a new pane to its right, or below it. */
export type SplitPaneDirection = "right" | "down";

/** A neighbour's side, for swapping and resizing: herdr's own left/right/up/down. */
export type PaneDirection = "left" | "right" | "up" | "down";

/** POST /api/pane/split: `focus` true moves herdr's focus to the new pane (its --focus); false, the default, leaves it. */
export interface SplitPaneRequest {
  pane_id: string;
  direction: SplitPaneDirection;
  focus?: boolean;
}

/** The pane herdr made, as its snapshot lists it (focused only when `focus` asked for it). */
export interface PaneSplit {
  ok: true;
  pane: PaneInfo;
}

/** POST /api/pane/zoom: a toggle by default; `on` and `off` set the state instead. */
export interface ZoomPaneRequest {
  pane_id: string;
  mode?: "toggle" | "on" | "off";
}

/** `zoomed` is the tab's state after the call; `reason` says why `changed` is false (single_pane, already_zoomed, already_unzoomed). */
export interface PaneZoomed {
  ok: true;
  zoomed: boolean;
  changed: boolean;
  reason: string | null;
}

/** POST /api/pane/focus: focus this exact pane in herdr, including its workspace and tab. */
export interface FocusPaneRequest { pane_id: string }

/** POST /api/pane/swap: exactly one of a neighbouring side or an explicit pane in the same tab. */
export type SwapPaneRequest = { pane_id: string } & (
  | { direction: PaneDirection; target_pane_id?: never }
  | { target_pane_id: string; direction?: never }
);

/** `target_pane_id` is the requested pane or neighbour; unchanged reasons include no_neighbor, same_pane, cross_tab and not_found. */
export interface PaneSwapped {
  ok: true;
  changed: boolean;
  reason: string | null;
  target_pane_id: string | null;
}

/**
 * POST /api/pane/resize: the border the pane shares with a neighbour moves `direction`-wards by
 * `amount` of the split that border belongs to, which herdr measures on the split's own extent,
 * not the tab's (0.25 in a 60-column half of a 120-column tab moves the border 15 columns, not
 * 30). herdr caps the amount at 0.5 and holds a split's ratio to 0.1..0.9, so the server refuses
 * more than 0.5 (invalid_amount) rather than let herdr quietly take less; its own 0.05 when
 * absent. Measured on herdr 0.9.3.
 */
export interface ResizePaneRequest {
  pane_id: string;
  direction: PaneDirection;
  amount?: number;
}

/** `changed` false with reason unchanged: no border of the pane could move that way. */
export interface PaneResized {
  ok: true;
  changed: boolean;
  reason: string | null;
}

/** POST /api/layout/ratio: false takes the first branch, true the second; [] names the root split. */
export interface SetSplitRatioRequest {
  tab_id: string;
  path: boolean[];
  /** finite, inclusive 0.1..0.9, the bounds of herdr's split drag */
  ratio: number;
}

/** GET /api/pane/commands: one slash command the pane's agent understands. */
export interface SlashCommand {
  /** without the leading slash (or `$`) */
  name: string;
  description: string;
  source: "builtin" | "user" | "project" | "skill" | "plugin";
  /** `$`: typed as `$name` (Codex skills); otherwise `/name` */
  trigger?: "$";
}

/**
 * GET /api/pane/prompt: an agent's interactive TUI menu currently on the pane's screen
 * (Claude/omp/codex question, approval or plan prompts), parsed server-side from the
 * visible text. `id` names what the prompt says and which asking of it this is: an answer
 * names it, and one whose prompt changed between the read and the click is refused (409
 * prompt_changed) instead of misfired. The same question asked again has another id only where
 * the server saw the first asking end (a read without it, an answer through this route, the
 * agent back at work); a prompt answered outside the app and asked again unseen keeps its id.
 * The client tells one prompt from the next by the id alone.
 */
export interface InteractivePrompt {
  id: string;
  agent: string;
  kind: "question" | "approval" | "plan" | "menu";
  title: string;
  question: string;
  body: string | null;
  options: InteractivePromptOption[];
  multi_select: boolean;
  /** index of the "type your own answer" option, when the menu has one */
  custom_option_index: number | null;
  /** a question in Codex's queue while Codex keeps working: only the card answers it. Collapsed,
   * a message typed in the chat still goes to Codex; open in the terminal, the queue holds the
   * input, so the chat sends nothing until it is answered or closed */
  queued?: "collapsed" | "open";
  /** the questions of a form that asks several at once (omo), in order: which are answered and
   * which one the card asks now (none while the answers are reviewed). Absent for one question */
  steps?: InteractivePromptStep[];
  /** the last-resort card for a blocked pane no reader knows: answered with its own buttons only,
   * so a message typed in the chat still goes to the agent as typed */
  fallback?: true;
}

export interface InteractivePromptStep {
  label: string;
  answered: boolean;
  current: boolean;
}

export interface InteractivePromptOption {
  label: string;
  description: string | null;
}

/** POST /api/pane/prompt/answer body. Exactly one of option_index / option_indices / custom_text. */
export interface PromptAnswer {
  pane_id: string;
  prompt_id: string;
  option_index?: number;
  option_indices?: number[];
  custom_text?: string;
}

/**
 * The JSON inside every web push, decrypted by the device's service worker (public/sw.js)
 * and shown as a notification. `pane_id` is null for the enable-confirmation push; `tag`
 * is shared with the in-tab notification of the same pane, so one replaces the other.
 */
export interface PushPayload {
  /** Absent in legacy payloads means local. */
  machine_id?: string;
  pane_id: string | null;
  /** The workspace the pane was last seen in, so the tap of an ended pane opens that workspace. Absent when not known. */
  workspace_id?: string;
  title: string;
  body: string;
  tag: string;
}

/** WebSocket at /ws
 *
 *  Client -> server frames: attach {pane_id, cols, rows} | detach {pane_id} | input {pane_id, text}
 *    | keys {pane_id, keys} | resize {pane_id, cols, rows} | role {mode}
 *    | pty-ack {pane_id, stream_id, offset} | secret {id, pane_id, prompt, secret}
 *    | watch {pane_id, cols, rows} | unwatch {pane_id} | conversation-watch {pane_id, enabled}
 *  Server -> client frames: snapshot | pty-data | pty-exit | pane-geometry | role-ack
 *    | pane-status | pane-exited | session-changed | conversation-changed | secret-result
 *    | watch-data | watch-end | error
 *
 *  attach {flow_control:"ack"} opts into per-subscription output credit.
 *  pty-data.flow carries a stream_id and cumulative UTF-8 payload offset;
 *  pty-ack is sent AFTER xterm's write callback, never on receipt or reconnect.
 *  Slow consumers close with code 4008; the UI requires an explicit pane reopen.
 *
 *  Roles: a connection starts as `interact`. `role {mode:"observe"}` demotes it server-side:
 *  input/keys/resize then answer a `read_only` error frame and attaching never resizes the
 *  shared pty - the observer instead receives `pane-geometry` and adopts the pty's grid, so
 *  a phone watching a pane can never change the size the operator's PC sees. The client
 *  re-sends its role before the attach replay on reconnect.
 *  secret requires the "secret-input" feature, an interact attachment, a matching fresh
 *  prompt and an idle input queue. Its result contains only ok/code, never the value.
 *  watch requires the "watch" feature: a read-only view of the pane drawn for the client's grid
 *  (`herdr terminal session observe`), which, unlike an attach, leaves the pane at the size herdr's
 *  own window gives it. It is not an attach: no input, resize, ACK or input-ready. A tab out of use
 *  detaches and watches; it attaches again when the user is back. One watch per pane and connection;
 *  a second watch for the same pane starts it again at the new grid. watch-end: the view ended
 *  (unwatch does not answer one), and a pane the view could not start for gets one at once.
 */

/** A connection's authority over the shared ptys: `interact` types and resizes, `observe` only watches. */
export type ClientRole = "interact" | "observe";

/** A follow-up accepted by this bridge, scoped to the connection that submitted it. */
export interface PendingMessage {
  id: string;
  request_id: number;
  text: string;
  state: "queued" | "sending" | "held" | "uncertain";
  created_at: string;
  error?: { code: string; message: string };
}

export type ClientMessage =
  /** keep_size: the grid is covered (the chat lens), so the attach leaves the shared pty's size as it is */
  | { type: "attach"; pane_id: string; cols: number; rows: number; flow_control?: "ack"; keep_size?: boolean }
  | { type: "detach"; pane_id: string }
  /** Native invalidations require "conversation-watch" and an attachment; observers may subscribe.
   * Detaching clears interest, so reconnect/reattach must enable it again. REST remains authoritative. */
  | { type: "conversation-watch"; pane_id: string; enabled: boolean }
  /** a pane another web bridge holds (`attach_held`): take herdr's attach slot from it, here, now */
  | { type: "take-over"; pane_id: string }
  | { type: "input"; pane_id: string; text: string }
  | { type: "keys"; pane_id: string; keys: string[] }
  /** a composer message, sent to servers whose snapshot lists "submit": the server types it and
   * its own Enter after a short gap, and answers with a submit-result of the same id. `text` is
   * the message as written (agent.prompt pastes it itself), `payload` the same shaped for the
   * pane's bracketed-paste mode, typed when no agent is in front. `typed`: the terminal's own
   * input line, which types `payload` like the keyboard would even into an agent's open menu.
   * `delivery:queue` requires "pending-input" and a live interact attachment: while the agent
   * works the bridge keeps the message until its next turn, or the owner explicitly steers it.
   * `delivery:hold` (feature "pending-hold") is the same, except the message is kept as held, also
   * when it arrives after the turn ended: it never goes on its own, only when the owner steers it.
   * Omission keeps the legacy immediate submission. Queued messages never resume after lease loss.
   * Queue request ids increase monotonically per connection; recent duplicates replay their
   * receipt, and retired ids are rejected rather than executed after history eviction.
   * `clear_draft`: an immediate chat message only, sent again over the `draft` its input_draft
   * refusal named: the server clears Claude's input box first while it still holds exactly that,
   * and refuses again (input_draft) when it holds anything else or does not read empty after. */
  | { type: "submit"; id: number; pane_id: string; text: string; payload: string; typed?: boolean; delivery?: "immediate" | "queue" | "hold"; clear_draft?: string }
  | { type: "pending-action"; id: number; pane_id: string; pending_id: string; action: "steer" | "discard" }
  /** Masked input: revalidate the visible prompt, type literal bytes + Enter immediately.
   * Never queued, retried, sent through agent.prompt, or echoed in a result. */
  | { type: "secret"; id: number; pane_id: string; prompt: string; secret: string }
  | { type: "resize"; pane_id: string; cols: number; rows: number }
  /** Cumulative UTF-8 payload bytes processed by xterm, only for this subscription. */
  | { type: "pty-ack"; pane_id: string; stream_id: string; offset: number }
  | { type: "role"; mode: ClientRole }
  /** whether this page is in use: visible and focused. While any connection of a server says
   * so, that server sends no web push to any device (#751). Sent on connect and on every change,
   * also through a remote PC's socket (the connection server reads it there too); an older
   * server ignores it, so it needs no feature. */
  | { type: "presence"; active: boolean }
  /** a read-only view of the pane at this grid, for a tab out of use (feature "watch"); never resizes the pane */
  | { type: "watch"; pane_id: string; cols: number; rows: number }
  | { type: "unwatch"; pane_id: string }
  /** liveness only (feature "ping"): answered at once with a `pong` of the same id, for any role. The
   * client sends it when the page comes back, the network changes or nothing arrived for a while,
   * and drops a socket that stays silent: a half-open one still reads OPEN in the browser. A remote
   * PC's socket relays it unchanged, so the remote server's snapshot decides whether it is sent. */
  | { type: "ping"; id: number };

/** What a server supports beyond the base protocol, listed in its first snapshot; older bridges list nothing. */
export type ServerFeature = "submit" | "pending-input" | "pending-hold" | "secret-input" | "input-ready" | "take-over" | "watch" | "conversation-watch" | "ping";

export type ServerMessage =
  | { type: "snapshot"; snapshot: SessionSnapshot; features?: ServerFeature[] }
  /** raw PTY bytes: append to the terminal, never repaint over it. A mirrored pane (HerdrIdentity.terminal_mirror) sends whole screens the same way. */
  | { type: "pty-data"; pane_id: string; data: string; flow?: { stream_id: string; offset: number } }
  | { type: "pty-exit"; pane_id: string; code: number | null }
  /** a pane that waited for another web bridge to let go of its terminal (error `attach_held`) is attached again */
  | { type: "attach-resumed"; pane_id: string }
  /** Attachment readiness (omitted ready means true); false revokes it during retry. Never a typed-text acknowledgement. */
  | { type: "input-ready"; pane_id: string; ready?: boolean }
  /** the shared pty's grid changed: observe clients adopt it, interact clients drive it. `fixed`: the grid is the pane's own in herdr (a mirrored pane), so every client adopts it and none resizes */
  | { type: "pane-geometry"; pane_id: string; cols: number; rows: number; fixed?: boolean }
  | { type: "role-ack"; mode: ClientRole }
  /** ok after Enter delivery, or bridge acceptance (`pending`); never an agent execution acknowledgement.
   * `draft`: on an immediate send's input_draft, the one-row draft in Claude's input box that a send
   * with `clear_draft` may clear (absent when the box is not one the server clears).
   * `submit_partial`: the explicitly confirmed terminal draft was cleared, but the send's
   * deadline then expired before the message was sent; never a nothing-typed receipt. */
  | { type: "submit-result"; id: number; pane_id: string; ok: boolean; pending?: PendingMessage; code?: string; message?: string; draft?: string }
  | { type: "pending-result"; id: number; pane_id: string; pending_id: string; ok: boolean; code?: string; message?: string }
  /** Owner-only receipt and state; only an explicit removed outcome permits deleting a retained client message. */
  | { type: "pending-messages"; pane_id: string; messages: PendingMessage[]; removed?: Array<{ id: string; outcome: "sent" | "discarded" }> }
  | { type: "secret-result"; id: number; pane_id: string; ok: boolean; code?: string }
  /** agent-status push for ANY pane, attached or not (server-side status collector) */
  | { type: "pane-status"; pane_id: string; agent_status: AgentStatus; /** a pane's running background tasks (OmO's, or a Claude Code pane's subagents and commands), when the frame is about them: it changes no status */ background_tasks?: number; /** every frame says it: absent, the pane does not wait on its turn's background work */ background_wait?: true; /** a pane's plan, when the frame is about it (null: it keeps none now); it changes no status */ plan?: PlanSummary | null }
  /** Native transcript invalidation for an interested attached pane; signature is opaque, not a REST ETag. Refetch the existing conversation endpoint. */
  | { type: "conversation-changed"; pane_id: string; signature: string }
  /** a pane's process exited (pushed even when nobody is attached to it) */
  | { type: "pane-exited"; pane_id: string }
  /** session structure changed (pane created/closed): refetch /api/session */
  | { type: "session-changed" }
  /** a watched pane's screen as herdr draws it for the watch's grid: whole screens and changes, written as they come; never acknowledged */
  | { type: "watch-data"; pane_id: string; data: string }
  /** the watch ended (pane gone, herdr closed it, or this herdr has no read-only view); the client keeps its last screen */
  | { type: "watch-end"; pane_id: string }
  /** the answer to a `ping`, with its id; only this frame, for a ping in flight, ends the client's liveness probe */
  | { type: "pong"; id: number }
  /** `pane_id` names the pane an error is about, when it is about one (`attach_held`) */
  | { type: "error"; code: string; message: string; pane_id?: string };

/** herdr's default socket, under XDG_CONFIG_HOME when set, as herdr itself resolves it. */
export const HERDR_SOCKET_PATH = `${process.env["XDG_CONFIG_HOME"] || `${process.env["HOME"] ?? ""}/.config`}/herdr/herdr.sock`;
export const DEFAULT_PORT = 7317;
