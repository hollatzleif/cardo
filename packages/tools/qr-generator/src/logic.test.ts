import { describe, expect, it } from 'vitest';
import { placeholder } from './logic';

describe('qr-generator logic', () => {
  it('placeholder passes values through', () => {
    expect(placeholder(7)).toBe(7);
  });
});
