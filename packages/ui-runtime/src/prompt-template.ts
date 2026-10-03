/**
 * Prompt templates, mirrored from pi.
 *
 * pi expands `/template args` itself, but it does not expose the template body
 * or `argument-hint` over RPC (`get_commands` returns name/description/source
 * only). The modal therefore reads the raw Markdown the host shipped and expands
 * it here — the only way to offer a declared-argument form and to append extra
 * instructions *below* the expanded template, which pi never does: pi treats
 * every word after the command as an argument and drops what the body does not
 * reference.
 *
 * `parseCommandArgs` and `substituteArgs` are ports of pi's implementation
 * (`dist/core/prompt-templates.js`); the specs mirror its behaviour so the two
 * cannot drift.
 */

/** One form field: a positional placeholder, or the catch-all raw arguments. */
export interface PromptTemplateArgument {
  /** Stable form-control id, used as the value key. */
  id: string;
  /** What to call it — the hint token, or `Argument N`. */
  label: string;
  /** Angle brackets in the hint mark an argument the template expects. */
  required: boolean;
  /** 1-based positional index; absent for the catch-all raw-arguments field. */
  index?: number;
}

/** Everything the modal needs to render and expand one prompt template. */
export interface PromptTemplateForm {
  /** The template body, frontmatter stripped. */
  body: string;
  arguments: PromptTemplateArgument[];
}

/** The frontmatter fields Morse cares about, plus the body. */
export interface ParsedPromptTemplate {
  body: string;
  argumentHint?: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const HINT_TOKEN = /<([^<>]+)>|\[([^\[\]]+)\]/g;
const POSITIONAL = /\$(\d+)|\$\{(\d+):/g;
const CATCH_ALL = /\$(?:@|ARGUMENTS)|\$\{(?:@|ARGUMENTS)(?::|-)/;

/**
 * Split a shell-like argument string, quotes and all. Ported from pi so
 * `/review "API compatibility"` is one argument, exactly as the TUI sees it.
 */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote !== null) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

/**
 * Replace pi's placeholders with the collected values. Ported from pi: a value
 * that itself contains `$1` is not substituted again.
 */
export function substituteArgs(content: string, args: readonly string[]): string {
  const allArgs = args.join(' ');
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultTarget !== undefined) {
        const value =
          defaultTarget === '@' || defaultTarget === 'ARGUMENTS'
            ? allArgs
            : args[Number.parseInt(defaultTarget, 10) - 1];
        return value ? value : defaultValue;
      }
      if (sliceStart !== undefined) {
        let start = Number.parseInt(sliceStart, 10) - 1;
        if (start < 0) {
          start = 0;
        }
        if (sliceLength !== undefined) {
          return args.slice(start, start + Number.parseInt(sliceLength, 10)).join(' ');
        }
        return args.slice(start).join(' ');
      }
      if (simple === 'ARGUMENTS' || simple === '@') {
        return allArgs;
      }
      return args[Number.parseInt(simple, 10) - 1] ?? '';
    },
  );
}

/** Split `argument-hint` into positional fields; angle brackets mean required. */
function hintArguments(hint: string | undefined): PromptTemplateArgument[] {
  if (hint === undefined) {
    return [];
  }
  const fields: PromptTemplateArgument[] = [];
  HINT_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = HINT_TOKEN.exec(hint)) !== null) {
    index += 1;
    const label = (match[1] ?? match[2] ?? '').trim();
    fields.push({
      id: `arg${index}`,
      label: label.length > 0 ? label : `Argument ${index}`,
      required: match[1] !== undefined,
      index,
    });
  }
  return fields;
}

/** Fall back to the body's own `$1…$n` when no hint declares the arguments. */
function bodyArguments(body: string): PromptTemplateArgument[] {
  let highest = 0;
  POSITIONAL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = POSITIONAL.exec(body)) !== null) {
    const index = Number.parseInt(match[1] ?? match[2] ?? '0', 10);
    if (Number.isFinite(index) && index > highest) {
      highest = index;
    }
  }
  const fields: PromptTemplateArgument[] = [];
  for (let index = 1; index <= highest; index += 1) {
    fields.push({ id: `arg${index}`, label: `Argument ${index}`, required: false, index });
  }
  return fields;
}

/** Strip a surrounding pair of quotes, if any. */
function unquote(value: string): string {
  const match = /^(['"])([\s\S]*)\1$/.exec(value);
  return match === null ? value : match[2];
}

/** Pull `argument-hint` (and the body) out of a template's frontmatter. */
export function readPromptTemplate(raw: string): ParsedPromptTemplate {
  const frontmatter = FRONTMATTER.exec(raw);
  if (frontmatter === null) {
    return { body: raw };
  }
  const hint = /^argument-hint:[ \t]*(.*)$/m.exec(frontmatter[1]);
  return {
    body: raw.slice(frontmatter[0].length),
    argumentHint: hint === null ? undefined : unquote(hint[1].trim()),
  };
}

/**
 * The form for a template, or `undefined` when it takes no arguments — the
 * composer then sends `/<name>` straight to pi, which expands it itself.
 */
export function promptTemplateForm(raw: string): PromptTemplateForm | undefined {
  const parsed = readPromptTemplate(raw);
  const fromHint = hintArguments(parsed.argumentHint);
  const fields = fromHint.length > 0 ? fromHint : bodyArguments(parsed.body);
  if (fields.length > 0) {
    return { body: parsed.body, arguments: fields };
  }
  // A body that only speaks `$@`/`$ARGUMENTS` still takes arguments; one free
  // field feeds the whole argument string, shell-quoted like pi would parse it.
  if (CATCH_ALL.test(parsed.body)) {
    return { body: parsed.body, arguments: [{ id: 'arguments', label: 'Arguments', required: false }] };
  }
  return undefined;
}

/**
 * The prompt the agent receives: the template with the collected arguments
 * substituted, then the extra instructions appended after a blank line. The
 * extra is a Morse affordance — pi would have treated it as more arguments.
 */
export function composePromptTemplate(
  form: PromptTemplateForm,
  values: Readonly<Record<string, string>>,
  extra = '',
): string {
  const raw = form.arguments.find((argument) => argument.index === undefined);
  const args =
    raw !== undefined
      ? parseCommandArgs(values[raw.id] ?? '')
      : form.arguments.map((argument) => (values[argument.id] ?? '').trim());
  const body = substituteArgs(form.body, args);
  const tail = extra.trim();
  if (tail.length === 0) {
    return body;
  }
  return `${body.replace(/\s+$/, '')}\n\n${tail}`;
}
