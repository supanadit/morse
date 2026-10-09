import {
  createInitialView,
  PROTOCOL_VERSION,
  reduceConnection,
  reduceSessionView,
  type ChatPin,
  type ClientToHostMessage,
  type ComposerSeed,
  type FrontendIdentity,
  type HostCommand,
  type InteractionResponse,
  type PromptImage,
  type PromptMode,
  type SessionView,
  type ThinkingLevel,
  type WorkspaceInfo,
} from '@morse/protocol';
import type { ConnectionStatus } from '@morse/protocol';
import type { HostTransport, TransportStatus } from './transport/host-transport.js';

export interface MorseActions {
  ready(frontend?: FrontendIdentity): void;
  prompt(
    text: string,
    mode?: PromptMode,
    images?: PromptImage[],
    pins?: ChatPin[],
    /** Target a live session other than the active one (a queued follow-up). */
    sessionKey?: string,
  ): void;
  /**
   * Replaces a past user message: the host forks the conversation before it and
   * sends the edited text. The transcript after that turn is discarded.
   */
  editMessage(itemId: string, text: string): void;
  /**
   * Branches a new session before a past user message: the host forks the
   * conversation (leaving the old branch resumable), truncates the transcript
   * and seeds the composer with the forked prompt. Nothing is sent.
   */
  forkMessage(itemId: string): void;
  /** Runs a host command and resolves with its value, when the host supports it. */
  hostCommand(
    command: HostCommand,
    args?: Record<string, unknown>,
    /** Override the answer timeout for a slow command (a network pull/push). */
    timeoutMs?: number,
  ): Promise<unknown>;
  abort(): void;
  newSession(cwd?: string): void;
  loadSession(sessionId: string, cwd?: string): void;
  activateSession(sessionId: string, cwd?: string): void;
  closeSession(sessionId: string): void;
  /**
   * Deletes a session and its stored conversation for good. Closing retires the
   * agent process only; this removes the session file.
   */
  deleteSession(sessionId: string): void;
  /**
   * Summarizes the context of one session. `sessionKey` pins it to the conversation
   * the ask belonged to, so a dialog opened over session A cannot compact whichever
   * session happens to be in front when the user says yes; omitted, it targets the
   * session in front, the shared panel's behaviour.
   */
  compactSession(instructions?: string, sessionKey?: string): void;
  /** Fetches the previous page of a resumed session's history. */
  loadOlderHistory(): void;
  requestSessions(): void;
  requestProjects(): void;
  /** Re-reads the prompt templates and other commands the palette lists. */
  refreshCommands(): void;
  /** Re-reads the model catalog so a model added while the host runs is visible. */
  refreshModels(): void;
  openProject(path: string): void;
  setModel(provider: string, id: string): void;
  setThinkingLevel(level: ThinkingLevel): void;
  respond(response: InteractionResponse): void;
  /** Starts a shell for the bottom panel's terminal, streamed as it writes. */
  openTerminal(terminalId: string, options?: { cwd?: string; cols?: number; rows?: number }): void;
  /** Writes keystrokes (or a whole pasted line) to a running terminal. */
  sendTerminal(terminalId: string, data: string): void;
  /** Tells the host's shell the viewer's new size. */
  resizeTerminal(terminalId: string, cols: number, rows: number): void;
  /** Closes a terminal and kills its shell. */
  closeTerminal(terminalId: string): void;
}

/**
 * The framework-agnostic Morse client. Angular, React and Svelte bindings all
 * wrap exactly this object — the reducer and the wire protocol live here, not in
 * the components.
 */
export interface MorseClient {
  getView(): SessionView;
  subscribe(listener: (view: SessionView) => void): () => void;
  /**
   * Editor selections the host pinned (the title-bar attach command). The
   * frontend turns them into attachment chips; the prompt text never gains a
   * context preamble behind the user's back.
   */
  onContextSelection(listener: (pin: { path: string; startLine?: number; endLine?: number }) => void): () => void;
  /**
   * Live, unlocked previews of the editor's current state, streamed as the
   * user moves. The frontend shows one chip until it is clicked to lock (into a
   * pin) — a selection reads as `Lstart-end`, and the focused file with nothing
   * selected reads as a whole-file chip with no line number.
   */
  onContextSelectionLive(listener: (preview: { path: string; startLine?: number; endLine?: number }) => void): () => void;
  /**
   * A prompt handed back by the host after a fork (`composer/seed`). The
   * composer drops it into the editor so the user continues the new branch;
   * the old session is left untouched and stays resumable.
   */
  onComposerSeed(listener: (seed: ComposerSeed) => void): () => void;
  /** Bytes a terminal's shell wrote, as they arrive. */
  onTerminalOutput(listener: (event: { terminalId: string; data: string }) => void): () => void;
  /** A terminal's shell ended (or never started). */
  onTerminalExit(
    listener: (event: { terminalId: string; code?: number; error?: string }) => void,
  ): () => void;
  /**
   * A watched `mcp.json` changed on disk (`cwd` is `''` for the user-level
   * file). The MCP store re-reads the affected directory; nothing in the view
   * state changes, so this is a side channel like a terminal stream.
   */
  onMcpChanged(listener: (event: { cwd: string }) => void): () => void;
  readonly actions: MorseActions;
  dispose(): void;
}

