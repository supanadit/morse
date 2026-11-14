import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import type {
  BotMcpServerInput,
  McpExposure,
  McpInspectionResult,
  McpServerInput,
} from '@morse/protocol';
import { McpState } from '../../state/mcp-state';
import { splitMcpArgs } from '../mcp-editor/mcp-editor';

type DraftType = 'stdio' | 'http';

/** One server being built in the form, before it becomes a neutral input. */
interface Draft {
  name: string;
  type: DraftType;
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  /** Not shown: a server read back from a config keeps its directory. */
  cwd: string;
  enabled: boolean;
  exposure: '' | McpExposure;
}

/** A config key: letters, digits, `_` and `-`. */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Object keys the host refuses, since they would be prototype assignments. */
const RESERVED_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

const EXPOSURES: McpExposure[] = ['codemode', 'deferred', 'direct', 'hidden'];

function emptyDraft(): Draft {
  return {
    name: '',
    type: 'stdio',
    command: '',
    argsText: '',
    envText: '',
    url: '',
    headersText: '',
    cwd: '',
    enabled: true,
    exposure: '',
  };
}

/**
 * Parse a textarea of `KEY=value` lines. Blank lines are skipped, a value may
 * itself contain `=` (only the first one splits), and a later duplicate wins.
 */
export function parseEnvText(text: string): { values: Record<string, string>; error?: string } {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const at = line.indexOf('=');
    if (at === -1) {
      return { values, error: 'Each environment variable needs a KEY=value line.' };
    }
    const key = line.slice(0, at).trim();
    if (key.length === 0) {
      return { values, error: 'Each environment variable needs a KEY=value line.' };
    }
    values[key] = line.slice(at + 1).trim();
  }
  return { values };
}

/**
 * Parse a textarea of `Name: value` header lines, with the same rules as env:
 * blanks skipped, the first colon splits, last duplicate wins.
 */
export function parseHeaderText(text: string): { values: Record<string, string>; error?: string } {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const at = line.indexOf(':');
    if (at === -1) {
      return { values, error: 'Each header needs a Name: value line.' };
    }
    const key = line.slice(0, at).trim();
    if (key.length === 0) {
      return { values, error: 'Each header needs a Name: value line.' };
    }
    values[key] = line.slice(at + 1).trim();
  }
  return { values };
}

/** Render a record back into the form's line format. */
function toLineText(values: Record<string, string> | undefined, separator: string): string {
  return Object.entries(values ?? {})
    .map(([key, value]) => `${key}${separator}${value}`)
    .join('\n');
}

/**
 * The wizard's MCP step: the bot's own server list, and a form for one entry.
 *
 * The component is presentational. It owns the draft and the probe, never the
 * list: every change is emitted as a whole array and the wizard decides what to
 * persist. The probe is Morse's own MCP client (the same one the global MCP
 * editor uses), so a bad command or dead URL is discovered before the bot is
 * created — and a failed probe never blocks saving, because a server the host
 * cannot reach from here may still work inside the bot's workspace.
 */
@Component({
  selector: 'morse-bot-mcp-step',
  templateUrl: './bot-mcp-step.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './bot-mcp-step.css',
})
export class BotMcpStep {
  readonly servers = input.required<readonly BotMcpServerInput[]>();
  /** `opencode` has no exposure concept, so the select is not offered to it. */
  readonly engineKind = input.required<string>();
  readonly serversChange = output<BotMcpServerInput[]>();

  private readonly mcp = inject(McpState);

  protected readonly draft = signal<Draft>(emptyDraft());
  /** The name of the server being edited; `null` means the form adds a new one. */
  protected readonly editing = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly testing = signal(false);
  protected readonly probe = signal<McpInspectionResult | undefined>(undefined);

  protected readonly exposures = EXPOSURES;

  protected setName(value: string): void {
    this.update({ name: value });
  }
  protected setType(value: string): void {
    this.update({ type: value === 'http' ? 'http' : 'stdio' });
  }
  protected setCommand(value: string): void {
    this.update({ command: value });
  }
  protected setArgs(value: string): void {
    this.update({ argsText: value });
  }
  protected setEnv(value: string): void {
    this.update({ envText: value });
  }
  protected setUrl(value: string): void {
    this.update({ url: value });
  }
  protected setHeaders(value: string): void {
    this.update({ headersText: value });
  }
  protected setEnabled(value: boolean): void {
    this.update({ enabled: value });
  }
  protected setExposure(value: string): void {
    const match = EXPOSURES.find((entry) => entry === value);
    this.update({ exposure: match ?? '' });
  }

  /** A draft edit invalidates the previous probe: it described other fields. */
  private update(patch: Partial<Draft>): void {
    this.draft.update((draft) => ({ ...draft, ...patch }));
    this.error.set(null);
    this.probe.set(undefined);
  }

  /** The one-line transport summary on a card. */
  protected summary(server: BotMcpServerInput): string {
    if (server.type === 'http') {
      return `http: ${server.url ?? ''}`;
    }
    const args = server.args ?? [];
    return `stdio: ${[server.command ?? '', ...args].join(' ').trim()}`;
  }

  protected edit(server: BotMcpServerInput): void {
    this.editing.set(server.name);
    this.error.set(null);
    this.probe.set(undefined);
    this.draft.set({
      name: server.name,
      type: server.type,
      command: server.command ?? '',
      argsText: (server.args ?? []).join(' '),
      envText: toLineText(server.env, '='),
      url: server.url ?? '',
      headersText: toLineText(server.headers, ': '),
      cwd: server.cwd ?? '',
      enabled: server.enabled !== false,
      exposure: server.exposure ?? '',
    });
  }

