/**
 * A section is the reusable half of a config store: it names one block in a
 * JSON document and turns its entries into the neutral types a store lists.
 * A named section owns a `{ name: entry }` object; a whole-document section
 * owns the document itself. Decoders never throw: a value they cannot read is
 * skipped with an issue so its siblings still list.
 */
import type { ConfigIssue } from '@morse/protocol';

import type { SectionContext } from './types.js';

/** One entry of a named section, paired with its key. */
export interface NamedConfigEntry<T> {
  name: string;
  item: T;
}

/** A JSON pointer to one place in a config document (`/mcpServers/filesystem`). */
export function configPointer(...segments: string[]): string {
  return segments.map((segment) => `/${segment.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

/** The whole-document half: raw document value in, one value out. */
export abstract class ConfigSection<T> {
  abstract readonly key: string;
  abstract decode(raw: unknown, context: SectionContext): T;
  abstract encode(value: T, existing: unknown): unknown;
}

/** A section that owns a `{ name: entry }` block inside a larger document. */
export abstract class NamedConfigSection<T extends { name: string }> extends ConfigSection<
  Record<string, T>
> {
  abstract decodeEntry(name: string, raw: unknown, context: SectionContext): T | undefined;
  abstract encodeEntry(item: T, kept: unknown): unknown;

  /** pi: an entry that only overrides enabled/exposure of a user-level server. */
  isOverride(_raw: unknown): boolean {
    return false;
  }

  /** Entries that survive a managed-set replacement even when unlisted. */
  keepsOnReplace(_raw: unknown): boolean {
    return false;
  }

  /**
   * Read the named block out of the document value. A missing block is empty;
   * a block that is not an object, and each entry the codec rejects, is
   * reported as a `shape` issue pointing at the offending value.
   */
  decode(raw: unknown, context: SectionContext): Record<string, T> {
    if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
      context.issues.push(
        this.shapeIssue(context, `${context.file}: expected a JSON object.`, undefined),
      );
      return {};
    }
    const block = isPlainObject(raw) ? raw[this.key] : undefined;
    if (block === undefined || block === null) {
      return {};
    }
    if (!isPlainObject(block)) {
      context.issues.push(
        this.shapeIssue(
          context,
          `${context.file}: "${this.key}" must be an object.`,
          context.pointer(this.key),
        ),
      );
      return {};
    }
    const entries: Record<string, T> = Object.create(null) as Record<string, T>;
    for (const [name, entryRaw] of Object.entries(block)) {
      const pointer = context.pointer(this.key, name);
      const before = context.issues.length;
      const entry = this.decodeEntry(name, entryRaw, context);
      if (entry === undefined) {
        // A decoder that already explained this entry (a missing field, say)
        // owns the message; only an unexplained skip gets the generic one.
        const explained = context.issues
          .slice(before)
          .some((issue) => issue.pointer === pointer);
        if (!explained) {
          context.issues.push(
            this.shapeIssue(
              context,
              `${context.file}: "${this.key}.${name}" is not a valid entry.`,
              pointer,
            ),
          );
        }
        continue;
      }
      entries[name] = entry;
    }
    return entries;
  }

  /** Encode a name-to-entry record, keeping each entry's unknown fields. */
  encode(value: Record<string, T>, existing: unknown): Record<string, unknown> {
    const kept = isPlainObject(existing) ? existing : {};
    const encoded: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [name, item] of Object.entries(value)) {
      encoded[name] = this.encodeEntry(item, kept[name]);
    }
    return encoded;
  }

  private shapeIssue(
    context: SectionContext,
    message: string,
    pointer: string | undefined,
  ): ConfigIssue {
    return {
      file: context.file,
      fileId: context.fileId,
      scope: context.scope,
      pointer,
      code: 'shape',
      message,
      fixable: false,
    };
  }
}

/** A non-array, non-null object: the shape every config block must have. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