export interface MorseClientOptions {
  transport: HostTransport;
  workspace?: WorkspaceInfo;
  frontend?: FrontendIdentity;
}

/** A host that never answers must not leave the UI waiting forever. */
const HOST_COMMAND_TIMEOUT_MS = 5_000;

export function createMorseClient(options: MorseClientOptions): MorseClient {
  let view = createInitialView(options.workspace ?? { cwd: '', name: 'workspace' });
  const listeners = new Set<(view: SessionView) => void>();

  const publish = (next: SessionView): void => {
    view = next;
    for (const listener of [...listeners]) {
      listener(view);
    }
  };

  const send = (message: ClientToHostMessage): void => {
    options.transport.send(message);
  };

  /**
   * Pending `hostCommand` calls, keyed by the id we sent. A host that does not
   * answer (older bundle, unsupported command) resolves as undefined when the
   * timeout fires, so a caller can fall back instead of hanging.
   */
  const hostRequests = new Map<
    string,
    { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let hostRequestCounter = 0;

  /** Listeners for host-pinned editor selections (`context/selection`). */
  const selectionListeners = new Set<
    (pin: { path: string; startLine?: number; endLine?: number }) => void
  >();
  /** Listeners for live selection previews (`context/selectionLive`). */
  const liveSelectionListeners = new Set<
    (pin: { path: string; startLine?: number; endLine?: number }) => void
  >();
  /** Listeners for a forked prompt handed back to the composer (`composer/seed`). */
  const composerSeedListeners = new Set<(seed: ComposerSeed) => void>();
  /** Listeners for terminal output (`terminal/output`). */
  const terminalOutputListeners = new Set<(event: { terminalId: string; data: string }) => void>();
  /** Listeners for a terminal ending (`terminal/exit`). */
  const terminalExitListeners = new Set<
    (event: { terminalId: string; code?: number; error?: string }) => void
  >();
  /** Listeners for a watched `mcp.json` changing (`mcp/changed`). */
  const mcpChangedListeners = new Set<(event: { cwd: string }) => void>();

  const requestHostCommand = (
    command: HostCommand,
    args: Record<string, unknown> | undefined,
    timeoutMs = HOST_COMMAND_TIMEOUT_MS,
  ): Promise<unknown> => {
    hostRequestCounter += 1;
    const requestId = `host-${hostRequestCounter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        hostRequests.delete(requestId);
        resolve(undefined);
      }, timeoutMs);
      hostRequests.set(requestId, { resolve, timer });
      send({ type: 'host/command', payload: { command, args, requestId } });
    });
  };

  const unsubscribeMessage = options.transport.onMessage((message) => {
    if (message.type === 'host/command/result') {
      const pending = hostRequests.get(message.payload.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        hostRequests.delete(message.payload.requestId);
        pending.resolve(message.payload.ok ? message.payload.data : undefined);
      }
      return;
    }
    if (message.type === 'context/selection') {
      for (const listener of [...selectionListeners]) {
        listener(message.payload);
      }
      return;
    }
    if (message.type === 'context/selectionLive') {
      for (const listener of [...liveSelectionListeners]) {
        listener(message.payload);
      }
      return;
    }
    if (message.type === 'composer/seed') {
      for (const listener of [...composerSeedListeners]) {
        listener(message.payload);
      }
      return;
    }
    if (message.type === 'terminal/output') {
      for (const listener of [...terminalOutputListeners]) {
        listener(message.payload);
      }
      return;
    }
    if (message.type === 'terminal/exit') {
      for (const listener of [...terminalExitListeners]) {
        listener(message.payload);
      }
      return;
    }
    if (message.type === 'mcp/changed') {
      for (const listener of [...mcpChangedListeners]) {
        listener(message.payload);
      }
      return;
    }
    publish(reduceSessionView(view, message));
  });

  const unsubscribeStatus = options.transport.onStatus((status, detail) => {
    // A transport that is open is not yet a host that answered: `connection`
    // turns 'ready' when `host/ready` arrives (see reduceSessionView), so the UI
    // never mistakes "socket open, handshake in flight" for "host unavailable".
    publish(
      reduceConnection(
        view,
        toConnectionStatus(status),
        status === 'open' ? 'Waiting for the Morse host to answer…' : detail,
      ),
    );
  });

  const actions: MorseActions = {
    ready: (frontend) =>
      send({
        type: 'client/ready',
        payload: { protocolVersion: PROTOCOL_VERSION, frontend: frontend ?? options.frontend },
      }),
    prompt: (text, mode, images, pins, sessionKey) =>
      send({ type: 'chat/prompt', payload: { text, mode, images, pins, sessionKey } }),
    editMessage: (itemId, text) => send({ type: 'chat/edit', payload: { itemId, text } }),
    forkMessage: (itemId) => send({ type: 'chat/fork', payload: { itemId } }),
    hostCommand: (command, args, timeoutMs) => requestHostCommand(command, args, timeoutMs),
    abort: () => send({ type: 'chat/abort', payload: {} }),
    newSession: (cwd) => send({ type: 'session/new', payload: { cwd } }),
    loadSession: (sessionId, cwd) => send({ type: 'session/load', payload: { sessionId, cwd } }),
    activateSession: (sessionId, cwd) =>
      send({ type: 'session/activate', payload: { sessionId, cwd } }),
    closeSession: (sessionId) => send({ type: 'session/close', payload: { sessionId } }),
    deleteSession: (sessionId) => send({ type: 'session/delete', payload: { sessionId } }),
    compactSession: (instructions, sessionKey) =>
      send({ type: 'session/compact', payload: { instructions, sessionKey } }),
    loadOlderHistory: () => send({ type: 'history/load', payload: {} }),
    requestSessions: () => send({ type: 'session/list', payload: {} }),
    requestProjects: () => send({ type: 'project/list', payload: {} }),
    refreshCommands: () => send({ type: 'commands/refresh', payload: {} }),
    refreshModels: () => send({ type: 'models/refresh', payload: {} }),
    openProject: (path) => send({ type: 'project/open', payload: { path } }),
    setModel: (provider, id) => send({ type: 'model/set', payload: { provider, id } }),
    setThinkingLevel: (level) => send({ type: 'thinking/set', payload: { level } }),
    respond: (response) => send({ type: 'interaction/respond', payload: response }),
    openTerminal: (terminalId, terminalOptions) =>
      send({ type: 'terminal/open', payload: { terminalId, ...terminalOptions } }),
    sendTerminal: (terminalId, data) =>
      send({ type: 'terminal/input', payload: { terminalId, data } }),
    resizeTerminal: (terminalId, cols, rows) =>
      send({ type: 'terminal/resize', payload: { terminalId, cols, rows } }),
    closeTerminal: (terminalId) => send({ type: 'terminal/close', payload: { terminalId } }),
  };

  options.transport.connect();
  actions.ready();

  return {
    getView: () => view,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onContextSelection: (listener) => {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
    onContextSelectionLive: (listener) => {
      liveSelectionListeners.add(listener);
      return () => {
        liveSelectionListeners.delete(listener);
      };
    },
    onComposerSeed: (listener) => {
      composerSeedListeners.add(listener);
      return () => {
        composerSeedListeners.delete(listener);
      };
    },
    onTerminalOutput: (listener) => {
      terminalOutputListeners.add(listener);
      return () => {
        terminalOutputListeners.delete(listener);
      };
    },
    onTerminalExit: (listener) => {
      terminalExitListeners.add(listener);
      return () => {
        terminalExitListeners.delete(listener);
      };
    },
    onMcpChanged: (listener) => {
      mcpChangedListeners.add(listener);
      return () => {
        mcpChangedListeners.delete(listener);
      };
    },
    actions,
    dispose: () => {
      unsubscribeMessage();
      unsubscribeStatus();
      listeners.clear();
      options.transport.dispose();
    },
  };
}

function toConnectionStatus(status: TransportStatus): ConnectionStatus {
  switch (status) {
    case 'open':
      // Still 'connecting' on purpose: only `host/ready` means ready.
      return 'connecting';
    case 'connecting':
      return 'connecting';
    case 'error':
      return 'error';
    case 'closed':
      return 'closed';
  }
}
