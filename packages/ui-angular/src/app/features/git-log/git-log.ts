import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { GitCommit, GitFileStatus } from '@morse/protocol';
import {
  asCommitFiles,
  changeKind,
  fileIcon,
  layoutGraph,
  type ChangeKind,
  type GraphEdge,
  type GraphRow,
  type TreeNode,
} from '@morse/ui-runtime';
import { MorseService } from '../../host/morse.service';
import { GitPanelState, type GitRepoState } from '../../services/git-panel-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { TreeList } from '../../ui/tree-list/tree-list';

const LANE_WIDTH = 16;
const ROW_HEIGHT = 32;
const MAX_REFS = 2;
const PALETTE = [
  'var(--morse-accent)',
  'var(--morse-success)',
  'var(--morse-number)',
  'var(--morse-typename)',
  'var(--morse-keyword)',
  'var(--morse-info)',
  'var(--morse-warn)',
];

interface CommitEntry {
  row: GraphRow;
  commit: GitCommit;
  refs: string[];
  moreRefs: number;
  restTitle: string;
}

interface CommitFiles {
  loading: boolean;
  files: Array<{ path: string; kind: ChangeKind }>;
  error?: string;
}

const EMPTY_FILES: CommitFiles = { loading: false, files: [] };

/**
 * The bottom panel's Git Log: one repository's history behind a branch tree.
 * The tree scopes the log; a ref never checks out a branch. The table keeps the
 * same lane graph as the sidebar had, and a selected commit opens its files.
 */
@Component({
  selector: 'morse-git-log',
  imports: [TreeList],
  templateUrl: './git-log.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './git-log.css',
})
export class GitLogView {
  private readonly git = inject(GitPanelState);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly morse = inject(MorseService);

  protected readonly repos = this.git.repos;
  protected readonly loading = this.git.loading;

  private readonly chosenPath = signal<string | undefined>(undefined);
  protected readonly query = signal('');
  protected readonly author = signal('');
  private readonly openKey = signal<string | undefined>(undefined);
  private readonly fileState = signal<Record<string, CommitFiles>>({});

  protected readonly repo = computed<GitRepoState | undefined>(() => {
    const path = this.chosenPath();
    if (path === undefined) {
      return this.git.current();
    }
    // A project switch can take the chosen nested repository away; fall back to
    // the project's own instead of showing an empty log behind a stale picker.
    return this.git.stateFor(path) ?? this.git.current();
  });

  protected readonly error = computed(
    () => this.git.error() ?? this.repo()?.error(),
  );
  protected readonly branches = computed(() => this.repo()?.branches());
  protected readonly logRef = computed(() => this.repo()?.logRef());
  protected readonly authors = computed(() =>
    [...new Set((this.repo()?.commits() ?? []).map((commit) => commit.author))].sort(),
  );

  protected readonly filtered = computed(() => {
    const repo = this.repo();
    if (repo === undefined) {
      return [];
    }
    const text = this.query().trim().toLowerCase();
    const author = this.author();
    return repo.commits().filter((commit) => {
      if (author.length > 0 && commit.author !== author) {
        return false;
      }
      if (text.length === 0) {
        return true;
      }
      return (
        commit.subject.toLowerCase().includes(text) ||
        commit.hash.toLowerCase().startsWith(text) ||
        commit.shortHash.toLowerCase().startsWith(text)
      );
    });
  });

  protected readonly entries = computed(() => {
    const commits = this.filtered();
    const layout = layoutGraph(commits);
    const rows: CommitEntry[] = layout.rows.map((row, index) => {
      const commit = commits[index]!;
      const refs = commit.refs.slice(0, MAX_REFS);
      const rest = commit.refs.slice(MAX_REFS);
      return {
        row,
        commit,
        refs,
        moreRefs: rest.length,
        restTitle: rest.map((ref) => this.refLabel(ref)).join(', '),
      };
    });
    return {
      rows,
      graphWidth: Math.max(1, layout.laneCount) * LANE_WIDTH,
      laneCount: layout.laneCount,
    };
  });

  protected readonly selectedHash = computed(() => {
    const key = this.openKey();
    return key === undefined ? undefined : key.slice(key.indexOf('\u0000') + 1);
  });

  protected readonly selectedFiles = computed<CommitFiles>(() => {
    const key = this.openKey();
    return key === undefined ? EMPTY_FILES : (this.fileState()[key] ?? EMPTY_FILES);
  });

  protected readonly detailNodes = computed<TreeNode<{ path: string; kind: ChangeKind }>[]>(() =>
    this.selectedFiles().files.map((file) => {
      const slash = file.path.lastIndexOf('/');
      return {
        id: file.path,
        label: slash === -1 ? file.path : file.path.slice(slash + 1),
        detail: slash === -1 ? undefined : file.path.slice(0, slash),
        data: file,
        icon: fileIcon(file.path),
        badge: file.kind,
        badgeTone: this.toneOf(file.kind),
        kind: 'leaf' as const,
        children: [],
      };
    }),
  );

  private readonly noGroups: ReadonlySet<string> = new Set();

  constructor() {
    // The log follows the project even when the change column is closed, so a
    // session switch is not left showing the previous project's history.
    effect(() => {
      const cwd = this.morse.workspace().cwd;
      if (cwd) {
        untracked(() => this.git.refresh());
      }
    });
    // Every time the visible repository changes, ask for its branch list.
    effect(() => {
      const repo = this.repo();
      if (repo !== undefined) {
        untracked(() => repo.loadBranches());
      }
    });
    // A repository switch — the picker or a project change — must not keep the
    // previous repository's selected commit.
    effect(() => {
      if (this.repo() !== undefined) {
        untracked(() => this.clearSelection());
      }
    });
  }

