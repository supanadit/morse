/**
 * The directory an agent works in. Harness vocabulary: every harness needs one,
 * so it is not Morse's.
 */

export interface WorkspaceRef {
  cwd: string;
  name: string;
}
