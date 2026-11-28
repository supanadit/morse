import type {
  AgentEvent,
  AgentSessionState,
  ModelRef,
  TokenUsage,
  ToolResultDetails,
} from '@morse/agent';
import { safeStringify, truncate } from '@morse/system';
import { asNumber, asRecord, asString } from './guards.js';
import type { OpenCodeEvent } from './event-stream.js';
import {
  toFormRequest,
  toPermissionRequest,
  toQuestionRequest,
  type ApiForm,
  type ApiPermissionRequest,
  type ApiQuestion,
} from './form-mapping.js';
import { childSessionOf, childSessionFromText } from './child-session.js';

/**
 * OpenCode session events → the harness contract's events.
 *
 * The installed server (2.1.4) names events `session.text.delta`,
 * `session.tool.success`, `session.execution.succeeded`, …; some builds and the
 * pre-release SDK use a `session.next.*` prefix and a `properties` payload. Both
 * are normalized here so the rest of the adapter never sees a version difference.
 *
 * A mapper is stateful because a transcript is: deltas accumulate into one
 * assistant message per step, a tool's name arrives before its input, and a run
 * ends exactly once even if the server repeats the ending. One instance per
 * session owns that state; `map()` returns the events to emit plus the
 * `AgentSessionState` patch the caller merges (usage, streaming).
 *
 * Unknown event types are ignored — the server's bookkeeping (`session.inbox.*`,
 * `session.instructions.updated`, `project.updated`, `shell.*`) is not transcript
 * content. Tests keep a recorded fixture of every type so a silent miss fails
 * there rather than in a conversation.
 */

/** What one OpenCode event produced. Mirrors `@morse/integration-pi`'s shape. */
export interface MappedRecord {
  events: AgentEvent[];
  state?: Partial<AgentSessionState>;
}

/** One step's accumulated assistant content, until the step finishes streaming. */
interface PendingMessage {
  text: string;
  thinking: string;
}

export class OpenCodeEventMapper {
  /** Whether a run is in flight, so a settled/failed event ends it only once. */
  private running = false;
  /**
   * Whether the current run's failure was already reported: OpenCode emits
   * `session.step.failed` for the step and `session.execution.failed` for the
   * run around it, both carrying the same provider error.
   */
  private failureReported = false;
  /** The step being accumulated, keyed by the assistant message the server named. */
  private pending: PendingMessage | undefined;
  /** Tool ids → the name their input.started announced (`session.tool.called` omits it). */
  private readonly toolNames = new Map<string, string>();
  /** Tool ids whose transcript row was actually started. */
  private readonly startedTools = new Set<string>();
  /**
   * 1.x streaming has no per-delta kind: `message.part.delta` carries only
   * the field name, so the part's kind comes from its last full snapshot
   * (`message.part.updated`). Unknown parts read as text rather than vanish.
   */
  private readonly partKinds = new Map<string, 'text' | 'thinking'>();

  get streaming(): boolean {
    return this.running;
  }

  /**
   * Attached mid-run: the start event was missed, so the mapper must still let
   * the end close the run (see `sessionBusy`).
   */
  resume(): void {
    this.running = true;
  }

