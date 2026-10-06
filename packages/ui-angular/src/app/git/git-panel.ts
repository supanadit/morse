import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { GitCommit } from '@morse/protocol';
import { MorseService } from '../core/morse.service';
import { ShellState } from '../core/shell-state';
import { GitPanelState } from '../core/git-panel-state';
import { layoutGraph, type GraphEdge, type GraphRow } from '../core/git-graph';
import {
  asCommitFiles,
  changeKind,
  isStaged,
  isUnstaged,
  stagedKind,
  unstagedKind,
  type ChangeKind,
} from '../core/git-status';
import { BranchPicker } from './branch-picker/branch-picker';
import { WorkspaceFiles } from '../core/workspace-files';
import { WorkspaceTabs } from '../core/workspace-tabs';

/** One uncommitted file, ready for the Changes section. */
interface ChangeView {
  path: string;
  kind: ChangeKind;
}

/** One file a commit touched, ready for the graph's expanded row. */
interface CommitFileView {
  path: string;
  kind: ChangeKind;
}

/** The lazily-loaded file list of one expanded commit. */
interface CommitFilesState {
  loading: boolean;
  files: CommitFileView[];
  error?: string;
}

/** Lane colours, drawn from the theme's chart palette so both themes read well. */
const PALETTE = [
  'var(--morse-accent)',
  'var(--morse-success)',
  'var(--morse-number)',
  'var(--morse-typename)',
  'var(--morse-keyword)',
  'var(--morse-info)',
  'var(--morse-warn)',
];

/** One lane is 16px wide; a row is one commit and the graph height around it. */
const LANE_WIDTH = 16;
const ROW_HEIGHT = 32;
/** Dragging the panel's left edge keeps at least this much conversation visible. */
const GIT_RESIZE_MIN_CHAT = 180;

/**
 * The browser host's git panel: the active project's recent commits and their
 * branch graph. VS Code has Source Control and leaves `capabilities.gitPanel`
 * off, so this never renders there; the browser host turns it on and answers the
 * `gitLog` command.
 *
 * The graph is a pure layout (`core/git-graph.ts`) turned into an SVG per row;
 * the panel itself only fetches, formats and scrolls.
 */
