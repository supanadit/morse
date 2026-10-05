import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { FitAddon } from '@xterm/addon-fit';
import type { ITheme, Terminal as XTermInstance } from '@xterm/xterm';
import { MorseService } from '../../core/morse.service';

/**
 * A real terminal: xterm.js renders the shell's stream (ANSI, colours, cursor,
 * full-screen programs) and forwards keystrokes to the host's PTY, so the panel
 * behaves like a desktop terminal — line editing, resize, Ctrl+C, vim and all.
 *
 * The emulator is imported only when the terminal is first opened: it is large
 * (and CommonJS), and a reader who never opens the panel should not download it.
 *
 * The shell survives a collapse because the panel keeps this component mounted,
 * and is killed when the component is destroyed — closing the tool.
 */
@Component({
  selector: 'morse-terminal',
  templateUrl: './terminal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        position: relative;
        display: flex;
        flex: 1;
        min-width: 0;
        min-height: 0;
      }
      .screen {
        position: relative;
        flex: 1;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }
      .restart {
        position: absolute;
        right: 10px;
        bottom: 10px;
        padding: 3px 10px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-panel, var(--morse-bg));
        color: var(--morse-fg);
        font-size: 11px;
        cursor: pointer;
      }
      .restart:hover {
        background: var(--morse-hover);
      }
    `,
  ],
})
export class Terminal {
  private readonly morse = inject(MorseService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly screen = viewChild<ElementRef<HTMLElement>>('screen');
  /** The terminal's wire id, minted by `TerminalStore` (the session owns it). */
  readonly id = input.required<string>();
  /** The shell's own title (OSC 0/2), so the tab can follow the running command. */
  readonly titleChange = output<string>();

  private term: XTermInstance | undefined;
  private fit: FitAddon | undefined;
  private observer: ResizeObserver | undefined;
  private destroyed = false;

  protected readonly ended = signal<{ code?: number; error?: string } | undefined>(undefined);

  constructor() {
    const offOutput = this.morse.onTerminalOutput((event) => {
      if (event.terminalId === this.id()) {
        this.term?.write(event.data);
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
      this.observer?.disconnect();
      this.term?.dispose();
      this.morse.closeTerminal(this.id());
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
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
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
    this.fitNow();
    this.morse.openTerminal(this.id(), { cols: term.cols, rows: term.rows });
    term.focus();

    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.fitNow());
      this.observer.observe(host);
    }
  }

  private async enableWebgl(term: XTermInstance): Promise<void> {
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
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

  protected restart(): void {
    this.ended.set(undefined);
    this.term?.write('\r\n');
    this.morse.openTerminal(this.id(), { cols: this.term?.cols, rows: this.term?.rows });
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

  /** The panel's palette, read from the active theme so the terminal matches it. */
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
