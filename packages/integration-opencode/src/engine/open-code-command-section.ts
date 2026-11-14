/**
 * OpenCode's `command` block: the JSON half of its prompt templates. Each entry
 * is a structured command — `{ template, description?, agent?, model?, subtask? }`
 * — keyed by the `/name` it answers. An entry *is* the command, so there is no
 * override concept and every field Morse does not edit survives a save.
 *
 * A `command` block only exists in the user-level `opencode.json`; the store
 * that owns this section reads that file alone.
 */
import {
  NamedConfigSection,
  isPlainObject,
  type ConfigIssue,
  type PromptTemplate,
  type SectionContext,
} from '@morse/engine-config';

/** One stored entry, as the editor's `PromptTemplate.entry` carries it. */
export type OpenCodeCommandEntry = NonNullable<PromptTemplate['entry']>;

export class OpenCodeCommandSection extends NamedConfigSection<PromptTemplate> {
  readonly key = 'command';

  /**
   * One entry as a prompt row. A `template` is what makes an entry a command —
   * OpenCode would not load one without it — so a malformed entry is skipped
   * with a pointer and its siblings still list.
   */
  override decodeEntry(
    name: string,
    raw: unknown,
    context: SectionContext,
  ): PromptTemplate | undefined {
    if (!isPlainObject(raw)) {
      context.issues.push(this.entryIssue(context, name, `command "${name}" must be an object.`));
      return undefined;
    }
    if (typeof raw['template'] !== 'string') {
      context.issues.push(
        this.entryIssue(context, name, `command "${name}" needs a string "template".`),
      );
      return undefined;
    }
    const row: PromptTemplate = {
      name,
      // The `command` key is read from the user-level file only, so this is
      // always `global`; the field is still taken from the context so a project
      // reader added later would not mislabel a row.
      scope: context.scope,
      source: 'config',
      entry: raw as OpenCodeCommandEntry,
    };
    if (typeof raw['description'] === 'string') {
      row.description = raw['description'];
    }
    return row;
  }

  /**
   * The entry to store: the kept entry's unknown fields first, then the row the
   * editor sent. `template` and `description` belong to the editor, so an
   * omitted `description` clears the stored one instead of resurrecting a field
   * the row no longer shows; everything Morse does not edit (`agent`, `model`,
   * `subtask`, ...) survives a save that does not carry it.
   */
  override encodeEntry(item: PromptTemplate, kept: unknown): unknown {
    const entry = item.entry;
    if (entry === undefined) {
      throw new Error(
        `command "${item.name}" needs a structured "entry" (template, description, ...).`,
      );
    }
    if (typeof entry.template !== 'string' || entry.template.length === 0) {
      throw new Error(`command "${item.name}" needs a "template".`);
    }
    const keptEntry = isPlainObject(kept) ? kept : {};
    const encoded: Record<string, unknown> = { ...keptEntry, ...entry };
    if (entry.description === undefined) {
      delete encoded['description'];
    }
    return encoded;
  }

  private entryIssue(context: SectionContext, name: string, message: string): ConfigIssue {
    return {
      file: context.file,
      fileId: context.fileId,
      scope: context.scope,
      pointer: context.pointer(this.key, name),
      code: 'shape',
      message: `${context.file}: ${message}`,
      fixable: false,
    };
  }
}
