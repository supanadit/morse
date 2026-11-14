/**
 * OpenCode's MCP store. OpenCode has no partial override: an entry *is* the
 * server, so a project entry replaces a same-named global one outright and the
 * base store's first-wins listing is the whole precedence rule. That also makes
 * a managed replacement drop every unlisted entry, and a project edit of a
 * user-level server is refused (`unsupported`) because there is nowhere to pin
 * it — the engine writes no override block.
 */
import { McpStore, type ConfigLocator } from '@morse/engine-config';

import { OPEN_CODE_CONFIG_FILE_ID } from './config-discovery.js';
import { OpenCodeMcpSection } from './open-code-mcp-section.js';

export class OpenCodeMcpStore extends McpStore {
  constructor(locator: ConfigLocator) {
    // The `mcp` key lives in the one OpenCode config document.
    super(locator, OPEN_CODE_CONFIG_FILE_ID, new OpenCodeMcpSection());
  }
}