  map(event: OpenCodeEvent): MappedRecord {
    const type = normalizeType(event.type);
    const data = event.data;
    const at = event.created;
    switch (type) {
      case 'session.execution.started':
        // A retried execution can announce another start for the same turn.
        if (this.running) {
          return { events: [] };
        }
        this.running = true;
        this.failureReported = false;
        return {
          events: [{ type: 'agent/run-start', at }],
          state: { streaming: true },
        };

      case 'session.text.delta': {
        const delta = asString(data['delta']);
        if (delta === undefined || delta.length === 0) {
          return { events: [] };
        }
        this.appendText('text', delta);
        return {
          events: [{ type: 'agent/delta', at, channel: 'text', delta }],
        };
      }

      case 'session.reasoning.delta': {
        const delta = asString(data['delta']);
        if (delta === undefined || delta.length === 0) {
          return { events: [] };
        }
        this.appendText('thinking', delta);
        return {
          events: [{ type: 'agent/delta', at, channel: 'thinking', delta }],
        };
      }

      case 'session.text.ended':
      case 'session.reasoning.ended':
        // Deltas are the streaming source; the ending event repeats what they
        // already delivered, and the step's flush closes the message.
        return { events: [] };

      case 'session.step.streamed':
        return this.flushMessage(at);

      case 'session.step.ended': {
        // A step that never announced `streamed` (a short answer) still closes
        // its message here; its per-step usage is the footer's "last message".
        const flushed = this.flushMessage(at);
        const lastUsage = toTokenUsage(data['tokens']);
        return lastUsage === undefined ? flushed : { ...flushed, state: { lastUsage } };
      }

      case 'session.step.started': {
        // The server resolves what will actually serve this turn here — the one
        // moment the model is known. Everything before it is a guess: the
        // draft's `/model/default` answer and a config's agent pin can both miss
        // (a model the server cannot resolve falls back silently), so the state
        // follows what really started.
        const model = stepModel(data['model']);
        if (model === undefined) {
          return { events: [] };
        }
        const agent = asString(data['agent']);
        return {
          events: [],
          state: {
            model,
            ...(agent === undefined ? {} : { mode: agent }),
          },
        };
      }

      case 'session.tool.input.started':
      case 'session.tool.input.ended': {
        const id = asString(data['id']);
        const name = asString(data['name']);
        if (id !== undefined && name !== undefined) {
          this.toolNames.set(id, name);
        }
        return { events: [] };
      }

      case 'session.tool.called':
        return this.startTool(data, at);

      case 'session.tool.progress': {
        const id = asString(data['id']);
        if (id === undefined || !this.startedTools.has(id)) {
          return { events: [] };
        }
        const output = toolOutput(data);
        // A child session often announces itself with the first progress report
        // rather than the call, so the link is retried here and on the end.
        const child =
          childSessionOf(this.toolNames.get(id) ?? '', data['metadata']) ??
          childSessionFromText(output);
        return {
          events: [
            {
              type: 'agent/tool-update',
              at,
              toolCallId: id,
              ...(output === undefined ? {} : { output }),
              ...(child === undefined ? {} : { childSession: child }),
              status: 'running',
            },
          ],
        };
      }

      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = asString(data['id']);
        if (id === undefined) {
          return { events: [] };
        }
        // A result without a start would lose the row: synthesize the start from
        // the name input.started announced, so nothing silently disappears.
        const events: AgentEvent[] = [];
        if (!this.startedTools.has(id)) {
          const started = this.startTool(data, at, true);
          events.push(...started.events);
        }
        const status = type === 'session.tool.success' ? 'ok' : 'error';
        const details = asDetails(data['metadata']);
        const output = toolOutput(data) ?? asString(data['error']);
        const child =
          childSessionOf(this.toolNames.get(id) ?? '', data['metadata']) ??
          childSessionFromText(output);
        events.push({
          type: 'agent/tool-end',
          at,
          toolCallId: id,
          status,
          ...(output === undefined ? {} : { output }),
          ...(details === undefined ? {} : { details }),
          ...(child === undefined ? {} : { childSession: child }),
        });
        this.startedTools.delete(id);
        this.toolNames.delete(id);
        return { events };
      }

      case 'session.execution.succeeded':
        return this.endRun('settled', at);

      case 'session.execution.interrupted':
      case 'session.execution.cancelled':
      case 'session.execution.aborted':
        return this.endRun('aborted', at);

      case 'session.step.failed': {
        // A step failure is reported now, because the user is watching the turn
        // stall; the execution-level failure that follows repeats the same error,
        // so it must not become a second row.
        const failure = asFailure(data['error']);
        if (failure === undefined || failure.type === 'aborted' || this.failureReported) {
          return { events: [] };
        }
        this.failureReported = true;
        return {
          events: [
            {
              type: 'agent/notice',
              at,
              level: 'error',
              text: `The run failed: ${failure.message}`,
            },
          ],
        };
      }

      case 'session.execution.failed': {
        const ended = this.endRun('error', at);
        const failure = asFailure(data['error'] ?? data['message']);
        if (failure !== undefined && failure.type !== 'aborted' && !this.failureReported) {
          this.failureReported = true;
          ended.events.push({
            type: 'agent/notice',
            at,
            level: 'error',
            text: `The run failed: ${failure.message}`,
          });
        }
        return ended;
      }

      case 'form.created': {
        const form = asRecord(data['form']);
        // An OpenCode build can send a form shell with no `fields` array or no
        // id. There is nothing a reader could answer, and mapping it crashed
        // the host; treat it as no interaction rather than a dialog nobody
        // can fill. `toFormRequest` itself never throws either, so a weird
        // field shape can still only become an empty form, never a restart.
        if (
          form === undefined ||
          typeof form['id'] !== 'string' ||
          !Array.isArray(form['fields'])
        ) {
          return { events: [] };
        }
        const request = toFormRequest(form as unknown as ApiForm);
        if (request.fields.length === 0) {
          return { events: [] };
        }
        return {
          events: [
            {
              type: 'agent/interaction',
              at,
              request: toFormRequest(form as unknown as ApiForm),
            },
          ],
        };
      }

      case 'permission.asked':
        return {
          events: [
            {
              type: 'agent/interaction',
              at,
              request: toPermissionRequest(data as unknown as ApiPermissionRequest),
            },
          ],
        };

      case 'form.replied':
      case 'form.cancelled':
      case 'question.replied':
      case 'question.rejected':
      case 'permission.replied':
        // Settled elsewhere (another client, the TUI); the agent uses these only
        // to release its pending map, so there is no transcript event.
        return { events: [] };

      case 'question.asked': {
        // 1.x asks with fixed-option questions instead of typed forms. The
        // mapper skips shells with nothing answerable rather than crash the
        // host on a dialog nobody can fill (see `form.created`).
        const request = toQuestionRequest(data as unknown as ApiQuestion);
        if (request === undefined) {
          return { events: [] };
        }
        return {
          events: [{ type: 'agent/interaction', at, request }],
        };
      }

      case 'message.part.delta': {
        // 1.x streams text and thinking through one delta shape; the kind is
        // whatever the part's last snapshot said it was.
        const delta = asString(data['delta']);
        if (delta === undefined || delta.length === 0) {
          return { events: [] };
        }
        const channel = this.partKinds.get(asString(data['partID']) ?? '') ?? 'text';
        const started = this.startRun(at);
        this.appendText(channel, delta);
        return {
          events: [...started.events, { type: 'agent/delta', at, channel, delta }],
          ...(started.state === undefined ? {} : { state: started.state }),
        };
      }

      case 'message.part.updated':
        return this.mapV1Part(data, at);

      case 'message.updated': {
        // 1.x closes an assistant message with `time.completed`; that is the
        // turn's end the same way `session.execution.*` is on 2.x.
        const info = asRecord(data['info']);
        if (info?.['role'] !== 'assistant' || asRecord(info['time'])?.['completed'] === undefined) {
          return { events: [] };
        }
        const flushed = this.flushMessage(at);
        const ended = this.endRun(asRecord(info['error']) === undefined ? 'settled' : 'error', at);
        // 1.x names the model `modelID`; 2.x names it `id`. Read both.
        const modelRecord = asRecord(info['model']);
        const modelId = asString(modelRecord?.['id']) ?? asString(modelRecord?.['modelID']);
        const provider = asString(modelRecord?.['providerID']);
        const model = modelId === undefined || provider === undefined
          ? undefined
          : { provider, id: modelId, name: modelId };
        const agent = asString(info['agent']);
        const state = {
          ...(ended.state ?? {}),
          ...(model === undefined ? {} : { model }),
          ...(agent === undefined ? {} : { mode: agent }),
        };
        return {
          events: [...flushed.events, ...ended.events],
          ...(Object.keys(state).length === 0 ? {} : { state }),
        };
      }

      case 'session.error': {
        const ended = this.endRun('error', at);
        // 1.x nests the message (`{name, data: {message}}`); 2.x carries it
        // flat (`{type, message}`). Read through either shape.
        const raw = data['error'] ?? data['message'];
        const failure = asFailure(raw) ?? asFailure(asRecord(raw)?.['data']);
        if (failure === undefined || failure.type === 'aborted' || this.failureReported) {
          return ended;
        }
        this.failureReported = true;
        return {
          events: [
            ...ended.events,
            {
              type: 'agent/notice',
              at,
              level: 'error',
              text: `The run failed: ${failure.message}`,
            },
          ],
          ...(ended.state === undefined ? {} : { state: ended.state }),
        };
      }

      case 'session.retried':
      case 'session.retry.scheduled': {
        // Installed servers send `retry.scheduled` with a structured error
        // (`{type, message}`); the pre-release SDK used `retried` with a `reason`
        // string. Both mean the same thing to a reader.
        const failure = asFailure(data['error']);
        const reason = failure?.message ?? asString(data['reason']) ?? asString(data['message']);
        const attempt = asNumber(data['attempt']);
        const suffix = attempt === undefined ? '' : ` (attempt ${attempt})`;
        return {
          events: [
            {
              type: 'agent/notice',
              at,
              level: 'warn',
              text: `OpenCode is retrying the request${suffix}${reason === undefined ? '.' : `: ${reason}`}`,
            },
          ],
        };
      }

      case 'session.compaction.ended': {
        const summary = asString(data['text']) ?? asString(data['summary']);
        if (summary === undefined || summary.length === 0) {
          return { events: [] };
        }
        const tokensBefore = asNumber(asRecord(data['tokens'])?.['input']);
        return {
          events: [
            {
              type: 'agent/compaction',
              at,
              summary,
              ...(tokensBefore === undefined ? {} : { tokensBefore }),
            },
          ],
        };
      }

      case 'session.usage.updated': {
        const usage = toTokenUsage(data['tokens']);
        const cost = asNumber(data['cost']);
        return {
          events: [],
          state: {
            ...(usage === undefined ? {} : { usage }),
            ...(cost === undefined ? {} : { costUsd: cost }),
          },
        };
      }

      case 'stream.fatal':
        return {
          events: [
            {
              type: 'agent/fatal',
              at,
              message: asString(data['message']) ?? 'The OpenCode event stream is unavailable.',
            },
          ],
        };

      // `stream.connected` is a reconnection notice the agent acts on (it
      // re-reads its state); it is not transcript content.
      case 'stream.connected':
        return { events: [] };

      default:
        return { events: [] };
    }
  }

  /**
   * Opens the run at most once: a retried start for the same turn is not a
   * second run. Returns the run-start event (if any) for the caller to emit.
   */
  private startRun(at: number): MappedRecord {
    if (this.running) {
      return { events: [] };
    }
    this.running = true;
    this.failureReported = false;
    return { events: [{ type: 'agent/run-start', at }], state: { streaming: true } };
  }

  /**
   * One 1.x part snapshot: run framing (`step-start`/`step-finish`), tool
   * rows by state, and the kind memory deltas read. Text snapshots are not
   * transcript content — the deltas already delivered them.
   */
  private mapV1Part(data: Record<string, unknown>, at: number): MappedRecord {
    const part = asRecord(data['part']);
    if (part === undefined || typeof part['type'] !== 'string') {
      return { events: [] };
    }
    switch (part['type']) {
      case 'step-start':
        return this.startRun(at);
      case 'step-finish': {
        const flushed = this.flushMessage(at);
        const lastUsage = toTokenUsage(asRecord(part['tokens']));
        const reason = asString(part['reason']);
        const ended = this.endRun(reason === 'aborted' ? 'aborted' : 'settled', at);
        return {
          events: [...flushed.events, ...ended.events],
          state: { ...(ended.state ?? {}), ...(lastUsage === undefined ? {} : { lastUsage }) },
        };
      }
      case 'text':
      case 'reasoning': {
        const id = asString(part['id']);
        if (id !== undefined) {
          this.partKinds.set(id, part['type'] === 'reasoning' ? 'thinking' : 'text');
        }
        // A live part snapshot means a run is producing it (a resumed
        // session replays history, not events, so this cannot be stale).
        return this.startRun(at);
      }
      case 'tool':
        return this.mapV1Tool(part, at);
      default:
        return { events: [] };
    }
  }

  /** One 1.x tool part snapshot, through the same rows 2.x tool events use. */
  private mapV1Tool(part: Record<string, unknown>, at: number): MappedRecord {
    const id = asString(part['callID']);
    const name = asString(part['tool']) ?? 'tool';
    if (id === undefined) {
      return { events: [] };
    }
    const state = asRecord(part['state']);
    const status = state?.['status'];
    const input = asRecord(state?.['input']);
    if (status === 'pending' || status === 'running') {
      const started = this.startTool({ ...part, id, name, input }, at);
      if (status !== 'running' || !this.startedTools.has(id)) {
        return started;
      }
      const output = typeof state?.['output'] === 'string' ? (state?.['output'] as string) : undefined;
      return {
        events: [
          { type: 'agent/tool-update', at, toolCallId: id, ...(output === undefined ? {} : { output }), status: 'running' },
        ],
      };
    }
    // `completed`/`error`: the row without one is synthesized first, exactly
    // like a 2.x result that arrived with no `called`.
    const output =
      typeof state?.['output'] === 'string'
        ? (state?.['output'] as string)
        : typeof state?.['error'] === 'string'
          ? (state?.['error'] as string)
          : undefined;
    const events: AgentEvent[] = [];
    if (!this.startedTools.has(id)) {
      const started = this.startTool({ ...part, id, name, input }, at, true);
      events.push(...started.events);
    }
    events.push({
      type: 'agent/tool-end',
      at,
      toolCallId: id,
      status: status === 'completed' ? 'ok' : 'error',
      ...(output === undefined ? {} : { output }),
      ...(asRecord(state?.['metadata']) === undefined ? {} : { details: asRecord(state?.['metadata']) as ToolResultDetails }),
    });
    this.startedTools.delete(id);
    this.toolNames.delete(id);
    return { events };
  }

  /** Folds a delta into the step being accumulated (flushed by the step's end). */
  private appendText(channel: 'text' | 'thinking', delta: string): void {
    this.pending ??= { text: '', thinking: '' };
    this.pending[channel] += delta;
  }

  /** Emits the accumulated assistant message, if any, and resets the step. */
  private flushMessage(at: number): MappedRecord {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined || (pending.text.length === 0 && pending.thinking.length === 0)) {
      return { events: [] };
    }
    return {
      events: [
        {
          type: 'agent/message',
          at,
          text: pending.text,
          thinking: pending.thinking,
        },
      ],
    };
  }

  /**
   * Starts a tool's transcript row when its input is known (OpenCode separates
   * "input streaming" from "called"; the row is useful only once there is an
   * input to show), deriving a title from the arguments like pi's adapter does.
   */
  private startTool(data: Record<string, unknown>, at: number, force = false): MappedRecord {
    const id = asString(data['id']);
    if (id === undefined || this.startedTools.has(id)) {
      return { events: [] };
    }
    const remembered = this.toolNames.get(id);
    const name = asString(data['name']) ?? remembered ?? 'tool';
    this.toolNames.set(id, name);
    // `input.started`/`input.ended` announce the tool before `called` carries it.
    // A result (`force`) still gets a row when no `called` ever arrived.
    const input = asRecord(data['input']);
    if (input === undefined && !force) {
      return { events: [] };
    }
    this.startedTools.add(id);
    const serialized = safeStringify(input);
    const child = childSessionOf(name, data['metadata']) ?? childSessionOf(name, input);
    return {
      events: [
        {
          type: 'agent/tool-start',
          at,
          toolCallId: id,
          name,
          title: describeToolCall(name, input),
          ...(serialized === undefined ? {} : { input: serialized }),
          ...(child === undefined ? {} : { childSession: child }),
        },
      ],
    };
  }

  /** Ends the run at most once: a repeat of an ended turn is not a second end. */
  private endRun(reason: 'settled' | 'aborted' | 'error', at: number): MappedRecord {
    if (!this.running) {
      return { events: [] };
    }
    this.running = false;
    const pending = this.pending;
    this.pending = undefined;
    const events: AgentEvent[] = [];
    // A step whose deltas never got a `step.streamed` (a short answer, a dropped
    // frame) still becomes a message row rather than vanishing.
    if (pending !== undefined && (pending.text.length > 0 || pending.thinking.length > 0)) {
      events.push({
        type: 'agent/message',
        at,
        text: pending.text,
        thinking: pending.thinking,
      });
    }
    events.push({ type: 'agent/run-end', at, reason });
    return { events, state: { streaming: false } };
  }
}

