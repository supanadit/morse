/** The search panel: matches grouped by file, each line with its numbers and window. */

export interface WorkspaceSearchLine {
  /** One-based line number, so a click can open the file at the match. */
  line: number;
  /**
   * The line's text: whole when it is short, a window around the first match
   * when it is not (a minified bundle is not a preview).
   */
  text: string;
  /**
   * One-based columns of every match inside `text`, for the highlights — all
   * matches on the line are counted even though the row draws them together.
   */
  columns: number[];
}

/** One file's matches, as the search panel groups them. */
export interface WorkspaceSearchFile {
  /** Path relative to the project, with `/` separators (like `listFiles`). */
  path: string;
  /** The matching lines, in line order. */
  lines: WorkspaceSearchLine[];
  /**
   * All matches found in the file — at least the sum of `columns`, more when a
   * line was left out because a cap filled up elsewhere.
   */
  count: number;
}

/** What the `searchWorkspace` host command answers. */
export interface WorkspaceSearchResult {
  /** Matching files sorted by path, so two searches draw the same order. */
  files: WorkspaceSearchFile[];
  /** Total matches across the project; capped where `truncated` is set. */
  total: number;
  /** True when a result cap ended the search early — a narrower query will say more. */
  truncated: boolean;
  /**
   * Which engine answered: `ripgrep` when the host found `rg` on PATH, `node`
   * for the built-in walk. The panel reads `node` as "install ripgrep".
   */
  engine: 'ripgrep' | 'node';
}

/** How an MCP server's tools reach the model (pi's `McpExposure`). */
