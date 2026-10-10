import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'supanadit.morse';
const COMMANDS = [
  'morse.openChat',
  'morse.newSession',
  'morse.attachSelection',
  'morse.openSessionTab',
  'morse.showOutput',
];

suite('Morse extension', () => {
  test('activates and registers its commands', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be installed in the test host`);

    await extension.activate();

    const registered = await vscode.commands.getCommands(true);
    for (const command of COMMANDS) {
      assert.ok(registered.includes(command), `missing command ${command}`);
    }
  });

  test('contributes the Morse activity bar view', () => {
    const morse = vscode.extensions.getExtension(EXTENSION_ID);
    const views = morse?.packageJSON?.contributes?.views?.morse ?? [];
    assert.strictEqual(views.length, 1);
    assert.strictEqual(views[0].id, 'morse.chat');
    assert.strictEqual(views[0].type, 'webview');
  });

  test('activates on a restored session tab, so a reload keeps it', () => {
    const morse = vscode.extensions.getExtension(EXTENSION_ID);
    const events: string[] = morse?.packageJSON?.activationEvents ?? [];
    assert.ok(
      events.includes('onWebviewPanel:morse.sessionTab'),
      'a session tab must be able to restore itself after a window reload',
    );
  });

  test('does not put Attach Selection in the chat panel title toolbar', () => {
    // The chat composer already offers attaching a selection, so the redundant
    // toolbar icon was removed. The command stays in the palette for keyboard use.
    const morse = vscode.extensions.getExtension(EXTENSION_ID);
    const titleMenu: Array<{ command?: string }> =
      morse?.packageJSON?.contributes?.menus?.['view/title'] ?? [];
    assert.ok(
      !titleMenu.some((entry) => entry.command === 'morse.attachSelection'),
      'morse.attachSelection must not appear as a view/title icon',
    );
  });

  test('the webview CSP lets a code-split chunk load', () => {
    // A lazy route (the prompt editor, a session tab) is a runtime `import()` of
    // a hashed chunk, and a chunk request carries none of the nonces VS Code
    // injects into index.html. Under `script-src 'nonce-…'` alone the request is
    // blocked and the panel renders blank, so the shipped bundle must also grant
    // `'strict-dynamic'` (which trusts the scripts the entry itself loads).
    const root = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;
    assert.ok(root, 'the extension should be installed in the test host');
    const bundle = readFileSync(join(root, 'dist', 'extension.js'), 'utf8');
    const scriptSrc = /script-src[^`]*/.exec(bundle)?.[0] ?? '';
    assert.ok(scriptSrc.includes("nonce-"), `CSP should keep a nonce: ${scriptSrc}`);
    assert.ok(
      scriptSrc.includes("'strict-dynamic'"),
      `CSP must allow its own lazy chunks to load: ${scriptSrc}`,
    );
  });
});
