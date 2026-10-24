import { parse } from 'yaml';

/**
 * Prompt-template frontmatter, parsed the way pi parses it.
 *
 * pi loads a `.md` command by running its frontmatter through the YAML parser
 * (`yaml`'s `parse`) and **drops the whole template** when that throws — the
 * "Prompt conflicts" block the TUI prints at startup. Morse scanned the same
 * files with a lenient regular expression and happily offered a template pi had
 * already rejected, so an invalid description (`no argument-hint: fields…`, an
 * unquoted colon) produced a dead `/command` and no warning anywhere.
 *
 * Keeping the same parser here makes the two agree: what pi rejects, Morse
 * rejects, with pi's own message.
 */
export interface PromptFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface ExtractedFrontmatter {
  yamlString: string | null;
  body: string;
}

/** pi's `extractFrontmatter`, mirrored so the two read the same bytes. */
export function extractFrontmatter(content: string): ExtractedFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) {
    return { yamlString: null, body: normalized };
  }
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { yamlString: null, body: normalized };
  }
  return {
    yamlString: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 4).trim(),
  };
}

/**
 * The frontmatter and body of a prompt template. Throws with pi's own message
 * when the frontmatter is not valid YAML, exactly like `pi`'s loader would.
 */
export function parsePromptTemplate(content: string): PromptFrontmatter {
  const { yamlString, body } = extractFrontmatter(content);
  if (yamlString === null) {
    return { frontmatter: {}, body };
  }
  // Valid YAML that is not a mapping (a bare scalar or list) is not a conflict:
  // pi keeps the template and simply finds no description, so Morse must too.
  const parsed: unknown = parse(yamlString);
  return { frontmatter: (parsed ?? {}) as Record<string, unknown>, body };
}