@Component({
  selector: 'morse-git-panel',
  templateUrl: './git-panel.html',
  imports: [BranchPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      /*
       * A block with the header pinned on top and the list filling the rest:
       * both children are absolutely positioned against this box, so the list's
       * height is the panel's own height and it scrolls on its own — no reliance
       * on a flex chain being height-constrained by the grid.
       */
      :host {
        position: relative;
        display: block;
        min-width: 0;
        min-height: 0;
        height: 100%;
        overflow: hidden;
        border-left: 1px solid var(--morse-border);
        background: var(--morse-nav-bg);
      }
      /*
       * The panel's left edge is a drag handle: pulling it toward the conversation
       * widens the graph instead of forcing the full-screen toggle. The seam only
       * lights up on hover, so the two columns stay quiet at rest.
       */
      .edge-resize {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 6px;
        z-index: 3;
        cursor: ew-resize;
      }
      .edge-resize:hover,
      .edge-resize:active {
        background: color-mix(in srgb, var(--morse-accent) 45%, transparent);
      }
      /*
       * A drag in progress: no hover hit-testing under the pointer, and the
       * graph's flow stands still — that is what keeps the resize light.
       */
      .panel.resizing .body {
        pointer-events: none;
      }
      .panel.resizing .graph path.flow {
        animation: none;
      }
      .head {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: var(--morse-head-height);
        padding: 0 6px 0 10px;
        border-bottom: 1px solid var(--morse-border);
        background: var(--morse-nav-bg);
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12.5px;
        font-weight: 600;
      }
      .brand svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.3;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      /*
       * One compact chip for the header branch and the commit decorations: a
       * uniform subtle background, and the kind carried by the text colour only.
       * Filling each kind with its own colour made the HEAD chip look bulky and
       * inconsistent with the others.
       */
      .branch,
      .ref {
        flex: none;
        padding: 0 6px;
        border-radius: 4px;
        font-family: var(--morse-font-mono);
        font-size: 10px;
        line-height: 16px;
        background: color-mix(in srgb, var(--morse-fg-muted) 12%, transparent);
        color: var(--morse-fg-muted);
      }
      /*
       * A long branch name must not crowd out the hash and the age: the chip is
       * capped and ellipsised, with its full name one hover away (the title). The
       * expanded view has room, so it shows more of it.
       */
      .branch,
      .ref {
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .commit.expanded .ref {
        max-width: 240px;
      }
      .branch,
      .ref.kind-head {
        color: var(--morse-accent);
      }
      .ref.kind-local {
        color: var(--morse-success);
      }
      .ref.kind-tag {
        color: var(--morse-typename);
      }
      /* The branch chip is a button now: it opens the switcher. */
      .branch-host {
        position: relative;
        display: inline-flex;
        flex: none;
        min-width: 0;
      }
      button.branch {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: 1px solid transparent;
        background: color-mix(in srgb, var(--morse-fg-muted) 12%, transparent);
        cursor: pointer;
      }
      button.branch:hover:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      button.branch:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .branch-caret {
        flex: none;
        font-size: 9px;
        line-height: 1;
        opacity: 0.7;
      }
      .grow {
        flex: 1;
      }
      .icon {
        flex: none;
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid transparent;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
      }
      .icon:hover {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .icon svg {
        width: 15px;
        height: 15px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.3;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .count {
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      /* The area under the header is a column: changes on top, history below. */
      .body {
        position: absolute;
        top: var(--morse-head-height);
        right: 0;
        bottom: 0;
        left: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      /* Branch distance and the pull/push controls, once for the whole panel. */
      .sync {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 28px;
        padding: 0 4px 0 10px;
        border-bottom: 1px solid var(--morse-border);
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .sync-counts {
        flex: none;
        display: inline-flex;
        gap: 6px;
        font-family: var(--morse-font-mono);
      }
      /* A count of zero is context; a count above zero is the call to action. */
      .sync-arrow {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        opacity: 0.5;
      }
      .sync-arrow.on {
        opacity: 1;
        color: var(--morse-accent);
      }
      .sync-upstream {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--morse-font-mono);
        font-size: 10px;
      }
      /* The commit message and its button, above the changes it commits. */
      .commit-box {
        flex: none;
        display: flex;
        gap: 6px;
        padding: 6px 8px 6px 10px;
        border-bottom: 1px solid var(--morse-border);
      }
      .commit-input {
        flex: 1;
        min-width: 0;
        padding: 5px 8px;
        border: 1px solid var(--morse-input-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-input-bg);
        color: var(--morse-input-fg);
        font: inherit;
        font-size: 12px;
      }
      .commit-button {
        flex: none;
        padding: 5px 10px;
        border: 1px solid var(--morse-accent);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-accent);
        color: #fff;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .commit-button:hover:not(:disabled) {
        filter: brightness(1.08);
      }
      .commit-button:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .commit-error {
        flex: none;
        margin: 0;
        padding: 4px 10px 6px;
        color: var(--morse-error);
        font-size: 11px;
        line-height: 1.4;
      }
      .changes {
        flex: none;
        height: 45%;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        overflow-x: hidden;
      }
      /* Folded: just its header. History folded: the changes take the column. */
      .body.changes-collapsed .changes,
      .body.history-collapsed .changes {
        height: auto;
      }
      .body.history-collapsed .changes {
        flex: 1;
      }
      .divider {
        flex: none;
        position: relative;
        height: 5px;
        border-top: 1px solid var(--morse-border);
        background: transparent;
        cursor: ns-resize;
      }
      .divider:hover {
        border-top-color: var(--morse-accent);
        background: color-mix(in srgb, var(--morse-accent) 30%, transparent);
      }
      /* A 5px line is a thin target; the overlay gives it a forgiving hit area. */
      .divider::after {
        content: '';
        position: absolute;
        inset: -3px 0;
      }
      .divider.gone {
        display: none;
      }
      .history {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .body.history-collapsed .history {
        flex: none;
      }
      .section-head {
        display: flex;
        flex: none;
        align-items: center;
      }
      .section-toggle {
        display: flex;
        align-items: center;
        gap: 5px;
        flex: 1;
        min-width: 0;
        padding: 5px 10px;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .section-toggle:hover {
        background: var(--morse-hover);
      }
      .chevron {
        flex: none;
        display: inline-block;
        color: var(--morse-fg-muted);
        font-size: 11px;
        line-height: 1;
        transition: transform 120ms ease;
      }
      .chevron.open {
        transform: rotate(90deg);
      }
      .section-title {
        font-size: 10.5px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--morse-fg-muted);
      }
      .section-count {
        font-size: 10.5px;
        color: var(--morse-fg-muted);
      }
      .change-group {
        display: flex;
        flex-direction: column;
      }
      .change-group + .change-group {
        border-top: 1px solid var(--morse-border);
      }
      /* A quiet sub-heading naming which side of the porcelain code the rows are. */
      .change-group-head {
        display: flex;
        align-items: center;
        gap: 5px;
        /* Right padding matches a row's action margin, so the group's +/− lines up
           with the per-file +/− under it. */
        padding: 4px 6px 3px 10px;
        color: var(--morse-fg-muted);
        font-size: 10.5px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .change-group-head:hover {
        background: var(--morse-hover);
      }
      /* The title area folds its group; the header's own action stays outside it. */
      .group-toggle {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        padding: 0;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      /* Wins over the global button hover (see AGENTS.md): the row owns the hover. */
      .group-toggle:hover:not(:disabled) {
        background: none;
        color: var(--morse-fg);
      }
      .change-group-count {
        font-size: 10.5px;
        color: var(--morse-fg-muted);
      }
      /* The Staged group is always present; an empty one says what to do next. */
      .change-empty {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        padding: 2px 10px 8px;
        color: var(--morse-fg-muted);
        font-size: 11.5px;
      }
      /* Reserves the status-badge column so the note lines up with a row's path. */
      .change-empty::before {
        content: '';
        flex: none;
        width: 14px;
      }
      /* Fold/unfold all of a group's paths at once. */
      .group-action,
      .change-action {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font: inherit;
        line-height: 1;
        cursor: pointer;
      }
      .group-action {
        width: 20px;
        height: 20px;
        font-size: 14px;
        text-transform: none;
      }
      .group-action:hover:not(:disabled) {
        background: var(--morse-border);
        color: var(--morse-fg);
      }
      .change-list {
        margin: 0;
        padding: 0 0 6px;
        list-style: none;
      }
      .change-row {
        display: flex;
        align-items: center;
        gap: 2px;
      }
      .change {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
        min-width: 0;
        padding: 2px 2px 2px 10px;
        border: 0;
        background: none;
        color: var(--morse-fg);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .change:hover:not(:disabled) {
        background: var(--morse-hover);
      }
      /* The stage/unstage affordance is quiet until the row is under the pointer. */
      .change-action {
        width: 20px;
        height: 20px;
        margin-right: 6px;
        font-size: 13px;
        opacity: 0;
      }
      .change-row:hover .change-action,
      .change-action:focus-visible {
        opacity: 1;
      }
      .change-action:hover:not(:disabled) {
        background: var(--morse-border);
        color: var(--morse-fg);
      }
      .change-action:disabled,
      .group-action:disabled {
        opacity: 0.35;
        cursor: default;
      }
      .change-dir {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .change-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }
      /*
       * An empty section is not a sentence in the corner: a centred, gently
       * animated mark says "nothing to do" before the text does.
       */
      .empty {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 16px;
        color: var(--morse-fg-muted);
        font-size: 11.5px;
        text-align: center;
      }
      .mark {
        position: relative;
        display: inline-grid;
        place-items: center;
        width: 38px;
        height: 38px;
        animation: mark-breathe 2.8s ease-in-out infinite;
      }
      .mark svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .mark .ring {
        stroke: color-mix(in srgb, var(--morse-fg-muted) 40%, transparent);
        stroke-width: 1.4;
      }
      .mark .check {
        stroke: var(--morse-success);
        stroke-width: 2;
        stroke-dasharray: 20;
        stroke-dashoffset: 20;
        animation: check-draw 900ms ease-out 120ms forwards;
      }
      .mark.node .line {
        stroke: color-mix(in srgb, var(--morse-fg-muted) 35%, transparent);
        stroke-width: 1.4;
      }
      .mark.node .dot {
        stroke: var(--morse-accent);
        stroke-width: 1.6;
        transform-box: fill-box;
        transform-origin: center;
        animation: node-pulse 2.8s ease-in-out infinite;
      }
      /* A soft ping leaving the mark, so "ready" reads as alive, not stuck. */
      .mark::after {
        content: '';
        position: absolute;
        inset: -4px;
        border-radius: 50%;
        border: 1px solid color-mix(in srgb, var(--morse-success) 45%, transparent);
        animation: mark-ping 2.8s ease-out infinite;
      }
      .mark.node::after {
        border-color: color-mix(in srgb, var(--morse-accent) 45%, transparent);
      }
      @keyframes mark-breathe {
        0%,
        100% {
          transform: scale(0.95);
        }
        50% {
          transform: scale(1.05);
        }
      }
      @keyframes check-draw {
        to {
          stroke-dashoffset: 0;
        }
      }
      @keyframes node-pulse {
        0%,
        100% {
          transform: scale(0.7);
          opacity: 0.6;
        }
        50% {
          transform: scale(1.15);
          opacity: 1;
        }
      }
      @keyframes mark-ping {
        0% {
          transform: scale(0.85);
          opacity: 0.7;
        }
        70%,
        100% {
          transform: scale(1.35);
          opacity: 0;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .mark,
        .mark::after {
          animation: none;
        }
        .mark .check {
          animation: none;
          stroke-dashoffset: 0;
        }
        .mark.node .dot {
          animation: none;
        }
      }
      /* The git badge, shared with the Explorer: one letter, coloured by kind. */
      .badge {
        flex: none;
        padding: 0 4px;
        border-radius: 4px;
        font-family: var(--morse-font-mono);
        font-size: 9.5px;
        line-height: 15px;
        color: var(--morse-fg-muted);
      }
      .badge.M {
        color: var(--morse-warn);
      }
      .badge.A,
      .badge.U {
        color: var(--morse-success);
      }
      .badge.D,
      .badge.C {
        color: var(--morse-error);
      }
      .badge.R {
        color: var(--morse-info);
      }
      /* The graph list fills the rest and is the other scroll area. */
      .list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        margin: 0;
        padding: 2px 0 10px;
        list-style: none;
      }
      .hint {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 12px;
        color: var(--morse-fg-muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .hint.error {
        color: var(--morse-error);
      }
      /* The footer of the loaded range: a hint to scroll, or the root commit. */
      .more {
        padding: 10px 12px;
        color: var(--morse-fg-muted);
        font-size: 11px;
        text-align: center;
      }
      /* One line per commit, so the list reads as a stream, not a stack of cards. */
      .commit {
        display: block;
      }
      /* The row itself is the click target: it unfolds the commit's file list. */
      .commit-row {
        display: flex;
        flex-wrap: nowrap;
        align-items: center;
        gap: 8px;
        height: 32px;
        padding-right: 8px;
        cursor: pointer;
      }
      .commit-row:hover {
        background: var(--morse-hover);
      }
      .commit-row:focus-visible {
        outline: 1px solid var(--morse-focus);
        outline-offset: -1px;
      }
      .commit-chevron {
        flex: none;
        display: inline-block;
        color: var(--morse-fg-muted);
        font-size: 11px;
        line-height: 1;
        transition: transform 120ms ease;
      }
      .commit-chevron.open {
        transform: rotate(90deg);
      }
      /* The files a commit touched, under its row. */
      .commit-files {
        position: relative;
        padding-bottom: 6px;
      }
      /* Keeps every lane that survives the commit drawn across the extra height. */
      .commit-rail {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
      .rail {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1.7px;
        transform: translateX(-50%);
        border-radius: 1px;
        opacity: 0.9;
      }
      .commit-file-list {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .commit-file {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 2px 10px 2px 44px;
        border: 0;
        background: none;
        color: var(--morse-fg);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .commit-file:hover:not(:disabled) {
        background: var(--morse-hover);
      }
      .commit-file-hint {
        margin: 0;
        padding: 2px 12px 6px 44px;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .commit-file-hint.error {
        color: var(--morse-error);
      }
      /*
       * One SVG per row, stacked with no gap: a lane reads as one continuous line
       * and the curves join across rows.
       */
      .graph {
        flex: none;
        display: block;
        overflow: visible;
      }
      .graph path {
        fill: none;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .graph circle {
        stroke: var(--morse-nav-bg);
        stroke-width: 1.6;
      }
      /*
       * A light dash travelling down each lane: the graph reads as flow, not a
       * static diagram. Same path as the lane, drawn over it with an animated
       * dash offset so the pulse keeps its direction across stacked rows.
       */
      .graph path.flow {
        stroke: var(--morse-fg);
        stroke-dasharray: 5 15;
        stroke-linecap: round;
        opacity: 0.35;
        animation: graph-flow 1.4s linear infinite;
      }
      @keyframes graph-flow {
        to {
          stroke-dashoffset: -20;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .graph path.flow {
          animation: none;
          opacity: 0;
        }
      }
      .subject {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12.5px;
        color: var(--morse-fg);
      }
      .refs {
        flex: 0 1 auto;
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
      }
      .grow {
        flex: 1;
        min-width: 8px;
      }
      .meta {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--morse-fg-muted);
        font-size: 11px;
        white-space: nowrap;
      }
      .hash {
        font-family: var(--morse-font-mono);
      }
      /* The author is noise at sidebar width; the expanded view has room for it. */
      .author {
        display: none;
        max-width: 170px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .commit.expanded .author {
        display: inline;
      }
      .sep {
        opacity: 0.5;
      }
      .copy {
        flex: none;
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 11px;
        cursor: pointer;
        opacity: 0;
      }
      .commit-row:hover .copy {
        opacity: 1;
      }
      .copy:hover:not(:disabled) {
        background: var(--morse-border);
        color: var(--morse-fg);
      }
    `,
  ],
})
export class GitPanel {
  /** Expanded: the panel spans the conversation area, for a wide graph. */
  readonly expanded = input(false);

  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly git = inject(GitPanelState);
  private readonly workspace = inject(WorkspaceFiles);
  private readonly tabs = inject(WorkspaceTabs);

  protected readonly commits = this.git.commits;
  protected readonly branch = this.git.branch;
  protected readonly root = this.git.root;
  protected readonly isRepo = this.git.isRepo;
  protected readonly loading = this.git.loading;
  protected readonly loaded = this.git.loaded;
  protected readonly hasMore = this.git.hasMore;
  protected readonly error = this.git.error;
  protected readonly changesCollapsed = this.shell.gitChangesCollapsed;
  protected readonly historyCollapsed = this.shell.gitHistoryCollapsed;
  /** Each change group folds on its own, the way VS Code's Source Control does. */
  protected readonly stagedCollapsed = this.shell.gitStagedCollapsed;
  protected readonly unstagedCollapsed = this.shell.gitUnstagedCollapsed;
  private readonly changesHeight = this.shell.gitChangesHeight;
  /** True while a stage/unstage round trip is in flight, so the rows stay quiet. */
  protected readonly staging = signal(false);
  /**
   * The uncommitted changes, from the shared working-tree poll, split the way
   * `git status` does: the index (`X`) is Staged Changes, the working tree (`Y`)
   * is Changes. A path edited in both sides (`MM`) appears in both lists.
   */
  protected readonly staged = computed<ChangeView[]>(() => this.changesFor('staged'));
  protected readonly unstaged = computed<ChangeView[]>(() => this.changesFor('unstaged'));
  /** Distinct changed paths, so a file edited on both sides counts once. */
  protected readonly changedCount = computed(() => {
    const status = this.workspace.status();
    return status?.isRepo ? status.files.length : 0;
  });
  /** A commit needs a message and something staged, and only one at a time. */
  protected readonly canCommit = computed(
    () => this.commitMessage().trim().length > 0 && this.staged().length > 0 && !this.committing(),
  );

  private changesFor(side: 'staged' | 'unstaged'): ChangeView[] {
    const status = this.workspace.status();
    if (status === undefined || !status.isRepo) {
      return [];
    }
    const changes: ChangeView[] = [];
    for (const file of status.files) {
      const wanted = side === 'staged' ? isStaged(file.status) : isUnstaged(file.status);
      if (!wanted) {
        continue;
      }
      const kind = side === 'staged' ? stagedKind(file.status) : unstagedKind(file.status);
      if (kind !== undefined) {
        changes.push({ path: file.path, kind });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }
  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly copied = signal<string | undefined>(undefined);
  /** How far the branch is from its upstream, and its pull/push controls. */
  protected readonly ahead = this.git.ahead;
  protected readonly behind = this.git.behind;
  protected readonly upstream = this.git.upstream;
  protected readonly syncing = this.git.syncingNow;
  protected readonly syncLabel = computed(() => {
    const upstream = this.upstream();
    if (upstream === undefined) {
      return 'No upstream branch to pull from or push to';
    }
    return `${upstream}: ${this.behind()} to pull, ${this.ahead()} to push`;
  });
  /** The branches the picker lists, and the state of a commit/checkout. */
  protected readonly branches = this.git.branches;
  protected readonly switching = this.git.switching;
  protected readonly committing = this.git.committing;
  protected readonly notice = this.git.notice;
  /** Whether the branch picker is open; the panel owns that, not the picker. */
  protected readonly branchOpen = signal(false);
  /** The commit message being typed; Enter or the Commit button sends it. */
  protected readonly commitMessage = signal('');
  /** The commit whose file list is unfolded; `undefined` when all are folded. */
  protected readonly openCommit = signal<string | undefined>(undefined);
  /** The file list of each commit that was unfolded, kept so re-opening is free. */
  private readonly commitFiles = signal<Record<string, CommitFilesState>>({});

  /** The graph layout and its commits, paired so the template walks one list. */
  protected readonly entries = computed(() => {
    const commits = this.commits();
    const layout = layoutGraph(commits);
    // A commit two branches point at must not stack two long chips in a sidebar
    // row: show the first (the HEAD or branch ref) and fold the rest into `+N`,
    // whose title names them. The expanded view has room for more.
    const maxRefs = this.expanded() ? 3 : 1;
    return {
      laneCount: layout.laneCount,
      rows: layout.rows.map((row, index) => {
        const commit = commits[index]!;
        const refs = commit.refs.slice(0, maxRefs);
        const rest = commit.refs.slice(maxRefs);
        return {
          row,
          commit,
          refs,
          moreRefs: rest.length,
          restTitle: rest.map((ref) => this.refLabel(ref)).join(', '),
        };
      }),
    };
  });
  protected readonly graphWidth = computed(() =>
    Math.max(1, this.entries().laneCount) * LANE_WIDTH,
  );

  constructor() {
    // The panel follows the project: opening it, or switching to a session in
    // another directory, reloads the history. Closed, it costs nothing.
    effect(() => {
      if (!this.shell.gitPanelOpen()) {
        return;
      }
      const cwd = this.morse.workspace().cwd;
      if (!cwd) {
        return;
      }
      this.git.refresh();
    });
  }

  protected refresh(): void {
    this.git.refresh();
  }

  /** Pulls the upstream; the graph and the distance are re-read afterwards. */
  protected pull(): void {
    void this.git.pull();
  }

  /** Pushes the branch; the graph and the distance are re-read afterwards. */
  protected push(): void {
    void this.git.push();
  }

  /** Opens the branch switcher, reading the branch list on the way in. */
  protected toggleBranchPicker(): void {
    if (this.branchOpen()) {
      this.branchOpen.set(false);
      return;
    }
    this.git.loadBranches();
    this.branchOpen.set(true);
  }

  protected closeBranchPicker(): void {
    this.branchOpen.set(false);
  }

  /** Switches to an existing branch (a remote name checks out its local twin). */
  protected pickBranch(branch: string): void {
    this.branchOpen.set(false);
    void this.git.checkout(branch, false);
  }

  /** Creates a branch and switches to it in one step. */
  protected createBranch(branch: string): void {
    this.branchOpen.set(false);
    void this.git.checkout(branch, true);
  }

  /** Checks out a tag or commit directly; git leaves HEAD detached. */
  protected detachRef(ref: string): void {
    this.branchOpen.set(false);
    void this.git.checkout(ref, false);
  }

  protected onCommitMessage(event: Event): void {
    this.commitMessage.set((event.target as HTMLInputElement).value);
  }

  /** Commits what is staged; the message clears only when git accepted it. */
  protected submitCommit(): void {
    const message = this.commitMessage().trim();
    if (message.length === 0 || this.committing()) {
      return;
    }
    // Enter in the message box goes through here too, so the button's own guard
    // is repeated: nothing staged is not a commit, and saying so beats asking git
    // and showing its raw refusal.
    if (this.staged().length === 0) {
      this.git.refuse('Nothing is staged to commit. Stage a change first.');
      return;
    }
    void this.git.commit(message).then((ok) => {
      if (ok) {
        this.commitMessage.set('');
      }
    });
  }

  /** Whether a commit's file list is unfolded. */
  protected isCommitOpen(hash: string): boolean {
    return this.openCommit() === hash;
  }

  /** A commit's file list, empty until it is unfolded and loaded. */
  protected commitState(hash: string): CommitFilesState {
    return this.commitFiles()[hash] ?? { loading: false, files: [] };
  }

  /**
   * Unfolds a commit row to its changed files, folding the previous one. The
   * list is read once (`gitCommitFiles`) and kept, so re-opening is free.
   */
  protected toggleCommit(hash: string): void {
    if (this.openCommit() === hash) {
      this.openCommit.set(undefined);
      return;
    }
    this.openCommit.set(hash);
    const existing = this.commitFiles()[hash];
    if (existing !== undefined && existing.error === undefined) {
      return;
    }
    this.commitFiles.update((map) => ({
      ...map,
      [hash]: { loading: true, files: [] },
    }));
    void this.morse.requestHostCommand('gitCommitFiles', { hash }).then((data) => {
      const files = asCommitFiles(data);
      if (files === undefined) {
        this.commitFiles.update((map) => ({
          ...map,
          [hash]: { loading: false, files: [], error: 'Could not read this commit.' },
        }));
        return;
      }
      const views: CommitFileView[] = [];
      for (const file of files) {
        const kind = changeKind(file.status);
        if (kind !== undefined) {
          views.push({ path: file.path, kind });
        }
      }
      views.sort((a, b) => a.path.localeCompare(b.path));
      this.commitFiles.update((map) => ({
        ...map,
        [hash]: { loading: false, files: views },
      }));
    });
  }

  /** Opens one file's diff inside that commit, in its own preview tab. */
  protected openCommitChange(hash: string, path: string, subject: string): void {
    this.tabs.openCommitFile(hash, path, subject);
  }

  /**
   * Lazy paging: near the end of what is loaded, ask for the next page, so the
   * list walks all the way back to the root commit as the reader scrolls.
   */
  protected onScroll(event: Event): void {
    const list = event.target as HTMLElement;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 600) {
      this.git.loadMore();
    }
  }

  protected close(): void {
    this.shell.closeGitPanel();
  }

  /** Opens a changed file in a preview tab, the way the Explorer does. */
  protected openChange(path: string): void {
    this.tabs.openFile(path);
  }

  /** Moves one path into the index (`git add`). */
  protected stage(path: string): void {
    void this.runStage([path]);
  }

  /** Takes one path back out of the index, keeping the working-tree change. */
  protected unstage(path: string): void {
    void this.runUnstage([path]);
  }

  /** Every unstaged path into the index at once. */
  protected stageAll(): void {
    void this.runStage(this.unstaged().map((change) => change.path));
  }

  /** Every staged path back out of the index at once. */
  protected unstageAll(): void {
    void this.runUnstage(this.staged().map((change) => change.path));
  }

  private async runStage(paths: string[]): Promise<void> {
    if (paths.length === 0 || this.staging()) {
      return;
    }
    this.staging.set(true);
    try {
      await this.workspace.stage(paths);
    } finally {
      this.staging.set(false);
    }
  }

  private async runUnstage(paths: string[]): Promise<void> {
    if (paths.length === 0 || this.staging()) {
      return;
    }
    this.staging.set(true);
    try {
      await this.workspace.unstage(paths);
    } finally {
      this.staging.set(false);
    }
  }

  /** The directory part of a path, with its trailing slash, for the muted label. */
  protected dirOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? '' : path.slice(0, slash + 1);
  }

  protected baseOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? path : path.slice(slash + 1);
  }

  /** Wide mode: the graph leaves the sidebar and takes the centre of the shell. */
  protected toggleExpanded(): void {
    this.shell.toggleGitPanelExpanded();
  }

  protected toggleChanges(): void {
    this.shell.toggleGitChanges();
  }

  protected toggleHistory(): void {
    this.shell.toggleGitHistory();
  }

  /** Folds the Staged group's rows under its header, leaving the header in place. */
  protected toggleStaged(): void {
    this.shell.toggleGitStaged();
  }

  /** Folds the Unstaged group's rows under its header, leaving the header in place. */
  protected toggleUnstaged(): void {
    this.shell.toggleGitUnstaged();
  }

  /** The inline height only while both sections are open; otherwise CSS decides. */
  protected changesHeightPx(): number | null {
    if (this.changesCollapsed() || this.historyCollapsed()) {
      return null;
    }
    return this.changesHeight() ?? null;
  }

  /**
   * Drag the divider to size the Changes section. The height is measured from the
   * section column's own top, and the History keeps at least 80px so it cannot be
   * squeezed out of existence.
   */
  protected startResize(event: PointerEvent): void {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const body = handle.parentElement;
    if (!body) {
      return;
    }
    /*
     * The height belongs to the Changes section, which is the divider's own
     * previous sibling — not to the body. The body also holds the sync bar and
     * the commit box above Changes, so measuring from the body's top made the
     * divider jump down by exactly that offset the moment the drag started.
     * The grab point is folded in too (start height + pointer delta), so the
     * divider stays under the cursor wherever the handle was grabbed.
     */
    const changes = (handle.previousElementSibling as HTMLElement | null) ?? body;
    const top = changes.getBoundingClientRect().top;
    const bottom = body.getBoundingClientRect().bottom;
    const startY = event.clientY;
    const startHeight = changes.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    let frame = 0;
    let pending = startHeight;
    const apply = (): void => {
      frame = 0;
      this.shell.setGitChangesHeight(pending, false);
    };
    const move = (moveEvent: PointerEvent): void => {
      pending = Math.min(bottom - top - 80, startHeight + (moveEvent.clientY - startY));
      if (frame === 0) {
        frame = requestAnimationFrame(apply);
      }
    };
    const stop = (): void => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        apply();
      }
      // Write the choice once, when the drag ends, not on every frame.
      this.shell.setGitChangesHeight(pending);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  /**
   * Drag the panel's left edge to size it against the conversation. The grid
   * column is what changes, so pulling left (a negative delta) widens the panel,
   * and the drag leaves full mode first or the column would not follow. At least
   * 180px of conversation stays visible, so the chat never vanishes by accident —
   * the expand button is still the way to hand the graph everything.
   */
  protected startWidthResize(event: PointerEvent): void {
    event.preventDefault();
    if (this.shell.gitPanelExpanded()) {
      this.shell.toggleGitPanelExpanded();
    }
    const handle = event.currentTarget as HTMLElement;
    const panel = handle.parentElement;
    const startX = event.clientX;
    const startWidth = panel?.getBoundingClientRect().width ?? 340;
    const shell = handle.closest('.shell') as HTMLElement | null;
    const nav = shell?.querySelector('.nav') as HTMLElement | null;
    const shellWidth = shell?.getBoundingClientRect().width ?? window.innerWidth;
    const navWidth = this.shell.navigationCollapsed()
      ? 0
      : (nav?.getBoundingClientRect().width ?? 240);
    const max = Math.max(320, shellWidth - navWidth - GIT_RESIZE_MIN_CHAT);
    handle.setPointerCapture(event.pointerId);
    /*
     * Resizing has to follow the pointer, not the shell's 160ms column
     * transition: retargeting that animation on every move made the drag feel
     * heavy. It is also frame-coalesced, so one layout runs per paint, and the
     * graph's flow is paused because repainting hundreds of animated dashes
     * during a resize is the other half of the cost.
     */
    shell?.style.setProperty('transition', 'none');
    panel?.classList.add('resizing');
    let frame = 0;
    let pending = this.shell.gitPanelWidth() ?? Math.round(startWidth);
    const apply = (): void => {
      frame = 0;
      this.shell.setGitPanelWidth(pending, false);
    };
    const move = (moveEvent: PointerEvent): void => {
      pending = Math.min(max, startWidth + (startX - moveEvent.clientX));
      if (frame === 0) {
        frame = requestAnimationFrame(apply);
      }
    };
    const stop = (): void => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        apply();
      }
      shell?.style.removeProperty('transition');
      panel?.classList.remove('resizing');
      // Write the choice once, when the drag ends, not on every frame.
      this.shell.setGitPanelWidth(pending);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  /** Double-clicking the edge restores the default column width. */
  protected resetWidth(): void {
    this.shell.resetGitPanelWidth();
  }

  /** `HEAD -> main`, `tag: v1.0` and `origin/main` each read their own way. */
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

  /** `12s` / `5m` / `3h` / `2d`, matching the sidebar's session ages. */
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

  /**
   * The hover tooltip for a commit row: the full subject the sidebar trims with
   * an ellipsis, every ref including the ones folded into `+N`, and the identity
   * (author, exact time, hash) git shows. A native `title`, so the browser owns
   * the placement and the panel needs no overlay of its own.
   */
  protected commitTitle(commit: GitCommit): string {
    const lines = [commit.subject];
    if (commit.refs.length > 0) {
      lines.push('', ...commit.refs.map((ref) => this.refDetail(ref)));
    }
    lines.push('', `${commit.author} · ${this.exactTime(commit.date)}`, commit.hash);
    return lines.join('\n');
  }

  /** `HEAD -> main`, `tag: v1.0`, `origin/main` spelled out for the tooltip. */
  private refDetail(ref: string): string {
    if (ref.startsWith('tag: ')) {
      return `tag ${ref.slice(5)}`;
    }
    const arrow = ref.indexOf(' -> ');
    return arrow === -1 ? ref : `HEAD → ${ref.slice(arrow + 4)}`;
  }

  /** The exact commit time, in the viewer's locale — `when` only says "9h". */
  private exactTime(iso: string): string {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
  }

  protected async copy(commit: GitCommit): Promise<void> {
    try {
      await navigator.clipboard.writeText(commit.hash);
      this.copied.set(commit.hash);
      setTimeout(() => {
        if (this.copied() === commit.hash) {
          this.copied.set(undefined);
        }
      }, 1_200);
    } catch {
      // A host without clipboard access simply does not offer the affordance.
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

  /** An edge is a straight line within a lane, or a smooth S into/out of a node. */
  protected path(edge: GraphEdge): string {
    const x1 = this.x(edge.fromLane);
    const y1 = this.y(edge.fromY);
    const x2 = this.x(edge.toLane);
    const y2 = this.y(edge.toY);
    if (x1 === x2) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    // A lane change is a cubic whose control points sit halfway, so the line
    // leaves and arrives vertically — a flow, not a right-angled detour.
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }

  /**
   * The lanes that continue *below* a commit's row: every edge that leaves its
   * row at the bottom. An expanded file list pushes the next row down, so the
   * graph must draw these lanes across the extra height or the line looks cut.
   */
  protected continuing(row: GraphRow): GraphEdge[] {
    return row.edges.filter((edge) => edge.toY === 1);
  }

  protected rowColor(row: GraphRow): string {
    return this.color(row.color);
  }
}
