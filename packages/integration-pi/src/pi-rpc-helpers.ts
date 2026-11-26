/**
 * pi's pure mappings: RPC records into Morse's domain shapes, and the prompt
 * templates Morse rebuilds from disk. No agent state lives here.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  MODEL_INPUTS,
  THINKING_LEVELS,
  type AgentCommand,
  type AgentCommandSource,
  type AgentDiagnostic,
  type AgentInteractionRequest,
  type AgentStatus,
  type AgentWidget,
  type ModelInput,
  type ModelRef,
  type NoticeLevel,
  type PromptImage,
  type ThinkingLevel,
} from '@morse/agent';
import { stripAnsi } from './internal/ansi-text.js';
import { getBuiltinSlashCommands } from './internal/pi-builtins.js';
import { parsePromptTemplate, type PromptFrontmatter } from './internal/prompt-frontmatter.js';
import { readProjectTrust, resolveAgentDir } from './internal/project-trust.js';
import type { PiSpawn } from './internal/resolve-pi.js';
import {
  isDefined,
  type RpcExtensionUiRequest,
  type RpcModel,
} from './internal/rpc-types.js';

export function toInteractionRequest(
  kind: 'select' | 'confirm' | 'input' | 'editor',
  request: RpcExtensionUiRequest,
): AgentInteractionRequest {
  const title = request.title ?? kind;
  switch (kind) {
    case 'select':
      return {
        requestId: request.id,
        kind: 'select',
        title,
        options: (request.options ?? []).map((value) => ({ value, label: value })),
      };
    case 'confirm':
      return { requestId: request.id, kind: 'confirm', title, message: request.message ?? '' };
    case 'input':
      return {
        requestId: request.id,
        kind: 'input',
        title,
        placeholder: request.placeholder,
      };
    case 'editor':
      return { requestId: request.id, kind: 'editor', title, value: request.prefill };
  }
}

/**
 * Applies one `setWidget`: a new key appends (pi paints widgets in set order), an
 * existing key replaces in place, and a missing/empty `widgetLines` clears it.
 * RPC mode forwards only string lines, so a component factory never arrives.
 *
 * Widget text is theme-colored by the extension (`theme.fg`), and pi forwards
 * the SGR escapes verbatim; strip them here so an extension-agnostic frontend
 * renders text rather than literal `\u001b[38;2;...m`.
 */
export function upsertWidget(
  current: AgentWidget[],
  request: RpcExtensionUiRequest,
): AgentWidget[] {
  const key = request.widgetKey;
  if (key === undefined || key.length === 0) {
    return current;
  }
  const lines = request.widgetLines;
  const index = current.findIndex((widget) => widget.key === key);
  if (lines === undefined || lines.length === 0) {
    return index === -1 ? current : current.filter((widget) => widget.key !== key);
  }
  const next: AgentWidget = {
    key,
    lines: lines.map(stripAnsi),
    placement: request.widgetPlacement === 'belowEditor' ? 'belowEditor' : 'aboveEditor',
  };
  if (index === -1) {
    return [...current, next];
  }
  const copy = [...current];
  copy[index] = next;
  return copy;
}

/**
 * Applies one `setStatus`: set or replace by key, clear when the text is gone.
 * Status text is theme-colored by the extension and forwarded verbatim by pi
 * (see `upsertWidget`), so it is stripped at the same boundary.
 */
export function upsertStatus(
  current: AgentStatus[],
  request: RpcExtensionUiRequest,
): AgentStatus[] {
  const key = request.statusKey;
  if (key === undefined || key.length === 0) {
    return current;
  }
  const text = request.statusText;
  const index = current.findIndex((status) => status.key === key);
  // A theme-colored line is never empty once stripped only of *visible* text:
  // an extension that clears a status sends no text at all, so emptiness is
  // judged before stripping, on the raw value.
  if (text === undefined || text.length === 0) {
    return index === -1 ? current : current.filter((status) => status.key !== key);
  }
  const next: AgentStatus = { key, text: stripAnsi(text) };
  if (index === -1) {
    return [...current, next];
  }
  const copy = [...current];
  copy[index] = next;
  return copy;
}

export function toModelRef(model: RpcModel): ModelRef {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.input && model.input.length > 0 ? { input: toModelInputs(model.input) } : {}),
  };
}

/**
 * pi reports input as a plain string array; only the values the frontend can
 * badge are kept, and an unfamiliar one is dropped rather than rendered as a
 * modality nobody knows (pi ships `text`/`image` today). Exported so the
 * mapping is locked by a test without spawning pi.
 */
export function toModelInputs(values: readonly string[]): ModelInput[] {
  return values.map((value) => MODEL_INPUTS.find((known) => known === value)).filter(isDefined);
}

