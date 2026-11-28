import { describe, expect, it } from 'vitest';
import { questionAnswers, toFormRequest, toPermissionRequest, toQuestionRequest } from './form-mapping.js';

describe('toFormRequest', () => {
  it('never throws on a form shell with no fields array', () => {
    const request = toFormRequest({ id: 'f1' } as never);
    expect(request.requestId).toBe('f1');
    expect(request.fields).toEqual([]);
  });

  it('drops null fields and fields with no key instead of crashing', () => {
    const request = toFormRequest({
      id: 'f2',
      title: '',
      fields: [null, { title: 'no key' }, { key: 'a', type: 'string' }],
    } as never);
    expect(request.fields.map((field) => field.key)).toEqual(['a']);
  });
});

describe('toPermissionRequest', () => {
  it('reads the 1.x permission/patterns shape like the 2.x action/resources one', () => {
    const fromV1 = toPermissionRequest({
      id: 'p1',
      sessionID: 's',
      permission: 'read',
      patterns: ['*.log'],
    });
    expect(fromV1.title).toBe('Allow read?');
    expect(fromV1.message).toBe('*.log');

    const fromV2 = toPermissionRequest({
      id: 'p2',
      sessionID: 's',
      action: 'read',
      resources: ['*.log'],
    });
    expect(fromV2.title).toBe('Allow read?');
    expect(fromV2.message).toBe('*.log');
  });
});

describe('toQuestionRequest', () => {
  it('maps one fixed-choice 1.x question to a single-field form', () => {
    const request = toQuestionRequest({
      id: 'q1',
      questions: [
        {
          question: 'Pick one',
          header: 'Choice',
          options: [
            { label: 'a', description: 'first' },
            { label: 'b' },
          ],
        },
      ],
    });
    expect(request?.kind).toBe('form');
    expect(request?.requestId).toBe('q1');
    if (request?.kind === 'form') {
      expect(request.fields.map((field) => field.key)).toEqual(['q0']);
      expect(request.fields[0]?.options?.map((option) => option.value)).toEqual(['a', 'b']);
    }
    expect(
      questionAnswers(
        { id: 'q1', questions: [{ question: 'Pick one', options: [{ label: 'a' }] }] },
        { q0: 'a' },
      ),
    ).toEqual([['a']]);
  });

  it('merges multi-select picks with a custom answer in order', () => {
    const request = toQuestionRequest({
      id: 'q2',
      questions: [
        {
          question: 'Pick any',
          multiple: true,
          custom: true,
          options: [{ label: 'a' }, { label: 'b' }],
        },
      ],
    });
    expect(request?.kind).toBe('form');
    if (request?.kind === 'form') {
      expect(request.fields.map((field) => field.key)).toEqual(['q0', 'q0~custom']);
    }
    expect(
      questionAnswers(
        {
          id: 'q2',
          questions: [{ question: 'Pick any', multiple: true, options: [{ label: 'a' }] }],
        },
        { q0: ['a', 'b'], 'q0~custom': 'c' },
      ),
    ).toEqual([['a', 'b', 'c']]);
  });

  it('skips questions with nothing answerable', () => {
    expect(toQuestionRequest({ id: 'q3', questions: [] })).toBeUndefined();
    expect(toQuestionRequest({ id: 'q4', questions: [{ question: 'empty' }] })).toBeUndefined();
  });
});