  /** Abandon the edit and go back to adding. */
  protected cancel(): void {
    this.reset();
  }

  protected submit(): void {
    if (this.editing() === null) {
      this.add();
    } else {
      this.save();
    }
  }

  protected add(): void {
    const input = this.build();
    if (input === undefined) {
      return;
    }
    this.serversChange.emit([...this.servers(), input]);
    this.reset();
  }

  /** Replace the server the form was opened on, keeping fields it never showed. */
  protected save(): void {
    const original = this.editing();
    if (original === null) {
      this.add();
      return;
    }
    const input = this.build();
    if (input === undefined) {
      return;
    }
    this.serversChange.emit(
      this.servers().map((server) => (server.name === original ? input : server)),
    );
    this.reset();
  }

  protected remove(name: string): void {
    this.serversChange.emit(this.servers().filter((server) => server.name !== name));
    if (this.editing() === name) {
      this.reset();
    }
  }

  protected toggle(server: BotMcpServerInput): void {
    this.serversChange.emit(
      this.servers().map((one) =>
        one.name === server.name ? { ...one, enabled: one.enabled === false } : one,
      ),
    );
  }

  protected async test(): Promise<void> {
    if (this.testing()) {
      return;
    }
    const input = this.probeInput();
    if (input === undefined) {
      return;
    }
    this.testing.set(true);
    this.probe.set(undefined);
    try {
      const result = await this.mcp.inspect(input, '');
      if (result === undefined) {
        this.error.set('The host did not answer the probe.');
      } else {
        this.probe.set(result);
      }
    } finally {
      this.testing.set(false);
    }
  }

  /** Validate the draft and turn it into the neutral input, or say why not. */
  private build(): BotMcpServerInput | undefined {
    const draft = this.draft();
    const name = draft.name.trim();
    if (name.length === 0) {
      this.error.set('Give the server a name.');
      return undefined;
    }
    if (RESERVED_NAMES.has(name)) {
      this.error.set(`"${name}" is reserved — pick another name.`);
      return undefined;
    }
    if (!NAME_PATTERN.test(name)) {
      this.error.set('Use letters, digits, underscores and dashes for the name.');
      return undefined;
    }
    const original = this.editing();
    if (this.servers().some((server) => server.name === name && server.name !== original)) {
      this.error.set(`A server called "${name}" is already on this bot.`);
      return undefined;
    }

    const transport = this.transport(draft);
    if (transport === undefined) {
      return undefined;
    }
    const args = splitMcpArgs(draft.argsText);
    return {
      name,
      type: draft.type,
      ...(draft.type === 'http'
        ? {
            url: transport.target,
            ...(Object.keys(transport.headers).length > 0 ? { headers: transport.headers } : {}),
          }
        : {
            command: transport.target,
            ...(Object.keys(transport.env).length > 0 ? { env: transport.env } : {}),
            ...(args.length > 0 ? { args } : {}),
          }),
      ...(draft.cwd.trim().length > 0 ? { cwd: draft.cwd.trim() } : {}),
      enabled: draft.enabled,
      ...(draft.exposure !== '' ? { exposure: draft.exposure } : {}),
    };
  }

  /**
   * The probe does not need a name, a unique one or a valid one: it answers
   * whether the command or URL starts and speaks MCP.
   */
  private probeInput(): McpServerInput | undefined {
    const draft = this.draft();
    const transport = this.transport(draft);
    if (transport === undefined) {
      return undefined;
    }
    const args = splitMcpArgs(draft.argsText);
    return {
      name: draft.name.trim() || 'probe',
      type: draft.type,
      ...(draft.type === 'http'
        ? {
            url: transport.target,
            ...(Object.keys(transport.headers).length > 0 ? { headers: transport.headers } : {}),
          }
        : {
            command: transport.target,
            ...(args.length > 0 ? { args } : {}),
            ...(Object.keys(transport.env).length > 0 ? { env: transport.env } : {}),
          }),
      enabled: draft.enabled,
    };
  }

  /**
   * The target and the one textarea the transport actually uses. A hidden
   * textarea from the other transport must never block a save: switching from
   * stdio to HTTP leaves unparsed env lines in the draft.
   */
  private transport(
    draft: Draft,
  ): { target: string; env: Record<string, string>; headers: Record<string, string> } | undefined {
    const target = draft.type === 'http' ? draft.url.trim() : draft.command.trim();
    if (target.length === 0) {
      this.error.set(draft.type === 'http' ? 'Enter the server URL.' : 'Enter the command to run.');
      return undefined;
    }
    if (draft.type === 'stdio') {
      const env = parseEnvText(draft.envText);
      if (env.error !== undefined) {
        return this.fail(env.error);
      }
      return { target, env: env.values, headers: {} };
    }
    const headers = parseHeaderText(draft.headersText);
    if (headers.error !== undefined) {
      return this.fail(headers.error);
    }
    return { target, env: {}, headers: headers.values };
  }

  private fail(message: string): undefined {
    this.error.set(message);
    return undefined;
  }

  private reset(): void {
    this.draft.set(emptyDraft());
    this.editing.set(null);
    this.error.set(null);
    this.probe.set(undefined);
  }
}
