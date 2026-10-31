/** What a host is and offers, plus the shell state it persists across reloads. */
import type { HostKind, HostScope } from './primitives.js';

/**
 * One agent engine the host can start, as the frontend's engine picker names it.
 * The list is fixed for the host's lifetime; choosing one is a draft decision,
 * not a capability.
 */
export interface EngineOption {
  /** The stable engine kind (`pi`, `opencode`). */
  kind: string;
  /** The display label. */
  label: string;
  /** True for the engine new sessions start in when the draft has no choice. */
  default?: boolean;
}

export interface HostCapabilities {
  hostKind: HostKind;
  scope: HostScope;
  /**
   * Every engine this host can start, with labels and the configured default.
   * Optional: a host that predates engine selection, or one that cannot enumerate
   * its engines, leaves it out and the frontend shows no engine picker.
   */
  engines?: EngineOption[];
  /** Host can read the active editor selection / open files. */
  editorContext: boolean;
  /**
   * Host streams the editor's current state as it changes
   * (`context/selectionLive`): a selection is a range chip whose numbers follow
   * the drag, a merely focused file is a whole-file chip with no line number,
   * and an empty path clears the chip. Optional: hosts without an editor leave
   * it off.
   */
  selectionLive?: boolean;
  /** Host renders interaction requests natively (QuickPick, InputBox, ...). */
  nativeDialogs: boolean;
  /** Host can insert text into an editor. */
  insertIntoEditor: boolean;
  /** Host can reveal a file in the editor. */
  revealFile: boolean;
  /**
   * Host can list workspace files, so the frontend can offer a file picker.
   * Optional: hosts without it simply do not show the picker.
   */
  filePicker?: boolean;
  /**
   * Host can receive a file the browser read (base64) and store it on its own
   * disk, returning a path the frontend can `@mention`. Browsers cannot hand a
   * dragged file's path to the agent, so this is how a browser host attaches a
   * real file. Optional: hosts that cannot write files leave it off.
   */
  fileUpload?: boolean;
  /**
   * Host can list directories on its own filesystem, so the frontend can offer
   * a folder browser when the user has to choose which project a new session
   * belongs to. VS Code already has a workspace folder and leaves it off; the
   * browser host, where any directory is fair game, turns it on.
   */
  directoryPicker?: boolean;
  /**
   * Host can read a file's contents (`readFile`), so the frontend can render an
   * Explorer and open files in its own preview tabs. This is the browser host's
   * stand-in for a text editor; VS Code already has an Explorer and an editor,
   * so it leaves this off and keeps its native ones.
   */
  filePreview?: boolean;
  /**
   * Host can fork the conversation before a past user message, which is how a
   * user edits a prompt the agent already answered. Optional: an agent backend
   * without fork support leaves it off and the frontend hides the affordance.
   */
  editMessage?: boolean;
  /**
   * Host can branch a new session before a past user message (`chat/fork`) and
   * hand that prompt back to the composer. The same pi primitive as
   * `editMessage`, only without sending anything. Optional: an agent backend
   * without fork support leaves it off and the frontend hides the affordance.
   */
  forkMessage?: boolean;
  /**
   * Host allows the frontend to ask the registry whether a newer Morse has been
   * published, so the sidebar can say so instead of letting a reader run a stale
   * build forever. Optional and explicit because it is the only thing a frontend
   * ever does over the internet: a locked-down deployment (or a webview whose CSP
   * forbids it) leaves it off and the frontend stays quiet.
   */
  updateCheck?: boolean;
  /**
   * Host can install a newer Morse build for itself and relaunch it
   * (`updateHost`), so the browser footer's update notice becomes a button
   * instead of only a link. Only the npm-installed server host sets it, and only
   * when the install is writable and `MORSE_SELF_UPDATE=1` opted in: a global
   * install may need root, and the browser UI is unauthenticated, so this must
   * never be on by accident. VS Code updates through the Marketplace and leaves
   * it off.
   */
  selfUpdate?: boolean;
  /**
   * The installed pi version, so the frontend can tell when a newer pi is out
   * and say how this host updates it (`pi update`). Optional: a host that could
   * not read pi's package leaves it off and the pi notice stays quiet.
   */
  piVersion?: string;
  /**
   * Host can read the active project's git history (`gitLog`), so the frontend
   * can offer a git panel: a commit list and its branch graph. The browser host
   * serves a machine with no editor and turns it on; VS Code keeps its own
   * Source Control view and leaves it off.
   */
  gitPanel?: boolean;
  /**
   * Host can manage MCP servers (`mcpStatus`/`mcpAdd`/`mcpRemove`/
   * `mcpSetEnabled`): list their configured state, add one, remove one, or turn
   * one off. Each command names its engine, so the servers of pi and OpenCode
   * never mix; a host whose engines all lack MCP administration leaves this off
   * and the frontend hides the affordance instead of promising it.
   */
  mcp?: boolean;
  /**
   * Host can search the project's files for text (`searchWorkspace`), so the
   * frontend can offer a search panel: matches grouped by file, each line a
   * click from the preview. The browser host turns it on (ripgrep when it is
   * installed, a built-in walk otherwise); VS Code has its own Search view and
   * leaves it off.
   */
  searchPanel?: boolean;
  /**
   * Host can run an interactive shell for the frontend's bottom panel
   * (`terminal/open` and friends), streaming its output back. VS Code already
   * has an integrated terminal and leaves it off; the browser host turns it on,
   * so the panel stands on its own.
   */
  terminal?: boolean;
  /**
   * Host runs a language server for the preview's code (`lspHover`,
   * `lspDefinition`, `lspReferences`, `lspDiagnostics`), so a file opened in the
   * browser host can be hovered and jumped through like an editor. A browser
   * cannot spawn a server; VS Code already has its own LSP and leaves this off.
   */
  lsp?: boolean;
  /**
   * Host can read and write the frontend's shell layout (`readWorkbench` /
   * `saveWorkbench`), so the tabs and terminal a reader had open come back on
   * the next visit. The browser host keeps it under `~/.morse`; the VS Code
   * extension under its per-workspace storage, so a reopened window restores the
   * session that was in front instead of starting empty.
   */
  workbench?: boolean;
  /**
   * Host can raise a notification of its own (`notify`), so the frontend can say
   * a run finished while the reader was elsewhere. VS Code turns it on (its
   * webview has no Web Notifications); the browser host leaves it off and uses
   * the `Notification` API instead.
   */
  notify?: boolean;
  /**
   * Host can read and write pi's prompt-template files (`promptTemplates`,
   * `promptTemplateSave`, `promptTemplateDelete`), so the frontend can offer the
   * template editor. Both hosts have a filesystem; a host that cannot reach the
   * agent directory leaves it off and the editor stays hidden.
   */
  promptEditor?: boolean;
  /**
   * Host can show one session in an editor tab of its own (`openSessionTab`)
   * and drop it again (`closeSessionTab`), so a VS Code window can hold a whole
   * conversation beside the sidebar panel instead of only inside it. Optional:
   * a host with no editor surface (the browser host) leaves it off and the
   * sidebar's session menu keeps its two entries.
   */
  sessionTabs?: boolean;
}

/**
 * The frontend's persisted shell layout: which tabs are open and in front, the
 * bottom panel's state and its terminals. The frontend owns the inner schema
 * (it is the only thing that reads it back), so the host stores the blob
 * verbatim and a frontend can add a field without a protocol change. `version`
 * lets a frontend ignore a layout it can no longer read instead of misreading it.
 */

export interface WorkbenchSnapshot {
  version: number;
  /** The frontend's own shape; opaque to the host. */
  data: unknown;
}

/**
 * One commit of the browser host's git panel. The panel draws both the history
 * list and the lane graph from this shape: `parents` gives the graph its edges,
 * and `refs` the branch and tag chips.
 */
