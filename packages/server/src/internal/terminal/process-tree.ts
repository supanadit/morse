import { execFileSync } from 'node:child_process';

/**
 * One row of the process table: the pieces needed to reach a whole job.
 */
export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
}

/**
 * Reads the process table once. `ps` is POSIX-only; Windows has no equivalent,
 * so there the table is empty and a teardown falls back to `node-pty`'s own
 * `kill`, which already ends the pseudoconsole's whole process list.
 *
 * Any failure returns `[]`: a missing `ps` (a minimal container) or a denied
 * call must never break a terminal teardown — it only cannot widen it.
 */
export function readProcessTable(): ProcessRow[] {
  if (process.platform === 'win32') {
    return [];
  }
  let raw: string;
  try {
    raw = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,sid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return parseProcessTable(raw);
}

/** Parses `ps -A -o pid=,ppid=,pgid=,sid=` output; exported so the parse is unit-tested. */
export function parseProcessTable(raw: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of raw.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      pgid: Number.parseInt(match[3]!, 10),
      sid: Number.parseInt(match[4]!, 10),
    });
  }
  return rows;
}

/**
 * Every descendant of `root`, breadth-first. Used for the graceful signal, while
 * the shell is still alive and its children still name it as their parent.
 */
export function descendantRows(root: number, table: ProcessRow[]): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) {
    const list = children.get(row.ppid);
    if (list === undefined) {
      children.set(row.ppid, [row]);
    } else {
      list.push(row);
    }
  }
  const result: ProcessRow[] = [];
  const queue = [root];
  const seen = new Set([root]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

/**
 * Every process in a pty session (`sid` == the shell's pid: `node-pty` calls
 * `setsid`, so the shell leads its own session and its descendants share it
 * unless one calls `setsid` itself). This is what catches a child that
 * reparented to init after the shell died — the force pass after the grace.
 */
export function sessionRows(sessionId: number, table: ProcessRow[]): ProcessRow[] {
  return table.filter((row) => row.sid === sessionId && row.pid !== sessionId);
}

/** Signals one pid, ignoring a process that is already gone or not ours to signal. */
export function signalProcess(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 1 || pid === process.pid) {
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Gone, or not ours to signal.
  }
}

/** Signals a whole process group (negative pid), ignoring a gone or foreign group. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  // A pty shell leads its own session and group, so a pgid here is never the
  // host's own. The guards keep a malformed table from turning the kill on us.
  if (pgid <= 1 || pgid === process.pid) {
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch {
    // Gone, or not ours to signal.
  }
}
