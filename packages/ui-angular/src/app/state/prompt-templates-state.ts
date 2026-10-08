import { computed, inject, Injectable, signal } from '@angular/core';
import type {
  PromptScope,
  PromptTemplateInput,
  PromptTemplateMutation,
  PromptTemplatesResult,
} from '@morse/protocol';
import { MorseService } from '../host/morse.service';

/** A round trip to read or write a small `.md` file; the host answers immediately. */
const TIMEOUT_MS = 10_000;

/**
 * pi's prompt templates, as the host last reported them. One store because the
 * editor both lists them and mutates them, and a mutation must refresh the list
 * it renders. The editor is the only surface; the palette re-reads the files on
 * its own (`commands/refresh`).
 */
@Injectable({ providedIn: 'root' })
export class PromptTemplatesState {
  private readonly morse = inject(MorseService);

  private readonly result = signal<PromptTemplatesResult | undefined>(undefined);
  private readonly loading = signal(false);
  private readonly inFlight = new Map<string, Promise<PromptTemplatesResult | undefined>>();
  private readonly fetchedAt = new Map<string, number>();

  /**
   * Only a host that can read and write pi's prompt directories advertises this.
   */
  readonly enabled = computed(() => this.morse.capabilities()?.promptEditor === true);
  readonly templates = computed(() => this.result()?.templates ?? []);
  readonly info = computed(() => this.result());
  readonly isLoading = this.loading.asReadonly();
  /**
   * Whether a project is in scope. With no session there is none, so the editor
   * edits the user templates only — the project directory comes from the session.
   */
  readonly hasProject = computed(() => (this.result()?.projectDir ?? '').length > 0);

  /**
   * The directory a project template would belong to. VS Code is workspace-scoped,
   * so its workspace folder is the project whether or not a session is attached;
   * the browser host has many projects, so it takes the viewing session's — and
   * with no session there is none, leaving the user templates only.
   */
  private projectCwd(): string {
    if (this.morse.capabilities()?.scope === 'workspace') {
      return this.morse.workspace().cwd;
    }
    return this.morse.state().sessionId !== undefined ? this.morse.workspace().cwd : '';
  }

  /** Fetch the templates for the viewing session's directory. */
  async refresh(force = false): Promise<PromptTemplatesResult | undefined> {
    const cwd = this.projectCwd();
    const existing = this.inFlight.get(cwd);
    if (existing) {
      return existing;
    }
    // A re-open of the editor does not need a second scan of the same directory.
    if (!force && this.result() !== undefined && Date.now() - (this.fetchedAt.get(cwd) ?? 0) < 2_000) {
      return this.result();
    }
    const promise = this.fetch(cwd);
    this.inFlight.set(cwd, promise);
    return promise.finally(() => {
      this.inFlight.delete(cwd);
    });
  }

  private async fetch(cwd: string): Promise<PromptTemplatesResult | undefined> {
    this.loading.set(true);
    try {
      const data = await this.morse.requestHostCommand('promptTemplates', { cwd }, TIMEOUT_MS);
      const result = asPromptTemplates(data);
      if (result) {
        this.result.set(result);
        this.fetchedAt.set(cwd, Date.now());
      }
      return result;
    } finally {
      this.loading.set(false);
    }
  }

  async save(input: PromptTemplateInput): Promise<PromptTemplateMutation> {
    const data = await this.morse.requestHostCommand(
      'promptTemplateSave',
      { ...input, cwd: this.projectCwd() },
      TIMEOUT_MS,
    );
    const result = asMutation(data);
    if (result.ok) {
      // The palette lists templates from the agent's own cache: ask pi to re-read
      // them so a newly saved `/command` is offered without a session restart.
      this.morse.refreshCommands();
      await this.refresh(true);
    }
    return result;
  }

  async remove(name: string, scope: PromptScope): Promise<PromptTemplateMutation> {
    const data = await this.morse.requestHostCommand(
      'promptTemplateDelete',
      { name, scope, cwd: this.projectCwd() },
      TIMEOUT_MS,
    );
    const result = asMutation(data);
    if (result.ok) {
      this.morse.refreshCommands();
      await this.refresh(true);
    }
    return result;
  }
}

function asPromptTemplates(value: unknown): PromptTemplatesResult | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row['templates'])) {
    return undefined;
  }
  return {
    templates: row['templates'].filter(isTemplateInfo),
    globalDir: typeof row['globalDir'] === 'string' ? row['globalDir'] : '',
    projectDir: typeof row['projectDir'] === 'string' ? row['projectDir'] : '',
    trusted: row['trusted'] === true,
  };
}

function isTemplateInfo(value: unknown): value is PromptTemplatesResult['templates'][number] {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['name'] === 'string' &&
    typeof row['raw'] === 'string' &&
    (row['scope'] === 'global' || row['scope'] === 'project')
  );
}

function asMutation(value: unknown): PromptTemplateMutation {
  if (typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true) {
    const row = value as { path?: unknown; scope?: unknown };
    return {
      ok: true,
      ...(typeof row.path === 'string' ? { path: row.path } : {}),
      ...(row.scope === 'global' || row.scope === 'project' ? { scope: row.scope } : {}),
    };
  }
  const message =
    typeof (value as { message?: unknown } | null)?.message === 'string'
      ? (value as { message: string }).message
      : 'The host did not apply the change.';
  return { ok: false, message };
}