/** The type without OpenCode's `session.next.` variant prefix. */
export function normalizeType(type: string): string {
  return type.replace(/^session\.next\./, 'session.');
}

/**
 * What a session's own event says about whether it is running: a start or a
 * busy status is `true`, an execution end or an idle report is `false`, and
 * anything else says nothing. A spawned child's events are read through this
 * (see `OpenCodeAgent.watchChild`), since OpenCode's subagents run on after
 * the `task` call that spawned them has returned.
 */
export function childRunningOf(
  type: string,
  data: Record<string, unknown>,
): boolean | undefined {
  switch (normalizeType(type)) {
    case 'session.execution.started':
      return true;
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
    case 'session.execution.cancelled':
    case 'session.execution.aborted':
    case 'session.idle':
      return false;
    case 'session.status': {
      const status = asString(asRecord(data['status'])?.['type']);
      return status === 'busy' ? true : status === 'idle' ? false : undefined;
    }
    default:
      return undefined;
  }
}

/** The tool result's text, from `content: [{type:'text',text}]` or a direct field. */
function toolOutput(data: Record<string, unknown>): string | undefined {
  const content = data['content'];
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part !== null && typeof part === 'object'
          ? asString((part as Record<string, unknown>)['text'])
          : undefined,
      )
      .filter((part): part is string => part !== undefined)
      .join('');
    if (text.length > 0) {
      return text;
    }
  }
  return asString(data['output']) ?? asString(data['text']);
}

