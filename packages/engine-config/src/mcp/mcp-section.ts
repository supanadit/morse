/**
 * The MCP section half: one `{ name: server }` block per engine. An engine
 * supplies only the entry codec and says which entries are project overrides of
 * a user-level server; the block mechanics stay here.
 *
 * A section must decode an override-only entry too (for pi, `{ enabled: false }`
 * with no command): `McpStore.list` decodes the whole block before it asks
 * `isOverride`, then merges the decoded override onto its base.
 */
import type { McpServer } from '@morse/protocol';

import { NamedConfigSection } from '../core/section.js';
import type { SectionContext } from '../core/types.js';

export abstract class McpSection extends NamedConfigSection<McpServer> {
  abstract override decodeEntry(
    name: string,
    raw: unknown,
    context: SectionContext,
  ): McpServer | undefined;
  abstract override encodeEntry(item: McpServer, kept: unknown): unknown;

  /** pi: an entry that only overrides enabled/exposure of a user-level server. */
  override isOverride(_raw: unknown): boolean {
    return false;
  }
}
