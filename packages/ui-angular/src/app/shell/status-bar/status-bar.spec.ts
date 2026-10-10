import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostCapabilities } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { StatusBar } from './status-bar';

function render(hostKind: 'vscode' | 'server', tabs: number) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [StatusBar],
    providers: [
      {
        provide: MorseService,
        useValue: {
          // Only the browser host shows the Morse tab strip; VS Code has none.
          capabilities: signal({ hostKind, filePreview: hostKind === 'server' } as HostCapabilities),
          workspace: signal({ cwd: '/work/morse', name: 'morse' }),
        },
      },
      {
        provide: WorkspaceTabs,
        useValue: { tabs: signal(Array.from({ length: tabs }, (_, index) => ({ id: `${index}` }))) },
      },
    ],
  });
  const fixture = TestBed.createComponent(StatusBar);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** The window's facts, and nothing that belongs to the conversation in front. */
describe('StatusBar', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('names the project the window is rooted at', () => {
    const host = render('server', 0);

    expect(host.querySelector('.path')?.textContent).toContain('/work/morse');
  });

  it('names the host serving it: the browser, or a VS Code webview', () => {
    expect(render('server', 0).querySelector('.host')?.textContent).toContain('Browser host');
    expect(render('vscode', 0).querySelector('.host')?.textContent).toContain('VS Code');
  });

  it('counts how much is open, and says so in the singular for one', () => {
    expect(render('server', 1).querySelector('.count')?.textContent?.trim()).toBe('1 tab');
    expect(render('server', 3).querySelector('.count')?.textContent?.trim()).toBe('3 tabs');
  });

  it('hides the tab count where the host shows no Morse tab strip', () => {
    // VS Code has no strip (its own editor tabs are the strip), so counting the
    // sidebar's internal session tabs would name something the reader cannot see.
    expect(render('vscode', 3).querySelector('.count')).toBeNull();
  });
});