/** The structured result a tool returned, when it is an object. */
function asDetails(value: unknown): ToolResultDetails | undefined {
  const record = asRecord(value);
  return record as ToolResultDetails | undefined;
}

/** OpenCode's `{input,output,reasoning,cache:{read,write}}` → the contract's usage. */
export function toTokenUsage(value: unknown): TokenUsage | undefined {
  const tokens = asRecord(value);
  if (tokens === undefined) {
    return undefined;
  }
  const input = asNumber(tokens['input']) ?? 0;
  const output = asNumber(tokens['output']) ?? 0;
  const cache = asRecord(tokens['cache']);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(asNumber(cache?.['read']) === undefined
      ? {}
      : { cacheReadTokens: asNumber(cache?.['read']) }),
    ...(asNumber(cache?.['write']) === undefined
      ? {}
      : { cacheWriteTokens: asNumber(cache?.['write']) }),
    ...(asNumber(tokens['reasoning']) === undefined
      ? {}
      : { reasoningTokens: asNumber(tokens['reasoning']) }),
  };
}

/** A title a reader can recognize, derived from the tool's own arguments. */
export function describeToolCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  if (args === undefined) {
    return toolName;
  }
  const command = asString(args['command']) ?? asString(args['cmd']);
  if (command !== undefined) {
    return `${toolName}: ${truncate(command, 100)}`;
  }
  const path =
    asString(args['path']) ??
    asString(args['file_path']) ??
    asString(args['filePath']) ??
    asString(args['file']) ??
    asString(args['target']);
  if (path !== undefined) {
    return `${toolName}: ${truncate(path, 100)}`;
  }
  const pattern = asString(args['pattern']) ?? asString(args['query']);
  if (pattern !== undefined) {
    return `${toolName}: ${truncate(pattern, 100)}`;
  }
  return toolName;
}

