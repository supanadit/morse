/**
 * Reads a file tab's content and diff on demand. Kept apart from the tab strip's
 * state so the host round trips have one owner.
 */
import { languageForPath } from '@morse/ui-runtime';
import type { MorseService } from '../host/morse.service';
import { asDiff, asPreview } from './workspace-tabs-codec.js';
import type { FileTab, WorkspaceTab } from './workspace-tabs.js';

export class FileTabLoader {
  constructor(
    private readonly morse: MorseService,
    private readonly tabs: () => readonly WorkspaceTab[],
    private readonly patch: (id: string, change: Partial<FileTab>) => void,
  ) {}

  needsLoad(tab: WorkspaceTab): boolean {
    if (tab.kind !== 'file') {
      return false;
    }
    // A commit tab has no working-tree content to read: its diff is the view.
    if (tab.commitHash !== undefined) {
      return tab.diff === undefined && tab.diffLoading !== true && tab.diffError === undefined;
    }
    return !tab.loading && tab.content === undefined && tab.error === undefined;
  }

  /** Re-reads a file tab from disk (the preview's refresh affordance). */
  reload(id: string): void {
    // A refresh re-reads both the content and the diff: the file changed on disk.
    this.patch(id, { diff: undefined, diffError: undefined });
    void this.load(id);
  }

  /**
   * Reads the file's unified diff the first time a diff view needs it. Kept on
   * the tab beside its content, so revealing the same tab again is free. A
   * commit tab asks for the commit's diff instead of the working tree's.
   */
  loadDiff(id: string): void {
    const tab = this.tabs().find((candidate) => candidate.id === id);
    if (
      tab === undefined ||
      tab.kind !== 'file' ||
      tab.diff !== undefined ||
      tab.diffLoading === true
    ) {
      return;
    }
    this.patch(id, { diffLoading: true, diffError: undefined });
    const request =
      tab.commitHash !== undefined
        ? this.morse.requestHostCommand('gitCommitDiff', {
            hash: tab.commitHash,
            path: tab.path,
            cwd: tab.projectCwd,
            ...(tab.repo === undefined ? {} : { repo: tab.repo }),
          })
        : this.morse.requestHostCommand('gitDiff', {
            path: tab.path,
            cwd: tab.projectCwd,
            ...(tab.repo === undefined ? {} : { repo: tab.repo }),
          });
    void request.then((data) => {
      const diff = asDiff(data);
      if (diff === undefined) {
        this.patch(id, {
          diffLoading: false,
          diffError:
            tab.commitHash === undefined
              ? 'Could not read this file’s changes.'
              : 'Could not read this file in that commit.',
        });
        return;
      }
      this.patch(id, { diffLoading: false, diff });
    });
  }

  async load(id: string): Promise<void> {
    const tab = this.tabs().find((candidate) => candidate.id === id);
    if (tab === undefined || tab.kind !== 'file') {
      return;
    }
    if (tab.commitHash !== undefined) {
      this.loadDiff(id);
      return;
    }
    this.patch(id, { loading: true, error: undefined });
    const data = await this.morse.requestHostCommand('readFile', {
      path: tab.path,
      cwd: tab.projectCwd,
    });
    const preview = asPreview(data);
    if (preview === undefined) {
      this.patch(id, { loading: false, error: 'Could not read this file.' });
      return;
    }
    this.patch(id, {
      loading: false,
      content: preview.content,
      size: preview.size,
      truncated: preview.truncated,
      binary: preview.binary,
      language: languageForPath(preview.path),
    });
  }
}
