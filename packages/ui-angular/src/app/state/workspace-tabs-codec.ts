/**
 * The tab strip's durable shape: what `workbench.json` may hold and the
 * degradation rules that keep a hand-edited or older file from breaking boot.
 */
import type { FileTab, WorkspaceTab } from './workspace-tabs.js';

/**
 * One tab as it is written to `<MORSE_HOME>/workbench.json`. Only the durable
 * half is kept: a session's id/title/cwd (a draft keeps its `draft` flag), a
 * file's path and how it was opened. A preview's content (and a commit's diff)
 * is read again on restore, so the file stays small and the view is never a
 * stale copy of the disk.
 */
/** The shape every restorable tab shares: which kind, its id, and its label. */
export interface PersistedTabBase {
  kind: 'session' | 'mcp' | 'settings' | 'file' | 'bot' | 'bot-editor';
  id: string;
  title: string;
}

/** A conversation tab; `draft` before the host has opened a session for it. */
export interface PersistedSessionTab extends PersistedTabBase {
  kind: 'session';
  cwd?: string;
  draft?: boolean;
}

export interface PersistedMcpTab extends PersistedTabBase {
  kind: 'mcp';
}

/** A settings page; the page reopens, its form starts fresh. */
export interface PersistedSettingsTab extends PersistedTabBase {
  kind: 'settings';
  page: 'members' | 'access' | 'gpg' | 'git' | 'providers';
}

/** A bot conversation; its id is the conversation id the host opens. */
export interface PersistedBotChatTab extends PersistedTabBase {
  kind: 'bot';
}

/** A bot editor; `target` is the handle being edited, `null` for a new bot. */
export interface PersistedBotEditorTab extends PersistedTabBase {
  kind: 'bot-editor';
  target: string | null;
}

/** A file or diff preview, optionally tied to a session or a commit. */
export interface PersistedFileTab extends PersistedTabBase {
  kind: 'file';
  path: string;
  mention?: boolean;
  sessionId?: string;
  language?: string;
  commitHash?: string;
  commitSubject?: string;
  projectCwd?: string;
}

/** A tab the strip restores after a reload. */
export type PersistedTab =
  | PersistedSessionTab
  | PersistedMcpTab
  | PersistedSettingsTab
  | PersistedBotChatTab
  | PersistedBotEditorTab
  | PersistedFileTab;

/** What the strip remembers across a reload: its tabs, and which one was in front. */
export interface TabsSnapshot {
  tabs: PersistedTab[];
  activeId?: string;
}

/** The shape the host's `readFile` command resolves with. */
export interface FilePreviewPayload {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

/** Files opened from the `@` picker live in a second row, so the prefix differs. */
export const MENTION_PREFIX = 'mention:';

export function asPreview(value: unknown): FilePreviewPayload | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const content = candidate['content'];
  const path = candidate['path'];
  if (typeof content !== 'string' || typeof path !== 'string') {
    return undefined;
  }
  const size = candidate['size'];
  return {
    path,
    content,
    size: typeof size === 'number' ? size : content.length,
    truncated: candidate['truncated'] === true,
    binary: candidate['binary'] === true,
  };
}

/**
 * The persisted `{ tabs, activeId }` shape, with every entry that is not a
 * usable tab dropped. A layout from an unknown version (or a hand-edited file)
 * degrades to the entries that still make sense instead of throwing at boot.
 */
export function asTabsSnapshot(value: unknown): TabsSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const rawTabs = candidate['tabs'];
  if (!Array.isArray(rawTabs)) {
    return undefined;
  }
  const tabs = rawTabs.flatMap<PersistedTab>((entry) => {
    const tab = asPersistedTab(entry);
    return tab === undefined ? [] : [tab];
  });
  const activeId = candidate['activeId'];
  return {
    tabs,
    ...(typeof activeId === 'string' ? { activeId } : {}),
  };
}

