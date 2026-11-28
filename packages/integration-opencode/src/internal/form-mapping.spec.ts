import { describe, expect, it } from 'vitest';
import { toFormRequest } from './form-mapping.js';

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
