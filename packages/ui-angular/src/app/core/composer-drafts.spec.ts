import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from './attachments';
import { ComposerDrafts } from './composer-drafts';

function setup() {
  TestBed.configureTestingModule({});
  return {
    drafts: TestBed.inject(ComposerDrafts),
    attachments: TestBed.inject(AttachmentStore),
  };
}

describe('ComposerDrafts', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps a separate message for every tab', () => {
    const { drafts } = setup();

    drafts.use('session-a');
    drafts.setText('for a');
    drafts.use('session-b');
    drafts.setText('for b');

    drafts.use('session-a');
    expect(drafts.text()).toBe('for a');
    drafts.use('session-b');
    expect(drafts.text()).toBe('for b');
  });

  it('reports an untouched tab as empty and a typed one as not', () => {
    const { drafts } = setup();

    drafts.use('draft-1');
    expect(drafts.isEmpty('draft-1')).toBe(true);

    drafts.setText('working on it');
    expect(drafts.isEmpty('draft-1')).toBe(false);
  });

  it('counts attachments as draft content too', () => {
    const { drafts, attachments } = setup();

    drafts.use('draft-1');
    attachments.addMentions(['src/main.ts']);

    expect(drafts.isEmpty('draft-1')).toBe(false);
  });

  it('moves text and attachments when a draft becomes a session', () => {
    const { drafts, attachments } = setup();

    drafts.use('draft-1');
    drafts.setText('the prompt');
    attachments.addMentions(['src/main.ts']);

    drafts.rekey('draft-1', 's1');

    expect(drafts.isEmpty('draft-1')).toBe(true);
    drafts.use('s1');
    expect(drafts.text()).toBe('the prompt');
    expect(attachments.mentions()).toEqual(['src/main.ts']);
  });

  it('drops a closed tab draft', () => {
    const { drafts, attachments } = setup();

    drafts.use('s1');
    drafts.setText('gone soon');
    attachments.addMentions(['a.ts']);

    drafts.forget('s1');
    drafts.use('s1');

    expect(drafts.text()).toBe('');
    expect(attachments.mentions()).toEqual([]);
  });
});
