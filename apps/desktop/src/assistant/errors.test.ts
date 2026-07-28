import { describe, expect, it } from 'vitest';
import { ASSISTANT_ERROR_KEYS, classifyAssistantError, INSUFFICIENT_RAM } from './api';
import { resources } from '@cardo/i18n';

/**
 * Fixtures are the LITERAL strings the Rust side produces. Anything else would
 * test the classifier against itself; these come from:
 *   apps/desktop/src-tauri/src/assistant.rs:97,490,509,612,657
 *   apps/desktop/src-tauri/src/claude.rs:240
 */
const RUST_ERRORS: Array<[string, string]> = [
  [INSUFFICIENT_RAM, 'insufficient-ram'],
  ['model "gemma-3-4b-it-q4" is not downloaded', 'model-not-downloaded'],
  ['busy', 'busy'],
  ['prompt too long: 5000 tokens for context of 4096', 'prompt-too-long'],
  ['llama backend init failed: no metal device', 'backend-init'],
  ['workspace not allowed', 'workspace-forbidden'],
];

describe('assistant error classification', () => {
  for (const [raw, expected] of RUST_ERRORS) {
    it(`"${raw.slice(0, 40)}" → ${expected}`, () => {
      expect(classifyAssistantError(raw)).toBe(expected);
      // Rust rejects with strings, Tauri may surface them as Errors.
      expect(classifyAssistantError(new Error(raw))).toBe(expected);
    });
  }

  it('recognises a logged-out CLI from its stderr', () => {
    expect(classifyAssistantError('Invalid API key · Please run /login')).toBe('not-logged-in');
    expect(classifyAssistantError('authentication_error')).toBe('not-logged-in');
  });

  it('falls back to unknown rather than guessing', () => {
    // The old behaviour for everything; now reserved for the genuinely
    // unrecognised, so the generic message stops hiding known causes.
    expect(classifyAssistantError('some entirely new failure')).toBe('unknown');
    expect(classifyAssistantError('')).toBe('unknown');
    expect(classifyAssistantError(null)).toBe('unknown');
    expect(classifyAssistantError(undefined)).toBe('unknown');
  });

  it('does not mistake unrelated messages for "busy"', () => {
    // "busy" is a substring of ordinary prose; anchoring matters.
    expect(classifyAssistantError('the busybox tool failed')).toBe('unknown');
  });

  it('maps every cause to a distinct, existing translation', () => {
    const keys = Object.values(ASSISTANT_ERROR_KEYS);
    expect(new Set(keys).size, 'two causes share one message').toBe(keys.length);

    for (const [lang, ns] of Object.entries(resources)) {
      for (const key of keys) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (node, part) =>
              node && typeof node === 'object'
                ? (node as Record<string, unknown>)[part]
                : undefined,
            ns.common,
          );
        expect(typeof value, `${lang}: missing "${key}"`).toBe('string');
      }
    }
  });
});
