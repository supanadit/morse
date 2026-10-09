import { ChangeDetectionStrategy, Component } from '@angular/core';
import { McpEditor } from './mcp-editor';

/**
 * The MCP editor as a whole document. VS Code has no Morse tab strip, so its
 * extension opens a `WebviewPanel` and routes this bundle to `#/mcp`; the panel
 * is this component, the same `McpEditor` the browser host shows in a tab.
 */
@Component({
  selector: 'morse-mcp-editor-page',
  imports: [McpEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mcp-editor-page.html',
  styleUrl: './mcp-editor-page.css',
})
export class McpEditorPage {}
