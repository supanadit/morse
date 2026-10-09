import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type { ThinkingLevel } from '@morse/protocol';
import { formatTokens } from '@morse/ui-runtime';
import { MorseService } from '../../host/morse.service';
import { ShellState } from '../../state/shell-state';
import { ShortcutService } from '../../services/shortcut.service';
import { SHORTCUTS, isManagedShortcut, type ActionId } from '../../services/shortcuts.catalog';
import { WorkspaceFiles } from '../../services/workspace-files.service';
import { WorkspaceFilesStore } from '../../state/workspace-files.store';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { NotificationPrefs } from '../../state/notification-prefs';
import { RunNotifier } from '../../services/run-notifier';
import { paletteGroups, parsePaletteQuery, type PaletteEntry } from '@morse/ui-runtime';
import { Dialog } from '../../ui/dialog/dialog';

/**
 * The command palette: one field over the whole app.
 *
 * It is a *shell* overlay, so it owns its own input and keyboard (like
 * `ProjectFilter`), not the presentational shape `CommandPicker` and `FilePicker`
 * use — those keep the caret in the prompt. The rows come from everywhere the app
 * already has state for, and every row runs the same action its button or key
 * would: commands go through `ShortcutService.run`, sessions and tabs through
 * `WorkspaceTabs`, everything else through the service that owns it.
 */
