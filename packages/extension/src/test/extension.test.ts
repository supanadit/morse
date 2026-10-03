import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'supanadit.morse';
const COMMANDS = [
  'morse.openChat',
  'morse.newSession',
  'morse.attachSelection',
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
});