export function toThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (!value) {
    return undefined;
  }
  // pi's canonical list is off..max, but the level names arrive from pi and are
  // what pi validates against (`set_thinking_level` accepts whatever it
  // reported). An unfamiliar name — say a future provider tier — is passed
  // through intact: the picker's brain falls back to its default intensity and
  // the label is just capitalized, so hiding it would silently drop a real level.
  return THINKING_LEVELS.find((level) => level === value) ?? (value.trim() as ThinkingLevel);
}

export function dedupeThinkingLevels(levels: ThinkingLevel[]): ThinkingLevel[] {
  return [...new Set(levels)];
}

/**
 * pi reports command sources as `extension`, `prompt` or `skill`. Anything else
 * (a future source) is treated as an extension command so it still runs.
 */
function toCommandSource(value: string | undefined): AgentCommandSource {
  return value === 'prompt' || value === 'skill' ? value : 'extension';
}

/**
 * pi lists a prompt template in `get_commands` but does not send its body over
 * RPC, and it does not notice a file added after spawn. Read the file directly —
 * both for the templates pi named and for the ones Morse finds on disk. Best
 * effort: an unreadable file is left out rather than offered as a dead command.
 */
async function readTemplateFile(path: string | undefined): Promise<string | undefined> {
  if (path === undefined || path.length === 0) {
    return undefined;
  }
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** What a command list is rebuilt from: the workspace and the pi environment. */
export interface CommandContext {
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
  /**
   * The resolved pi spawn, so the palette can source pi's own TUI builtins
   * (`/settings`, `/model`, `/reload`, ...) from the very install this session
   * runs. Optional: without it the palette carries only what `get_commands`
   * returned plus prompt templates on disk.
   */
  spawn?: PiSpawn;
}

/** The subset of a `get_commands` entry the command list cares about. */
export interface CommandListInput {
  name?: string;
  description?: string;
  source?: string;
  sourceInfo?: { path?: string; scope?: string };
}

/** What a rebuild produced: the commands, and the templates pi refused. */
export interface CommandListResult {
  commands: AgentCommand[];
  diagnostics: AgentDiagnostic[];
}

/**
 * The palette's command list, rebuilt from disk. pi only exposes the templates
 * it loaded at spawn (`get_commands` is a cache), so this also re-reads every
 * template file and scans the conventional prompt directories — that is what
 * makes a template added, changed or deleted since spawn show up without a pi
 * reload.
 *
 * pi's own list stays the source for extension and skill commands, and for
 * prompt templates that live outside the conventional directories (packages,
 * explicit paths); a listed template whose file is gone is dropped.
 */
export async function buildCommandList(
  items: CommandListInput[] | undefined,
  context: CommandContext,
): Promise<CommandListResult> {
  const commands: AgentCommand[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  const seen = new Set<string>();
  let projectTrusted = false;
  // First source recorded per name, so a same-name later command knows what it
  // was hidden behind (a pi builtin earns an explanatory diagnostic; other
  // collisions keep the previous first-wins behaviour).
  const shadowedBy = new Map<string, AgentCommandSource>();
  // pi's TUI lists its builtins (`/settings`, `/model`, `/reload`, ...) alongside
  // the extensible commands; `get_commands` deliberately carries only the
  // extensible three. Sourcing them from the install this session runs (and
  // re-reading whenever that install's file changes) keeps the palette identical
  // to the TUI's with nothing hardcoded — a `pi update` is picked up on the
  // next palette refresh instead of surviving until pi is re-resolved.
  const builtins = getBuiltinSlashCommands(context.spawn);
  if (builtins) {
    for (const builtin of builtins.commands) {
      commands.push({
        name: builtin.name,
        description: builtin.description,
        source: 'builtin',
        argumentHint: builtin.argumentHint,
      });
      seen.add(builtin.name);
      shadowedBy.set(builtin.name, 'builtin');
    }
  } else if (context.spawn) {
    // Only warn when a pi install was involved but could not be read; a context
    // without a spawn (tests, hosts that never resolved pi) simply has not one.
    diagnostics.push({
      key: 'pi-builtins:unreadable',
      level: 'info',
      text: 'Morse could not read the built-in slash commands in the installed pi; the palette shows extension commands, prompt templates and skills.',
    });
  }

  for (const item of items ?? []) {
    if (typeof item.name !== 'string' || item.name.trim().length === 0) {
      continue;
    }
    const source = toCommandSource(item.source);
    if (source !== 'prompt') {
      // pi's TUI gives builtins precedence over an extension command registered
      // under the same name (its own conflict diagnostics check for exactly
      // this); mirror it here so a row cannot silently lose the shadow.
      if (shadowedBy.get(item.name) === 'builtin') {
        diagnostics.push({
          key: `pi-command-shadow:${item.name}`,
          level: 'warn',
          text: `/${item.name} is a pi built-in; the extension command registered for that name was hidden, as pi's own TUI does.`,
        });
      } else {
        commands.push({ name: item.name, description: item.description, source });
        shadowedBy.set(item.name, source);
      }
      seen.add(item.name);
      continue;
    }
    if (item.sourceInfo?.scope === 'project') {
      projectTrusted = true;
    }
    const template = await readTemplateFile(item.sourceInfo?.path);
    if (template === undefined) {
      // The file pi listed is gone: hide it rather than offer a dead command.
      continue;
    }
    const parsed = parseTemplate(template, item.sourceInfo?.path, diagnostics);
    if (parsed === undefined) {
      continue;
    }
    if (shadowedBy.get(item.name) === undefined) {
      commands.push({
        name: item.name,
        // Prefer the freshly parsed description so an edited frontmatter reflects
        // too; pi's cached description is the fallback.
        description: promptDescription(parsed) ?? item.description,
        source,
        template,
      });
      shadowedBy.set(item.name, source);
    }
    seen.add(item.name);
  }

  for (const dir of await promptDirs(projectTrusted, context)) {
    for (const file of await listPromptFiles(dir)) {
      if (seen.has(file.name)) {
        // pi's builtin list is authoritative; a same-name shadow only warms the
        // palette reader (as below) when it hides an extensible command.
        continue;
      }
      const template = await readTemplateFile(file.path);
      if (template === undefined) {
        continue;
      }
      const parsed = parseTemplate(template, file.path, diagnostics);
      if (parsed === undefined) {
        continue;
      }
      commands.push({
        name: file.name,
        description: promptDescription(parsed),
        source: 'prompt',
        template,
      });
      seen.add(file.name);
    }
  }
  return { commands, diagnostics };
}

/**
 * pi's frontmatter validation, reported instead of swallowed. A template whose
 * frontmatter pi cannot parse is dropped from the palette (offering a `/command`
 * pi will not run is worse than hiding it) and named as a diagnostic, so the
 * reader hears about the broken file in the chat instead of in the TUI only.
 */
function parseTemplate(
  raw: string,
  path: string | undefined,
  diagnostics: AgentDiagnostic[],
): PromptFrontmatter | undefined {
  try {
    return parsePromptTemplate(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'the frontmatter could not be parsed';
    const firstLine = message.split('\n').find((line) => line.trim().length > 0) ?? message;
    // YAML's message ends with a colon before its code frame; a notice sentence
    // reads better without it.
    const reason = firstLine.trim().replace(/:$/, '');
    diagnostics.push({
      key: `prompt:${path ?? reason}`,
      level: 'warn',
      text: `Prompt template ${path ?? '(unnamed)'} is not loaded by pi: ${reason}`,
    });
    return undefined;
  }
}

/**
 * Directories Morse re-scans for prompt templates: the user's global prompts,
 * and the project's — the latter only once that project is trusted, exactly as
 * pi gates project resources.
 */
async function promptDirs(projectTrusted: boolean, context: CommandContext): Promise<string[]> {
  const dirs = [join(resolveAgentDir(context.env), 'prompts')];
  if (projectTrusted || readProjectTrust(context.cwd, resolveAgentDir(context.env))) {
    dirs.push(resolve(context.cwd, '.pi', 'prompts'));
  }
  return dirs;
}

/** Direct `.md` children of a prompt directory — pi loads direct children only. */
async function listPromptFiles(dir: string): Promise<{ name: string; path: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: { name: string; path: string }[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) {
      continue;
    }
    const path = join(dir, entry.name);
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = (await stat(path)).isFile();
      } catch {
        continue;
      }
    }
    if (isFile) {
      files.push({ name: basename(entry.name, '.md'), path });
    }
  }
  return files;
}

