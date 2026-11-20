import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { BotFace } from './bot-face';
import type { BotMood } from './bot-face-moods';

/** A parent, because that is the only way a face is ever drawn. */
@Component({
  selector: 'morse-test-face-host',
  imports: [BotFace],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<morse-bot-face [value]="value()" [seed]="seed()" [mood]="mood()" [size]="52" />`,
})
class FaceHost {
  readonly value = signal('');
  readonly seed = signal('');
  readonly mood = signal<BotMood>('idle');
}

function face(inputs: { value?: string; seed?: string; mood?: BotMood } = {}) {
  const fixture = TestBed.createComponent(FaceHost);
  fixture.componentInstance.value.set(inputs.value ?? '');
  fixture.componentInstance.seed.set(inputs.seed ?? '');
  fixture.componentInstance.mood.set(inputs.mood ?? 'idle');
  fixture.detectChanges();
  const element = fixture.nativeElement.querySelector('morse-bot-face') as HTMLElement;
  return { fixture, element };
}

/** The drawing itself, minus the per-instance gradient id every face gets. */
function shape(element: HTMLElement): string {
  return [...element.querySelectorAll('svg [fill], svg [stroke], svg path, svg ellipse')]
    .map(
      (node) => `${node.getAttribute('d')}|${node.getAttribute('r')}|${node.getAttribute('fill')}`,
    )
    .join('|')
    .replace(/url\(#[\w-]+\)/g, 'url(#face)');
}

describe('BotFace', () => {
  it('draws the same face from the same handle, and another face from another', () => {
    expect(shape(face({ seed: 'sigil' }).element)).toBe(shape(face({ seed: 'sigil' }).element));
    expect(shape(face({ seed: 'loom' }).element)).not.toBe(shape(face({ seed: 'sigil' }).element));
  });

  it('spreads two neighbouring handles far apart on the colour wheel', () => {
    // `sigil` and `loom` are three characters apart, and a plain hash put them
    // five degrees from each other: two orange bots that looked like one bot twice.
    const hue = (seed: string) => {
      const fill = face({ seed }).element.querySelector('rect')?.getAttribute('fill') ?? '';
      const gradient =
        face({ seed }).element.querySelector('stop')?.getAttribute('stop-color') ?? '';
      expect(fill).toContain('url(#morse-face-');
      return Number(/(\d+(?:\.\d+)?)/.exec(gradient)?.[1] ?? '0');
    };

    const gap = Math.abs(hue('sigil') - hue('loom'));
    expect(Math.min(gap, 360 - gap)).toBeGreaterThan(60);
  });

  it('rests two bots on different faces out of the same mood', () => {
    expect(shape(face({ seed: 'sigil' }).element)).not.toBe(shape(face({ seed: 'loom' }).element));
  });

  it('treats one bot as one face, whatever surface asks for it', () => {
    // The roster seeds a handle; a message seeds the name it was written with.
    expect(shape(face({ seed: 'Sigil' }).element)).toBe(shape(face({ seed: ' sigil ' }).element));
  });

  it('gives a bot that has picked nothing a face anyway, from its handle', () => {
    expect(face({ seed: 'sigil' }).element.querySelector('svg')).not.toBeNull();
  });

  it('shows an image for a URL avatar, and the glyph an older bot stored', () => {
    const image = face({ value: 'https://example.test/face.png', seed: 'sigil' });
    expect(image.element.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/face.png',
    );

    const emoji = face({ value: '🦊', seed: 'sigil' });
    expect(emoji.element.querySelector('.glyph')?.textContent?.trim()).toBe('🦊');
    expect(emoji.element.querySelector('svg')).toBeNull();
  });

  it('lets a picked face win over the handle it would have drawn', () => {
    expect(shape(face({ value: 'face:7', seed: 'sigil' }).element)).not.toBe(
      shape(face({ seed: 'sigil' }).element),
    );
  });

  it('settles on one visible face, however fast the moods change', async () => {
    const { fixture, element } = face({ seed: 'sigil' });
    const host = fixture.componentInstance;

    // Faster than a crossfade, so every swap interrupts the one before it: the
    // face must still end up drawn, not stranded transparent.
    for (const mood of ['thinking', 'working', 'excited', 'waiting', 'failed', 'idle'] as const) {
      host.mood.set(mood);
      fixture.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    await new Promise((resolve) => setTimeout(resolve, 450));

    const layers = [...element.querySelectorAll('.layer')] as HTMLElement[];
    expect(layers.length).toBe(1);
    const opacity = layers[0]!.style.opacity;
    expect(opacity === '' || Number(opacity) > 0.99).toBe(true);
    // And the face is still a face: eyes and a mouth inside that one layer.
    expect(element.querySelectorAll('.layer .eyes').length).toBe(1);
    expect(element.querySelector('.layer .eyes')?.children.length).toBeGreaterThan(0);
  });

  it('is the size it is told, and carries its mood as a class', () => {
    const { element } = face({ seed: 'sigil', mood: 'working' });
    const box = element.querySelector('.box') as HTMLElement;
    expect(box.style.width).toBe('52px');
    expect(box.classList.contains('mood-working')).toBe(true);
  });
});
