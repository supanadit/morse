/**
 * A named way of working a harness offers — OpenCode calls these agents, and a
 * session can be created in one or moved between them while it runs.
 *
 * Shapes only: the id is the harness's, the name and description are what a
 * picker shows, and `default` marks the one the harness resolves as its default.
 * A harness with no such distinction simply reports no modes.
 */
export interface AgentMode {
  /** The harness's own id, sent back when this mode is selected. */
  id: string;
  /** The label a picker shows. */
  name: string;
  /** What this mode is for, when the harness explains it. */
  description?: string;
  /** True for the mode the harness treats as its default. */
  default?: boolean;
}