/**
 * What the palette prints for a scanned template: pi's `description` frontmatter
 * (already YAML-decoded, so quoting is handled), or the first non-empty body
 * line, truncated the way pi truncates it.
 */
function promptDescription(parsed: PromptFrontmatter): string | undefined {
  const described = parsed.frontmatter['description'];
  if (typeof described === 'string' && described.length > 0) {
    return described;
  }
  const firstLine = parsed.body.split('\n').find((line) => line.trim().length > 0);
  if (firstLine === undefined) {
    return undefined;
  }
  const trimmed = firstLine.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
}

export function toNoticeLevel(value: string | undefined): NoticeLevel {
  if (value === 'error') {
    return 'error';
  }
  if (value === 'warning' || value === 'warn') {
    return 'warn';
  }
  return 'info';
}
/**
 * pi's prompt command takes images as content blocks. pi resizes and forwards
 * image/* only — video, audio and PDF attachments ride the files/workspace path
 * instead, so non-images are filtered here rather than failing the turn.
 * Engine limitation, not Morse's: pi's RPC has no video/audio block at all.
 */
export function toPiImages(
  images: PromptImage[],
): Array<{ type: 'image'; data: string; mimeType: string }> {
  return images
    .filter((image) => image.mimeType.toLowerCase().startsWith('image/'))
    .map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }));
}