/** A readable failure from OpenCode's structured error, or an older string payload. */
interface EngineFailure {
  message: string;
  /** OpenCode's taxonomy tag (`provider.free-limit`, `provider.auth`, …). */
  type?: string;
}

/**
 * OpenCode reports failures as `{ type, message, status?, response? }`; some
 * events and older builds used a bare string. Both must reach the transcript:
 * a provider that refused the request for credits is exactly the thing a reader
 * needs to see, and `asString()` alone silently dropped it.
 */
/** The step payload's `model: { id, providerID }`, as a wire model ref. */
function stepModel(value: unknown): ModelRef | undefined {
  const record = asRecord(value);
  const id = record === undefined ? undefined : asString(record['id']);
  const providerID = record === undefined ? undefined : asString(record['providerID']);
  return id === undefined || providerID === undefined
    ? undefined
    : { provider: providerID, id, name: id };
}

function asFailure(value: unknown): EngineFailure | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? { message: value } : undefined;
  }
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const message = asString(record['message']);
  const type = asString(record['type']);
  if (message !== undefined && message.length > 0) {
    return { message, ...(type === undefined ? {} : { type }) };
  }
  // A bare tag is still more useful than saying nothing.
  return type !== undefined && type.length > 0 ? { message: type, type } : undefined;
}
