import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { PromptRail, type RailPrompt } from './prompt-rail';

const PROMPTS: RailPrompt[] = [
  { id: 'p1', preview: 'First prompt' },
  { id: 'p2', preview: 'Second prompt' },
  { id: 'p3', preview: 'Third prompt' },
];

describe('PromptRail', () => {
  let fixture: ComponentFixture<PromptRail>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PromptRail] }).compileComponents();
    fixture = TestBed.createComponent(PromptRail);
  });

  const render = (prompts: RailPrompt[], activeId: string | null = null): HTMLElement => {
    fixture.componentRef.setInput('prompts', prompts);
    fixture.componentRef.setInput('activeId', activeId);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('shows one tick per prompt', () => {
    const host = render(PROMPTS, 'p2');
    expect(host.querySelectorAll('.tick')).toHaveLength(3);
    expect(host.querySelector('.tick.active')).toBeTruthy();
  });

  it('stays hidden for a single prompt', () => {
    const host = render([PROMPTS[0] as RailPrompt]);
    expect(host.querySelector('.rail')).toBeNull();
  });

  it('emits the nearest prompt when the tape is clicked', () => {
    render(PROMPTS);
    const picked: string[] = [];
    fixture.componentInstance.pick.subscribe((id) => picked.push(id));
    const track = fixture.nativeElement.querySelector('.track') as HTMLElement;
    track.dispatchEvent(new MouseEvent('click', { clientY: 0, bubbles: true }));
    expect(picked).toEqual(['p1']);
  });

  it('reveals a preview list while hovering and picks from it', () => {
    render(PROMPTS);
    const picked: string[] = [];
    fixture.componentInstance.pick.subscribe((id) => picked.push(id));
    const track = fixture.nativeElement.querySelector('.track') as HTMLElement;

    track.dispatchEvent(new MouseEvent('mousemove', { clientY: 0, bubbles: true }));
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.row');
    expect(rows).toHaveLength(3);
    expect((rows[0] as HTMLElement).textContent).toContain('First prompt');

    (rows[2] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picked).toEqual(['p3']);
  });
});
