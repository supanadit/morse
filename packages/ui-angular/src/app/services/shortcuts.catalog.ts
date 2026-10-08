/**
 * The keyboard's catalog: every action, the keys it answers to, and how those
 * keys are printed.
 *
 * Nothing here touches the DOM or Angular. `ShortcutService` matches and
 * dispatches it, `ui/shortcut-keys.ts` listens for it, and the help dialog prints
 * it — one list, so what the dialog promises is what the keyboard does.
 */

/** Every action the keyboard can run. The catalog and its owners meet here. */
export type ActionId =
  | 'session.new'
  | 'session.search'
  | 'command.palette'
  | 'project.filter'
  | 'view.git'
  /** The MCP manager: list, enable and disable pi's MCP servers. */
  | 'view.mcp'
  /** The prompt-template editor: list, edit and test pi's `/commands`. */
  | 'view.prompts'
  | 'model.pick'
  | 'thinking.pick'
  | 'context.compact'
  | 'help.shortcuts';

/**
 * Keys a surface owns itself (`Enter` belongs to the prompt). They are listed so
 * the help is complete, and never dispatched from here — the surface would fight
 * the service over them.
 */
export type LocalKeyId = 'prompt.send' | 'prompt.newline' | 'prompt.mention' | 'prompt.commands';

export type ShortcutId = ActionId | LocalKeyId;

export type ShortcutGroup = 'Session' | 'Navigate' | 'Model' | 'Context' | 'Typing' | 'Help';

/**
 * A key combination. `key` is compared against `KeyboardEvent.key`, lower-cased
 * for letters; `mod` is Cmd on macOS and Ctrl anywhere else, `alt` is Option on
 * macOS.
 *
 * Shift is deliberately not part of a binding: it is how a keyboard *produces* a
 * character (`?` needs it), and holding it while pressing Ctrl+Alt+N still means
 * "new session".
 */
export interface Binding {
  readonly key: string;
  readonly mod?: true;
  readonly alt?: true;
}

interface ShortcutBase {
  readonly id: ShortcutId;
  readonly group: ShortcutGroup;
  readonly label: string;
  /** One line under the label: what happens, and where the limit is. */
  readonly detail: string;
}

/** A shortcut the service matches on every keydown. */
export interface ManagedShortcut extends ShortcutBase {
  readonly id: ActionId;
  /**
   * One gesture, or several that mean the same thing. An array is how a second
   * key reaches one action without a second catalog row: the `?` dialog still
   * prints a single line, with its keys joined by `/`.
   */
  readonly binding: Binding | readonly Binding[];
  /**
   * The action puts something on top of the app. While a dialog is already up
   * these stand down — a picker opened behind a modal is a bug, not a feature.
   */
  readonly overlay?: true;
  /**
   * Fires with the caret in a text field. A modified combination is not a
   * character, so it is safe there; `/` and `?` are characters and stay with the
   * field they were typed in.
   */
  readonly whileTyping?: true;
}

/** A key the surface itself handles, printed as a reference row. */
export interface LocalShortcut extends ShortcutBase {
  readonly id: LocalKeyId;
  readonly keys: string;
}

export type ShortcutSpec = ManagedShortcut | LocalShortcut;

/**
 * The catalog, in the order the help dialog prints it. One list, two readers:
 * `ShortcutService` matches and dispatches it and the dialog prints it, so what
 * the dialog promises is what the keyboard does.
 *
 * The letters are `mod+alt+…` on purpose. A bare `Ctrl+N`/`Ctrl+T`/`Ctrl+W` never
 * reaches the page (the browser keeps those), `?` and `/` are the conventions for
 * help and search outside a text field, and modified combinations are ignored by
 * no one while the user is typing a prompt.
 */
