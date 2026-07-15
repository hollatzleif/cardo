import { describe, expect, it } from 'vitest';
import { placeholder } from './logic';

describe('soundscapes logic', () => {
  it('placeholder passes values through', () => {
    expect(placeholder(7)).toBe(7);
  });
});
