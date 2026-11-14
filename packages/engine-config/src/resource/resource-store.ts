/**
 * The store contract every resource kind answers: a list with its issues, a
 * save, a remove and a cheap signature for change detection. Concrete stores
 * (config sections, files, composites) implement it; callers never need to know
 * where the resource lives.
 */
import type { ConfigIssue, ConfigMutation, ConfigScope } from '@morse/protocol';

/** What a list returned: the items plus the problems that did not hide them. */
export interface ResourceList<T> {
  items: T[];
  issues: ConfigIssue[];
}

/** A resource mutation is a config mutation: the same shape and issue codes. */
export type ResourceMutation = ConfigMutation;

export abstract class ResourceStore<TItem, TSave = TItem> {
  abstract list(cwd?: string): ResourceList<TItem>;
  abstract save(input: TSave, scope: ConfigScope, cwd?: string): ConfigMutation;
  abstract remove(name: string, scope: ConfigScope, cwd?: string, source?: string): ConfigMutation;
  abstract signature(cwd?: string): string;
}