export const SHORTCUTS: readonly ShortcutSpec[] = [
  {
    id: 'session.new',
    group: 'Session',
    label: 'New session',
    detail: 'The sidebar button, on the keyboard — and on a browser host it still asks which folder first.',
    binding: { key: 'n', mod: true, alt: true },
  },
  {
    id: 'session.search',
    group: 'Session',
    label: 'Focus the session search',
    detail: 'Opens the sidebar when the layout hid it, and puts the caret in the field. In the prompt, `/` opens the command palette instead.',
    binding: { key: '/' },
  },
  {
    id: 'command.palette',
    group: 'Navigate',
    label: 'Command palette',
    detail: 'One field for everything: run a command, switch a tab, open a session, file or project, or pick the model and thinking level. A leading >, #, @ or : narrows it to that source.',
    binding: [
      { key: 'k', mod: true, alt: true },
      { key: '/', mod: true, alt: true },
    ],
    overlay: true,
    whileTyping: true,
  },
  {
    id: 'project.filter',
    group: 'Navigate',
    label: 'Change project focus',
    detail: 'Narrows the sidebar to one project. Only a host with several projects has this.',
    binding: { key: 'p', mod: true, alt: true },
    overlay: true,
  },
  {
    id: 'view.git',
    group: 'Navigate',
    label: 'Toggle the git panel',
    detail: 'Shows or hides the history and graph for the active project. The browser host only — VS Code has its own Source Control view.',
    binding: { key: 'g', mod: true, alt: true },
    overlay: true,
    whileTyping: true,
  },
  {
    id: 'view.mcp',
    group: 'Navigate',
    label: 'Manage MCP servers',
    detail: 'Opens the MCP manager: the servers pi sees for the active directory, with add, enable, disable and remove. A host that cannot run the `pi` CLI shows it as unavailable.',
    binding: { key: 's', mod: true, alt: true },
    overlay: true,
    whileTyping: true,
  },
  {
    id: 'view.prompts',
    group: 'Navigate',
    label: 'Edit prompt templates',
    detail: 'Opens Morse\u2019s editor for pi\u2019s `/commands`: the templates in your user prompt directory and, with a project in front, that project\u2019s `.pi/prompts`, with a form and an argument tester.',
    binding: { key: 'e', mod: true, alt: true },
    overlay: true,
    whileTyping: true,
  },
  {
    id: 'model.pick',
    group: 'Model',
    label: 'Change model',
    detail: 'Opens the model chooser above the prompt.',
    binding: { key: 'm', mod: true, alt: true },
    overlay: true,
    whileTyping: true,
  },
  {
    id: 'thinking.pick',
    group: 'Model',
    label: 'Change thinking level',
    detail: 'Opens the reasoning-level chooser next to the model.',
    binding: { key: 't', mod: true, alt: true },
    overlay: true,
    whileTyping: true,
  },
  {
    id: 'context.compact',
    group: 'Context',
    label: 'Compact the conversation',
    detail: 'Asks first: pi replaces what it remembers with a summary.',
    binding: { key: 'c', mod: true, alt: true },
    overlay: true,
    whileTyping: true,
  },
  {
    id: 'prompt.send',
    group: 'Typing',
    label: 'Send the prompt',
    detail: 'While the prompt has the caret. During a run, the same key steers the agent instead.',
    keys: 'Enter',
  },
  {
    id: 'prompt.newline',
    group: 'Typing',
    label: 'New line',
    detail: 'The prompt grows with the text rather than sending it.',
    keys: 'Shift+Enter',
  },
  {
    id: 'prompt.mention',
    group: 'Typing',
    label: 'Mention a file',
    detail: 'Opens the picker that inserts an @path mention.',
    keys: '@',
  },
  {
    id: 'prompt.commands',
    group: 'Typing',
    label: 'Command palette',
    detail: 'The slash commands Morse and pi understand, filtered as you type.',
    keys: '/',
  },
  {
    id: 'help.shortcuts',
    group: 'Help',
    label: 'This list',
    detail: 'Opens and closes these rows, outside a text field.',
    binding: { key: '?' },
    overlay: true,
  },
];

export function isManagedShortcut(spec: ShortcutSpec): spec is ManagedShortcut {
  return 'binding' in spec;
}

/** True on the platforms where `mod` is Cmd and `alt` is Option. */
export function isApple(): boolean {
  const navigator = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return /mac|iphone|ipad/i.test(navigator?.userAgent ?? '');
}

/**
 * How the keys are printed for this machine: `Ctrl+Alt+N` / `⌘⌥N`. Letters are
 * upper-cased, symbols (`?`, `/`) are left alone.
 */
export function bindingLabel(binding: Binding | readonly Binding[], apple = isApple()): string {
  return asBindings(binding)
    .map((one) => labelOne(one, apple))
    .join(' / ');
}

/** One combination, printed for this machine. */
function labelOne(binding: Binding, apple: boolean): string {
  const parts: string[] = [];
  if (binding.mod === true) {
    parts.push(apple ? '⌘' : 'Ctrl');
  }
  if (binding.alt === true) {
    parts.push(apple ? '⌥' : 'Alt');
  }
  parts.push(binding.key.length === 1 && /[a-z]/.test(binding.key) ? binding.key.toUpperCase() : binding.key);
  return apple ? parts.join('') : parts.join('+');
}

/** A single binding as a one-element list, so the matcher and printer share a shape. */
function asBindings(binding: Binding | readonly Binding[]): readonly Binding[] {
  return Array.isArray(binding) ? binding : [binding as Binding];
}

/**
 * The key and its modifiers, compared exactly — except Shift, which is how a
 * keyboard *produces* a key: `Ctrl+Alt+Shift+N` is still the gesture for "new
 * session" (same letters), while `Ctrl+Shift+M` alone is not the model chooser.
 */
export function matches(binding: Binding | readonly Binding[], event: KeyboardEvent): boolean {
  return asBindings(binding).some((one) => matchesOne(one, event));
}

function matchesOne(binding: Binding, event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== binding.key.toLowerCase()) {
    return false;
  }
  if ((binding.mod === true) !== (isApple() ? event.metaKey : event.ctrlKey)) {
    return false;
  }
  return (binding.alt === true) === event.altKey;
}

/**
 * Where a character would land: `/` and `?` belong to a field the caret is in,
 * not to the shell.
 */
export function isEditable(target: EventTarget | null): boolean {
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (element === null || typeof element.tagName !== 'string') {
    return false;
  }
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
}
