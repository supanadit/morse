import { ChangeDetectionStrategy, Component } from '@angular/core';
import { PromptEditor } from './prompt-editor';

/**
 * The prompt-template editor as a whole document. VS Code has no Morse tab
 * strip, so its extension opens a `WebviewPanel` and routes this bundle to
 * `#/prompts`; the panel is this page, the same `PromptEditor` the browser host
 * shows in a tab.
 *
 * The route row loads this module lazily, so importing the editor here does not
 * pull it into the initial bundle.
 */
@Component({
  selector: 'morse-prompt-editor-page',
  imports: [PromptEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './prompt-editor-page.html',
  styleUrl: './prompt-editor-page.css',
})
export class PromptEditorPage {}
