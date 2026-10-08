/**
 * The prompt-template editor's file renderer.
 *
 * The shared inverse of `prompt-template.ts`'s expansion: the composer and the
 * palette read a template with `substituteArgs`, and the editor writes one back
 * with `renderPromptTemplate`. Only the editor imports this, so the bundler
 * keeps it in the lazily loaded prompt-editor chunk.
 */

/** What the editor holds before it is rendered back to a file. */
export interface PromptTemplateDraft {
  /** The `description` frontmatter, or empty to omit it. */
  description?: string;
  /** The `argument-hint` frontmatter, or empty to omit it. */
  argumentHint?: string;
  /** The body, with the frontmatter already stripped. */
  body: string;
}

/**
 * The file the editor writes: the frontmatter keys it understands, then the body.
 * pi parses it with YAML, so a value that needs quoting is double-quoted —
 * `JSON.stringify` emits a valid YAML double-quoted scalar, escapes included.
 */
export function renderPromptTemplate(draft: PromptTemplateDraft): string {
  const description = draft.description?.trim() ?? '';
  const hint = draft.argumentHint?.trim() ?? '';
  const lines: string[] = [];
  if (description.length > 0 || hint.length > 0) {
    lines.push('---');
    if (description.length > 0) {
      lines.push(`description: ${yamlScalar(description)}`);
    }
    if (hint.length > 0) {
      lines.push(`argument-hint: ${yamlScalar(hint)}`);
    }
    lines.push('---');
  }
  const body = draft.body.replace(/^\n+/, '').replace(/\s+$/, '');
  const head = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  return body.length > 0 ? `${head}${body}\n` : head;
}

/** A YAML scalar: bare when obviously safe, double-quoted (JSON escapes) otherwise. */
function yamlScalar(value: string): string {
  const bare = /^[A-Za-z0-9][A-Za-z0-9 _.,'()/+-]*$/.test(value) && !value.endsWith(' ');
  return bare ? value : JSON.stringify(value);
}
