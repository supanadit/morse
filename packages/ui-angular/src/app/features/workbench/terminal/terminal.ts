import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { FitAddon } from '@xterm/addon-fit';
import type { ITheme, Terminal as XTermInstance } from '@xterm/xterm';
import { MorseService } from '../../../host/morse.service';
import { registerTerminalLinks } from './terminal-links';

/**
 * A real terminal: xterm.js renders the shell's stream (ANSI, colours, cursor,
 * full-screen programs) and forwards keystrokes to the host's PTY, so the panel
 * behaves like a desktop terminal — line editing, resize, Ctrl+C, vim and all.
 *
 * The emulator is imported only when the terminal is first opened: it is large
 * (and CommonJS), and a reader who never opens the panel should not download it.
 *
 * The shell survives a collapse because the panel keeps this component mounted,
 * and it survives a page reload because the host owns the process: this view
 * detaches on destroy and the host leaves the shell running, so a remount replays
 * the scrollback into a fresh emulator and the shell keeps going.
 */
@Component({
  selector: 'morse-terminal',
  templateUrl: './terminal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './terminal.css',
})
export class Terminal {
  private readonly morse = inject(MorseService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly screen = viewChild<ElementRef<HTMLElement>>('screen');
  /** The terminal's wire id, minted by `TerminalStore` (the session owns it). */
  readonly id = input.required<string>();
  /**
   * The directory the shell runs in. A restored pane carries its own, because
   * its session may not be the one in front yet; a live pane leaves it empty and
   * the host uses the viewing session's directory.
   */
  readonly cwd = input<string | undefined>(undefined);
  /** The shell's own title (OSC 0/2), so the tab can follow the running command. */
  readonly titleChange = output<string>();
  /**
   * The directory the shell reports (OSC 7, `file://host/path`), so the pane can
   * remember where the reader `cd`'d and a restored shell can reopen there.
   */
  readonly cwdChange = output<string>();

  private term: XTermInstance | undefined;
  private fit: FitAddon | undefined;
  private observer: ResizeObserver | undefined;
  private destroyed = false;
  /**
   * Output that arrived before the emulator finished loading. The lazy import of
   * xterm is a tick long, and the host can flush a replay inside it; dropping
   * those bytes would show a blank terminal until the shell's next prompt.
   */
  private pending = '';
  /**
   * The host epoch this pane last attached to. `-1` until the emulator is ready;
   * a later value than the current epoch means the host was replaced and the
   * shell has to be attached again (see `attachToHost`).
   */
  private openedEpoch = -1;

  protected readonly ended = signal<{ code?: number; error?: string } | undefined>(undefined);

  constructor() {
    const offOutput = this.morse.onTerminalOutput((event) => {
      if (event.terminalId === this.id()) {
        if (this.term !== undefined) {
          this.term.write(event.data);
        } else {
          this.pending += event.data;
        }
      }
    });
    const offExit = this.morse.onTerminalExit((event) => {
      if (event.terminalId === this.id()) {
        this.showExit(event.code, event.error);
      }
    });
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      offOutput();
      offExit();
      this.pending = '';
      this.observer?.disconnect();
      this.term?.dispose();
      // Detach, do not kill: the shell and its scrollback belong to the host, so
      // a hidden panel, a remount or a session switch must not end it. Only the
      // reader closing the pane, the chip or its session sends `terminal/close`
      // (see `TerminalView.close`/`closePane` and `WorkspaceTabs`).
    });
    // A restart or a reconnect hands the pane a *new* host that has never seen
    // this terminal, so keystrokes would go nowhere until it is attached again.
    // The epoch is read even before the emulator exists, so this effect keeps
    // watching it and `start()` attaches once the lazy import resolves.
    effect(() => {
      this.morse.hostEpoch();
      this.attachToHost();
    });
    // The screen element exists only after the first render.
    afterNextRender(() => {
      void this.start();
    });
  }

  private async start(): Promise<void> {
    const host = this.screen()?.nativeElement;
    if (host === undefined) {
      return;
    }
    const [core, fitModule] = await Promise.all([
      importCjs(import('@xterm/xterm')),
      importCjs(import('@xterm/addon-fit')),
    ]);
    // A fold or a close while the chunk was loading: nothing to attach to.
    if (this.destroyed) {
      return;
    }
    const term = new core.Terminal({
      cursorBlink: true,
      fontFamily: this.monoFont(),
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5_000,
      theme: this.theme(),
    });
    const fit = new fitModule.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    this.term = term;
    this.fit = fit;

    // GPU renderer when the browser allows it; xterm keeps its canvas/DOM
    // renderer when it does not (a lost context disposes the addon).
    void this.enableWebgl(term);

    // Raw keystrokes go straight to the PTY — the shell does its own line
    // editing and echo, exactly like a desktop terminal.
    term.onData((data) => this.morse.sendTerminal(this.id(), data));
    term.onResize(({ cols, rows }) => this.morse.resizeTerminal(this.id(), cols, rows));
    // OSC 0/2: the shell names the tab (its cwd, or the command it is running).
    term.onTitleChange((title) => this.titleChange.emit(title));
    // OSC 7: the shell names its current directory on every prompt, which is how
    // a restored pane reopens where the reader left it (not the session's root).
    term.parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7(data);
      if (cwd !== undefined) {
        this.cwdChange.emit(cwd);
      }
      return true;
    });
    // `http://localhost:5199/` in a dev-server banner is one click, not a copy.
    registerTerminalLinks(term, (url) => this.openExternal(url));
    // Whatever the host flushed before the emulator existed (a restart replay).
    if (this.pending.length > 0) {
      term.write(this.pending);
      this.pending = '';
    }
    this.fitNow();
    this.attachToHost();
    term.focus();

    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.fitNow());
      this.observer.observe(host);
    }
  }

  /**
   * Attaches the emulator to a shell on the current host. Called once when the
   * emulator is ready, and again whenever the host epoch moves. A re-attach
   * clears the emulator first: the host replays its whole scrollback, and
   * painting that over what is already on screen would double it.
   */
  private attachToHost(): void {
    const term = this.term;
    if (term === undefined) {
      return;
    }
    const epoch = this.morse.hostEpoch();
    if (epoch === this.openedEpoch) {
      return;
    }
    const reattach = this.openedEpoch >= 0;
    this.openedEpoch = epoch;
    if (reattach) {
      term.reset();
      this.ended.set(undefined);
    }
    this.morse.openTerminal(this.id(), { cwd: this.cwd(), cols: term.cols, rows: term.rows });
  }

  private async enableWebgl(term: XTermInstance): Promise<void> {
    try {
      const { WebglAddon } = await importCjs(import('@xterm/addon-webgl'));
      if (this.destroyed || this.term !== term) {
        return;
      }
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
      webgl.onContextLoss(() => webgl.dispose());
    } catch {
      // No WebGL (or no addon): the default renderer is fine.
    }
  }

  /**
   * Opens a link found in the terminal output. This panel is the browser host's
   * (VS Code keeps its own terminal), so a new tab is the way out; a webview
   * would need a host command, but this emulator is never mounted there.
   */
  private openExternal(url: string): void {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  protected restart(): void {
    this.ended.set(undefined);
    this.term?.write('\r\n');
    this.morse.openTerminal(this.id(), {
      cwd: this.cwd(),
      cols: this.term?.cols,
      rows: this.term?.rows,
    });
    this.term?.focus();
  }

  private showExit(code?: number, error?: string): void {
    const message =
      error !== undefined
        ? `\r\n\x1b[31m${error}\x1b[0m\r\n`
        : `\r\n\x1b[90m[process exited${code === undefined ? '' : ` with code ${code}`}]\x1b[0m\r\n`;
    this.term?.write(message);
    this.ended.set({ code, error });
  }

  /** Fits the grid to the panel; skips a hidden panel (a fold is zero-sized). */
  private fitNow(): void {
    const host = this.screen()?.nativeElement;
    if (host === undefined || host.clientWidth === 0 || host.clientHeight === 0) {
      return;
    }
    try {
      this.fit?.fit();
    } catch {
      // A transient layout the fit addon cannot measure yet: the next resize wins.
    }
  }

  /** The UI's monospace stack, so the terminal matches the rest of Morse. */
  private monoFont(): string {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--morse-font-mono')
      .trim();
    return value.length > 0 ? value : 'monospace';
  }

  /**
   * The panel's palette, read from the active theme so the terminal matches it.
   */
  private theme(): ITheme {
    const read = (name: string): string =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return {
      background: read('--morse-bg'),
      foreground: read('--morse-fg'),
      cursor: read('--morse-accent'),
      selectionBackground: read('--morse-hover'),
    };
  }
}

/**
 * xterm ships CommonJS, and a production bundle wraps a lazily imported CJS
 * module as `{ default: exports }` — while its typings (and the dev server)
 * expose the names directly. Unwrapping the default when it is there keeps both
 * shapes working; without it `core.Terminal` is `undefined` in the packaged
 * build and the pane stays blank forever (the lazy import never rejects).
 */
async function importCjs<T>(module: Promise<T>): Promise<T> {
  const loaded = (await module) as T & { default?: T };
  return loaded.default ?? loaded;
}

/**
 * The directory in an OSC 7 payload (`file://host/path`, percent-encoded). An
 * empty host is the usual form a local shell emits; anything that is not a file
 * URL is not a directory and is ignored rather than guessed at.
 */
export function parseOsc7(data: string): string | undefined {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  if (match === null) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}