  protected pickRepo(path: string): void {
    this.query.set('');
    this.author.set('');
    this.chosenPath.set(path === (this.repo()?.info.path ?? '') ? this.chosenPath() : path);
  }

  protected onRepo(event: Event): void {
    this.pickRepo((event.target as HTMLSelectElement).value);
  }

  protected onFilterText(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected onFilterAuthor(event: Event): void {
    this.author.set((event.target as HTMLSelectElement).value);
  }

  protected isActiveRef(ref: string | undefined): boolean {
    return (this.logRef() ?? undefined) === ref;
  }

  /** Chooses the ref the history lists. `undefined` is HEAD's all-branch view. */
  protected selectRef(ref: string | undefined): void {
    const repo = this.repo();
    if (repo === undefined) {
      return;
    }
    this.clearSelection();
    repo.setLogRef(ref);
  }

  protected selectCommit(commit: GitCommit): void {
    const repo = this.repo();
    if (repo === undefined) {
      return;
    }
    const key = this.commitKey(repo, commit.hash);
    if (this.openKey() === key) {
      this.openKey.set(undefined);
      return;
    }
    this.openKey.set(key);
    const existing = this.fileState()[key];
    if (existing !== undefined && existing.error === undefined) {
      return;
    }
    this.fileState.update((map) => ({ ...map, [key]: { loading: true, files: [] } }));
    const repoPath = repo.info.path;
    void this.morse
      .requestHostCommand('gitCommitFiles', {
        hash: commit.hash,
        ...(repoPath.length > 0 ? { repo: repoPath } : {}),
      })
      .then((data) => {
        const files = asCommitFiles(data);
        if (files === undefined) {
          this.fileState.update((map) => ({
            ...map,
            [key]: { loading: false, files: [], error: 'Could not read this commit.' },
          }));
          return;
        }
        const views = files
          .map((file: GitFileStatus) => ({ path: file.path, kind: changeKind(file.status) }))
          .filter((file): file is { path: string; kind: ChangeKind } => file.kind !== undefined)
          .sort((a, b) => a.path.localeCompare(b.path));
        this.fileState.update((map) => ({ ...map, [key]: { loading: false, files: views } }));
      });
  }

  protected openFile(node: TreeNode<{ path: string; kind: ChangeKind }>): void {
    const repo = this.repo();
    const hash = this.selectedHash();
    const commit = this.filtered().find((entry) => entry.hash === hash);
    if (repo === undefined || hash === undefined || commit === undefined) {
      return;
    }
    this.tabs.openCommitFile(hash, node.data.path, commit.subject, repo.info.path || undefined);
  }

  protected isOpen(commit: GitCommit): boolean {
    const repo = this.repo();
    return repo !== undefined && this.openKey() === this.commitKey(repo, commit.hash);
  }

  protected onScroll(event: Event): void {
    const list = event.target as HTMLElement;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 600) {
      this.repo()?.loadMore();
    }
  }

  protected refresh(): void {
    this.git.refresh();
  }

  protected refLabel(ref: string): string {
    if (ref.startsWith('tag: ')) {
      return ref.slice(5);
    }
    const arrow = ref.indexOf(' -> ');
    return arrow === -1 ? ref : ref.slice(arrow + 4);
  }

  protected refKind(ref: string): 'head' | 'tag' | 'local' {
    if (ref.startsWith('tag: ')) {
      return 'tag';
    }
    return ref.includes('HEAD') ? 'head' : 'local';
  }

  protected when(iso: string): string {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) {
      return '';
    }
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h`;
    }
    return `${Math.round(hours / 24)}d`;
  }

  protected commitTitle(commit: GitCommit): string {
    return [
      commit.subject,
      '',
      ...commit.refs.map((ref) => this.refDetail(ref)),
      '',
      `${commit.author} · ${new Date(commit.date).toLocaleString()}`,
      commit.hash,
    ].join('\n');
  }

  protected repoLabel(repo: GitRepoState): string {
    return repo.info.current ? repo.info.name || 'This project' : repo.info.name;
  }

  private refDetail(ref: string): string {
    if (ref.startsWith('tag: ')) {
      return `tag ${ref.slice(5)}`;
    }
    const arrow = ref.indexOf(' -> ');
    return arrow === -1 ? ref : `HEAD → ${ref.slice(arrow + 4)}`;
  }

  private commitKey(repo: GitRepoState, hash: string): string {
    return `${repo.info.path}\u0000${hash}`;
  }

  private clearSelection(): void {
    this.openKey.set(undefined);
    this.fileState.set({});
  }

  private toneOf(kind: ChangeKind): TreeNode<unknown>['badgeTone'] {
    switch (kind) {
      case 'M':
        return 'warn';
      case 'A':
      case 'U':
        return 'success';
      case 'D':
      case 'C':
        return 'error';
      case 'R':
        return 'info';
      default:
        return 'plain';
    }
  }

  protected x(lane: number): number {
    return lane * LANE_WIDTH + LANE_WIDTH / 2;
  }

  protected y(value: number): number {
    return value * ROW_HEIGHT;
  }

  protected color(index: number): string {
    return PALETTE[index % PALETTE.length]!;
  }

  protected path(edge: GraphEdge): string {
    const x1 = this.x(edge.fromLane);
    const y1 = this.y(edge.fromY);
    const x2 = this.x(edge.toLane);
    const y2 = this.y(edge.toY);
    if (x1 === x2) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }

  protected rowColor(row: GraphRow): string {
    return this.color(row.color);
  }

  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly expanded = this.noGroups;
}