export function asPersistedTab(value: unknown): PersistedTab | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate['id'];
  if (typeof id !== 'string' || id.length === 0) {
    return undefined;
  }
  if (candidate['kind'] === 'session') {
    const title = candidate['title'];
    if (typeof title !== 'string') {
      return undefined;
    }
    const cwd = candidate['cwd'];
    return {
      kind: 'session',
      id,
      title,
      ...(typeof cwd === 'string' ? { cwd } : {}),
      ...(candidate['draft'] === true ? { draft: true } : {}),
    };
  }
  if (candidate['kind'] === 'mcp') {
    const title = candidate['title'];
    if (typeof title !== 'string') {
      return undefined;
    }
    return { kind: 'mcp', id, title };
  }
  if (candidate['kind'] === 'settings') {
    const title = candidate['title'];
    // An unknown page is not worth guessing at.
    if (
      typeof title !== 'string' ||
      (candidate['page'] !== 'members' && candidate['page'] !== 'access' && candidate['page'] !== 'gpg' && candidate['page'] !== 'git' && candidate['page'] !== 'providers')
    ) {
      return undefined;
    }
    return { kind: 'settings', id, title, page: candidate['page'] };
  }
  if (candidate['kind'] === 'bot') {
    const title = candidate['title'];
    return typeof title === 'string' ? { kind: 'bot', id, title } : undefined;
  }
  if (candidate['kind'] === 'bot-editor') {
    const title = candidate['title'];
    const target = candidate['target'];
    if (typeof title !== 'string' || (target !== null && typeof target !== 'string')) {
      return undefined;
    }
    return { kind: 'bot-editor', id, title, target: target as string | null };
  }
  if (candidate['kind'] !== 'file') {
    return undefined;
  }
  const path = candidate['path'];
  const title = candidate['title'];
  if (typeof path !== 'string' || typeof title !== 'string') {
    return undefined;
  }
  const sessionId = candidate['sessionId'];
  const language = candidate['language'];
  const commitHash = candidate['commitHash'];
  const commitSubject = candidate['commitSubject'];
  const projectCwd = candidate['projectCwd'];
  return {
    kind: 'file',
    id,
    path,
    title,
    ...(candidate['mention'] === true ? { mention: true } : {}),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof language === 'string' ? { language } : {}),
    ...(typeof commitHash === 'string' ? { commitHash } : {}),
    ...(typeof commitSubject === 'string' ? { commitSubject } : {}),
    ...(typeof projectCwd === 'string' ? { projectCwd } : {}),
  };
}

export function asDiff(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const diff = (value as { diff?: unknown }).diff;
  return typeof diff === 'string' ? diff : undefined;
}

/** The `N` in `draft-N`; 0 when the id is not a draft id this store minted. */
export function draftNumber(id: string): number {
  const match = /^draft-(\d+)$/.exec(id);
  return match === null ? 0 : Number.parseInt(match[1]!, 10);
}

/** The `N` in `bot:new-N`, so restoring a layout cannot reuse a draft tab id. */
export function botEditorNumber(id: string): number {
  const match = /^bot:new-(\d+)$/.exec(id);
  return match === null ? 0 : Number.parseInt(match[1]!, 10);
}

export function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** A quoted file's tab id: keyed by session, so the same path can be quoted twice. */
export function mentionTabId(sessionId: string | undefined, path: string): string {
  return `${MENTION_PREFIX}${sessionId ?? ''}:${path}`;
}

/** A commit file's tab id: the same path in two commits is two diffs. */
export function commitTabId(hash: string, path: string): string {
  return `commit:${hash}:${path}`;
}

/**
 * Drops a file tab's content and diff, so a reveal that changed the project reads
 * the new directory instead of showing the old one's bytes.
 */
export function clearedPreview(): Partial<FileTab> {
  return { content: undefined, error: undefined, diff: undefined, diffError: undefined };
}

/** The row a tab renders in: files attached to a session get their own, below the sessions. */
export function tabRow(tab: WorkspaceTab): 'main' | 'mention' {
  return tab.kind === 'file' && tab.mention === true ? 'mention' : 'main';
}

/** The session a chip belongs to, so closing the chip in front can return there. */
export function chipOwner(tab: WorkspaceTab | undefined): string | undefined {
  return tab?.kind === 'file' && tab.mention === true ? tab.sessionId : undefined;
}
