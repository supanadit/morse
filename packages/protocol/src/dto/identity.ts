/** Which frontend build is talking, and the answer to a self-update request. */

export interface FrontendIdentity {
  name: string;
  version: string;
}

/**
 * What the `updateHost` command answers: whether a newer build was installed and
 * whether the host is relaunching itself to run it.
 *
 * The frontend prints `message` either way, and — when `restarting` — reloads the
 * page once the health probe sees the new process. `from`/`to` are the versions,
 * so the notice can say what it did rather than only that it did something.
 */
export interface UpdateHostResult {
  ok: boolean;
  /** The version the host was serving when it was asked. */
  from: string;
  /** The version npm reported installing, when the install succeeded. */
  to?: string;
  /** True when the host is exiting so a supervisor (or the CLI) runs the new build. */
  restarting?: boolean;
  /** One line the frontend shows: what happened, or why it could not. */
  message: string;
}
