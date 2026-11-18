import { userInfo } from 'node:os';

/**
 * Bot mode's one principal: the person at this Morse.
 *
 * A bot conversation has a host on the other side of it, and the host now has a
 * name in the transcript — a bus delivery records who caused it, and "a person
 * asked this" is only useful if the person can be named. There is no account
 * system here, so the name is the operating system's: whatever the process runs
 * as. It is an identity for reading, never an authorization key.
 */
export const HOST_PERSON_ID = 'host';

/** The person the host acts for: a stable id and the name to show for it. */
export interface HostPerson {
  type: 'person';
  id: typeof HOST_PERSON_ID;
  name: string;
}

let cached: HostPerson | undefined;

/**
 * The host person, resolved once.
 *
 * Memoised because every line written in one process belongs to the same person,
 * and `userInfo` can throw in a container with no passwd entry for the uid. The
 * id stays `host` in that case: a missing name is cosmetic, a missing identity
 * would make every delivery unattributed.
 */
export function hostPerson(): HostPerson {
  if (cached === undefined) {
    cached = { type: 'person', id: HOST_PERSON_ID, name: hostName() };
  }
  return cached;
}

function hostName(): string {
  try {
    const name = userInfo().username.trim();
    return name === '' ? HOST_PERSON_ID : name;
  } catch {
    return HOST_PERSON_ID;
  }
}
