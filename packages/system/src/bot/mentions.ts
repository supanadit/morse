/**
 * Who a message addresses. A bot's name is its handle (`@Forge`), and the two
 * broadcast words address every member.
 *
 * The parser is syntax-only on purpose: it knows the conversation's members and
 * nothing about the sender. Whether a mention is allowed — a bot must not relay
 * to itself, an unknown handle must be reported — is the router's decision,
 * because the same text means different things from different authors.
 */

/** `@handle` at a word boundary: the lookbehind keeps `a@b.com` from parsing. */
function mentionPattern(): RegExp {
  // A fresh expression per call: a shared global regex would carry `lastIndex`
  // from one message into the next.
  return /(?<![\p{L}\p{N}_.])@([\p{L}\p{N}_-]+)/gu;
}

/** The two handles that address every member. */
const BROADCASTS = new Set(['all', 'everyone']);

/**
 * The raw handles a message names, in order and including duplicates. The router
 * uses this to report handles it ignores; `parseMentions` is the resolved view.
 */
export function mentionTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(mentionPattern())) {
    // The capture group always exists when the expression matches.
    tokens.push(match[1] as string);
  }
  return tokens;
}

/**
 * The members a message addresses, resolved against the member list: explicit
 * names in order of appearance (each once), or a broadcast that the caller
 * expands to every member in member order.
 */
export function parseMentions(
  text: string,
  members: string[],
): { targets: string[]; all: boolean } {
  const byHandle = new Map(members.map((name) => [name.toLowerCase(), name]));
  const targets: string[] = [];
  let all = false;
  for (const token of mentionTokens(text)) {
    const handle = token.toLowerCase();
    if (BROADCASTS.has(handle)) {
      all = true;
      continue;
    }
    const member = byHandle.get(handle);
    if (member !== undefined && !targets.includes(member)) {
      targets.push(member);
    }
  }
  return { targets, all };
}