@Component({
  selector: 'morse-command-palette',
  templateUrl: './command-palette.html',
  imports: [Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './command-palette.css',
})
export class CommandPalette {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly shortcuts = inject(ShortcutService);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly workspace = inject(WorkspaceFiles);
  private readonly workspaceStore = inject(WorkspaceFilesStore);
  private readonly prefs = inject(NotificationPrefs);
  private readonly notifier = inject(RunNotifier);

  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  protected readonly query = signal('');
  protected readonly active = signal(0);

  /**
   * The reader's own projects and files are only in the list where the host can
   * do something with them. A VS Code host has one folder and no file list, so
   * both sections stay empty instead of offering a key that does nothing.
   */
  private readonly canPreviewFiles = computed(
    () => this.morse.capabilities()?.filePreview === true,
  );
  private readonly canRevealFiles = computed(
    () => this.morse.capabilities()?.revealFile === true,
  );

  /**
   * Commands are the catalog the `?` dialog prints, minus the palette itself and
   * minus anything whose owner is not mounted or says it cannot run. One list, so
   * the palette cannot promise a command the keyboard would refuse.
   */
  private readonly commandEntries = computed<PaletteEntry[]>(() => {
    const available = this.shortcuts.available();
    return SHORTCUTS.filter(
      (spec) =>
        isManagedShortcut(spec) &&
        spec.id !== 'command.palette' &&
        available.get(spec.id) === true,
    ).map((spec) => ({
      id: `command:${spec.id}`,
      kind: 'command' as const,
      label: spec.label,
      description: spec.detail,
      badge: spec.group.toLowerCase(),
      icon: '›',
      keywords: spec.id,
    }));
  });

  /**
   * Commands that are not keyboard shortcuts, so they live here and not in
   * `SHORTCUTS`: the notification toggle and its mode. Their labels read the
   * current preference, so a row always says what running it will do.
   */
  private readonly notificationCommands = computed<PaletteEntry[]>(() => {
    const enabled = this.prefs.enabled();
    const rows: PaletteEntry[] = [
      enabled
        ? {
            id: 'command:notify.off',
            kind: 'command',
            label: 'Turn off completion notifications',
            description: 'No notice when a session finishes',
            badge: 'notify',
            icon: '›',
          }
        : {
            id: 'command:notify.on',
            kind: 'command',
            label: 'Turn on completion notifications',
            description: 'Hear when a session finishes',
            badge: 'notify',
            icon: '›',
          },
    ];
    if (enabled) {
      rows.push(
        this.prefs.mode() === 'away'
          ? {
              id: 'command:notify.always',
              kind: 'command',
              label: 'Notify even while the window is focused',
              badge: 'notify',
              icon: '›',
            }
          : {
              id: 'command:notify.away',
              kind: 'command',
              label: 'Notify only when the window is not focused',
              badge: 'notify',
              icon: '›',
            },
      );
    }
    return rows;
  });

  private readonly tabEntries = computed<PaletteEntry[]>(() => {
    if (!this.canPreviewFiles()) {
      return [];
    }
    return this.tabs.tabs().map((tab) => ({
      id: `tab:${tab.id}`,
      kind: 'tab' as const,
      label: tab.title,
      description:
        tab.kind === 'file'
          ? tab.path
          : tab.kind === 'session'
            ? tab.cwd
            : tab.kind === 'mcp'
              ? 'MCP servers'
              : 'Prompt templates',
      badge:
        tab.kind === 'file'
          ? 'file'
          : tab.kind === 'mcp'
            ? 'mcp'
            : tab.kind === 'prompt'
              ? 'prompts'
              : tab.draft === true
                ? 'draft'
                : 'session',
      icon: tab.kind === 'file' ? '≡' : tab.kind === 'mcp' ? '⚙' : tab.kind === 'prompt' ? '✎' : '▸',
    }));
  });

  private readonly sessionEntries = computed<PaletteEntry[]>(() =>
    this.morse.sessions().map((session) => ({
      id: `session:${session.id}`,
      kind: 'session' as const,
      label: session.title || 'New session',
      description: session.cwd,
      ...(this.isRunning(session.id) ? { badge: 'running' } : {}),
      icon: '▸',
      keywords: session.cwd,
    })),
  );

  /**
   * Projects only exist as a filter on a global host: VS Code is scoped to the
   * folders the window has open, and there is nothing to switch between.
   */
  private readonly projectEntries = computed<PaletteEntry[]>(() => {
    if (this.morse.capabilities()?.scope !== 'global') {
      return [];
    }
    const focused = this.shell.projectFilterPath();
    return [
      {
        id: 'project:',
        kind: 'project' as const,
        label: 'All projects',
        description: 'Show every project in the sidebar',
        ...(focused.length === 0 ? { badge: 'focused' } : {}),
        icon: '⌂',
      },
      ...this.morse.projects().map((project) => ({
        id: `project:${project.path}`,
        kind: 'project' as const,
        label: project.name,
        description: project.path,
        badge: project.path === focused ? 'focused' : `${project.sessionCount}`,
        icon: '⌂',
        keywords: project.path,
      })),
    ];
  });

  private readonly fileEntries = computed<PaletteEntry[]>(() => {
    // With no session in front there is no project whose files these are, and
    // the cached tree belongs to the last one — offer nothing rather than that.
    if (!this.workspace.available() || this.tabs.noSessionInFront()) {
      return [];
    }
    return this.workspaceStore
      .files()
      // A directory has no preview to open; the Explorer is where folders are
      // walked, and this list is "find a file".
      .filter((path) => !path.endsWith('/'))
      .map((path) => {
        const cut = path.lastIndexOf('/');
        return {
          id: `file:${path}`,
          kind: 'file' as const,
          label: cut === -1 ? path : path.slice(cut + 1),
          ...(cut === -1 ? {} : { description: path.slice(0, cut + 1) }),
          icon: '≡',
          keywords: path,
        };
      });
  });

  private readonly modelEntries = computed<PaletteEntry[]>(() => {
    const current = this.morse.model();
    const currentKey = current === undefined ? '' : `${current.provider}/${current.id}`;
    return this.morse.availableModels().map((model) => {
      const key = `${model.provider}/${model.id}`;
      return {
        id: `model:${key}`,
        kind: 'model' as const,
        label: model.name,
        ...(model.contextWindow ? { description: `context ${formatTokens(model.contextWindow)}` } : {}),
        badge: model.provider,
        icon: key === currentKey ? '✓' : '◆',
        keywords: `model ${model.provider} ${model.id}`,
      };
    });
  });

  private readonly thinkingEntries = computed<PaletteEntry[]>(() => {
    const current = this.morse.thinkingLevel();
    return this.morse.availableThinkingLevels().map((level) => ({
      id: `thinking:${level}`,
      kind: 'thinking' as const,
      label: level,
      description: level === current ? 'Current reasoning level' : 'Set the reasoning level',
      icon: level === current ? '✓' : '○',
      keywords: 'thinking reasoning level',
    }));
  });

  private readonly entries = computed<PaletteEntry[]>(() => [
    ...this.commandEntries(),
    ...this.notificationCommands(),
    ...this.tabEntries(),
    ...this.sessionEntries(),
    ...this.projectEntries(),
    ...this.fileEntries(),
    ...this.modelEntries(),
    ...this.thinkingEntries(),
  ]);

  protected readonly groups = computed(() => paletteGroups(this.entries(), this.query()));
  private readonly rows = computed(() => this.groups().flatMap((group) => group.entries));
  /** The highlighted row's id, so the template compares without recomputing. */
  protected readonly activeId = computed(() => this.rows()[this.active()]?.id);
  /** Whether the query locked a source, for the "no match" wording. */
  protected readonly locked = computed(() => parsePaletteQuery(this.query()).kind);

  constructor() {
    afterNextRender(() => this.search()?.nativeElement.focus());
    // A cold file index would make "find a file" look broken on the first open.
    this.workspace.ensureLoaded();

    effect(() => {
      this.active();
      this.groups();
      setTimeout(() => this.revealActive(), 0);
    });
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.active.set(0);
  }

  protected hover(entry: PaletteEntry): void {
    const index = this.rows().findIndex((row) => row.id === entry.id);
    if (index >= 0) {
      this.active.set(index);
    }
  }

  protected dismiss(): void {
    this.shell.closePalette();
  }

  /**
   * Runs one row. The palette closes first: several commands open a modal of their
   * own (the project filter, the compaction gate), and a palette left up behind
   * one is a stack, not a feature.
   */
  protected pick(entry: PaletteEntry): void {
    this.shell.closePalette();
    switch (entry.kind) {
      case 'command': {
        const id = entryId(entry, 'command');
        // The notification rows are the palette's own; everything else runs the
        // owner-bound handler its key would, through `ShortcutService`.
        if (id === 'notify.on') {
          void this.notifier.optIn();
          return;
        }
        if (id === 'notify.off') {
          this.prefs.disable();
          return;
        }
        if (id === 'notify.always') {
          this.prefs.setMode('always');
          return;
        }
        if (id === 'notify.away') {
          this.prefs.setMode('away');
          return;
        }
        this.shortcuts.run(id as ActionId);
        return;
      }
      case 'tab':
        this.tabs.select(entryId(entry, 'tab'));
        return;
      case 'session': {
        const id = entryId(entry, 'session');
        const session = this.morse.sessions().find((candidate) => candidate.id === id);
        if (session !== undefined) {
          this.tabs.focusSession({ id: session.id, title: session.title, cwd: session.cwd });
        }
        return;
      }
      case 'project':
        this.shell.setProjectFilter(entryId(entry, 'project'));
        return;
      case 'file': {
        const path = entryId(entry, 'file');
        if (this.canPreviewFiles()) {
          this.tabs.openFile(path);
        } else if (this.canRevealFiles()) {
          this.morse.hostCommand('revealFile', { path });
        }
        return;
      }
      case 'model': {
        const key = entryId(entry, 'model');
        const model = this.morse
          .availableModels()
          .find((candidate) => `${candidate.provider}/${candidate.id}` === key);
        if (model !== undefined) {
          this.morse.setModel(model.provider, model.id);
        }
        return;
      }
      case 'thinking':
        this.morse.setThinkingLevel(entryId(entry, 'thinking') as ThinkingLevel);
        return;
    }
  }

  /**
   * One key handler for the whole overlay, on the document: the list has no
   * focusable children the reader needs to Tab into, and the caret must not leave
   * the field. `Tab` is borrowed to jump between sections — the palette has
   * nothing else to Tab to. The global shortcut service listens in the capture
   * phase, so a real shortcut still fires before this.
   */
  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) {
      return;
    }
    const rows = this.rows();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.active.update((index) => Math.min(index + 1, Math.max(0, rows.length - 1)));
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.active.update((index) => Math.max(0, index - 1));
        return;
      case 'Home':
        event.preventDefault();
        this.active.set(0);
        return;
      case 'End':
        event.preventDefault();
        this.active.set(Math.max(0, rows.length - 1));
        return;
      case 'PageDown':
        event.preventDefault();
        this.active.update((index) => Math.min(index + 10, Math.max(0, rows.length - 1)));
        return;
      case 'PageUp':
        event.preventDefault();
        this.active.update((index) => Math.max(index - 10, 0));
        return;
      case 'Tab':
        event.preventDefault();
        this.jumpSection(event.shiftKey ? -1 : 1);
        return;
      case 'Enter': {
        if (event.isComposing) {
          return;
        }
        const chosen = rows[this.active()];
        if (chosen !== undefined) {
          event.preventDefault();
          this.pick(chosen);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Moves the highlight to the first row of the next (or previous) section. */
  private jumpSection(step: number): void {
    const groups = this.groups();
    if (groups.length === 0) {
      return;
    }
    const starts: number[] = [];
    let total = 0;
    for (const group of groups) {
      starts.push(total);
      total += group.entries.length;
    }
    const current = starts.findIndex((start, index) => {
      const end = index + 1 < starts.length ? starts[index + 1]! : total;
      return this.active() >= start && this.active() < end;
    });
    const from = current === -1 ? 0 : current;
    const next = (from + step + starts.length) % starts.length;
    this.active.set(starts[next]!);
  }

  /** Nudges the highlighted row into the list viewport without scrolling the page. */
  private revealActive(): void {
    const container = this.list()?.nativeElement;
    const row = container?.querySelectorAll<HTMLElement>('.row')[this.active()];
    if (!container || !row) {
      return;
    }
    const view = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < view.top) {
      container.scrollTop -= view.top - rect.top;
    } else if (rect.bottom > view.bottom) {
      container.scrollTop += rect.bottom - view.bottom;
    }
  }

  private isRunning(sessionId: string): boolean {
    const activity = this.morse.sessionActivity().get(sessionId);
    if (activity !== undefined) {
      return activity.streaming;
    }
    return sessionId === this.morse.state().sessionId && this.morse.state().streaming;
  }
}

/** The key after `kind:`. `id` is always minted as `${kind}:${key}` above. */
function entryId(entry: PaletteEntry, kind: string): string {
  return entry.id.slice(kind.length + 1);
}
