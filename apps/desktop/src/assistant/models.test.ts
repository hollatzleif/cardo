import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MODEL_CATALOG,
  effectiveSpeedTier,
  fastestModelId,
  rateModels,
  type HwSummary,
  type ModelRating,
  type RatedModel,
} from './models';

const ALL_IDS = [
  'qwen3-0.6b',
  'qwen3-1.7b',
  'qwen3-4b',
  'qwen3-8b',
  'qwen3-14b',
  'qwen3-30b-a3b',
  'phi-4-mini',
  'phi-4',
  'mistral-7b',
  'mistral-small-24b',
  'granite-3.1-8b',
  'deepseek-r1-7b',
  'llama-3.2-1b',
  'llama-3.2-3b',
  'llama-3.1-8b',
  'gemma-3-4b',
  'gemma-3-12b',
  'gemma-3-27b',
];

function byId(rated: RatedModel[], id: string): RatedModel {
  const found = rated.find((r) => r.model.id === id);
  if (!found) throw new Error(`model ${id} missing`);
  return found;
}

/** The full expected rating matrix: 4 hardware profiles × all 18 models. */
const HW: Record<string, HwSummary> = {
  'x86-8gb': { totalRamMb: 8192, appleSilicon: false },
  'as-8gb': { totalRamMb: 8192, appleSilicon: true },
  'as-16gb': { totalRamMb: 16_384, appleSilicon: true },
  'as-32gb': { totalRamMb: 32_768, appleSilicon: true },
};

const EXPECTED: Record<string, Record<string, ModelRating>> = {
  'x86-8gb': {
    'qwen3-0.6b': 'ok',
    'qwen3-1.7b': 'ok',
    'qwen3-4b': 'tooBig',
    'qwen3-8b': 'tooBig',
    'qwen3-14b': 'tooBig',
    'qwen3-30b-a3b': 'tooBig',
    'phi-4-mini': 'tooBig',
    'phi-4': 'tooBig',
    'mistral-7b': 'tooBig',
    'mistral-small-24b': 'tooBig',
    'granite-3.1-8b': 'tooBig',
    'deepseek-r1-7b': 'tooBig',
    'llama-3.2-1b': 'ok',
    'llama-3.2-3b': 'ok',
    'llama-3.1-8b': 'tooBig',
    'gemma-3-4b': 'tooBig',
    'gemma-3-12b': 'tooBig',
    'gemma-3-27b': 'tooBig',
  },
  'as-8gb': {
    'qwen3-0.6b': 'great',
    'qwen3-1.7b': 'great',
    'qwen3-4b': 'ok',
    'qwen3-8b': 'tooBig',
    'qwen3-14b': 'tooBig',
    'qwen3-30b-a3b': 'tooBig',
    'phi-4-mini': 'ok',
    'phi-4': 'tooBig',
    'mistral-7b': 'tooBig',
    'mistral-small-24b': 'tooBig',
    'granite-3.1-8b': 'tooBig',
    'deepseek-r1-7b': 'tooBig',
    'llama-3.2-1b': 'great',
    'llama-3.2-3b': 'great',
    'llama-3.1-8b': 'tooBig',
    'gemma-3-4b': 'ok',
    'gemma-3-12b': 'tooBig',
    'gemma-3-27b': 'tooBig',
  },
  'as-16gb': {
    'qwen3-0.6b': 'great',
    'qwen3-1.7b': 'great',
    'qwen3-4b': 'great',
    'qwen3-8b': 'great',
    'qwen3-14b': 'ok',
    'qwen3-30b-a3b': 'tooBig',
    'phi-4-mini': 'great',
    'phi-4': 'ok',
    'mistral-7b': 'great',
    'mistral-small-24b': 'tooBig',
    'granite-3.1-8b': 'great',
    'deepseek-r1-7b': 'great',
    'llama-3.2-1b': 'great',
    'llama-3.2-3b': 'great',
    'llama-3.1-8b': 'great',
    'gemma-3-4b': 'great',
    'gemma-3-12b': 'ok',
    'gemma-3-27b': 'tooBig',
  },
  'as-32gb': {
    'qwen3-0.6b': 'great',
    'qwen3-1.7b': 'great',
    'qwen3-4b': 'great',
    'qwen3-8b': 'great',
    'qwen3-14b': 'great',
    'qwen3-30b-a3b': 'great',
    'phi-4-mini': 'great',
    'phi-4': 'great',
    'mistral-7b': 'great',
    'mistral-small-24b': 'ok',
    'granite-3.1-8b': 'great',
    'deepseek-r1-7b': 'great',
    'llama-3.2-1b': 'great',
    'llama-3.2-3b': 'great',
    'llama-3.1-8b': 'great',
    'gemma-3-4b': 'great',
    'gemma-3-12b': 'great',
    'gemma-3-27b': 'ok',
  },
};

describe('rateModels matrix', () => {
  for (const [hwName, hw] of Object.entries(HW)) {
    it(`rates every model exactly as expected on ${hwName}`, () => {
      const rated = rateModels(hw);
      for (const id of ALL_IDS) {
        expect(byId(rated, id).rating, `${id} on ${hwName}`).toBe(EXPECTED[hwName]?.[id]);
      }
    });
  }

  it('recommends the biggest usable model per profile', () => {
    expect(rateModels(HW['x86-8gb']!).find((r) => r.recommended)?.model.id).toBe('llama-3.2-3b');
    expect(rateModels(HW['as-8gb']!).find((r) => r.recommended)?.model.id).toBe('llama-3.2-3b');
    expect(rateModels(HW['as-16gb']!).find((r) => r.recommended)?.model.id).toBe('granite-3.1-8b');
    expect(rateModels(HW['as-32gb']!).find((r) => r.recommended)?.model.id).toBe('qwen3-30b-a3b');
  });

  it('marks at most one model as recommended', () => {
    for (const hw of Object.values(HW)) {
      expect(rateModels(hw).filter((r) => r.recommended)).toHaveLength(1);
    }
  });

  it('tooBig models have speed "na"', () => {
    const rated = rateModels(HW['as-8gb']!);
    expect(byId(rated, 'qwen3-8b').speed).toBe('na');
  });
});

describe('MoE handling', () => {
  it('rates speed by active params but RAM by ramNeedMb', () => {
    const moe = MODEL_CATALOG.find((m) => m.id === 'qwen3-30b-a3b')!;
    expect(moe.moeActiveB).toBe(3);
    expect(effectiveSpeedTier(moe)).toBe('small');
    // Doesn't fit into 16 GB despite its small effective tier …
    expect(byId(rateModels(HW['as-16gb']!), 'qwen3-30b-a3b').rating).toBe('tooBig');
    // … but on 32 GB it rates like a small model: great and veryFast.
    const on32 = byId(rateModels(HW['as-32gb']!), 'qwen3-30b-a3b');
    expect(on32.rating).toBe('great');
    expect(on32.speed).toBe('veryFast');
  });
});

describe('fastestModelId', () => {
  it('picks the smallest dense model', () => {
    expect(fastestModelId(['qwen3-8b', 'qwen3-0.6b', 'gemma-3-12b'])).toBe('qwen3-0.6b');
  });

  it('treats MoE models by their active size', () => {
    expect(fastestModelId(['qwen3-30b-a3b', 'qwen3-8b'])).toBe('qwen3-30b-a3b');
    // A real 3B dense file is still smaller than the MoE's ~3B active set.
    expect(fastestModelId(['llama-3.2-3b', 'qwen3-30b-a3b'])).toBe('llama-3.2-3b');
  });

  it('ignores unknown ids and falls back to the first id', () => {
    expect(fastestModelId(['does-not-exist', 'qwen3-4b'])).toBe('qwen3-4b');
    expect(fastestModelId(['does-not-exist'])).toBe('does-not-exist');
    expect(fastestModelId([])).toBe('');
  });
});

describe('catalog integrity', () => {
  it('ships exactly the expected 18 models with unique ids', () => {
    expect(MODEL_CATALOG.map((m) => m.id)).toEqual(ALL_IDS);
    expect(new Set(MODEL_CATALOG.map((m) => m.id)).size).toBe(MODEL_CATALOG.length);
  });

  it('every entry is sane (url, sizes, template, license)', () => {
    const templates = new Set(['chatml', 'gemma', 'llama3', 'phi']);
    for (const m of MODEL_CATALOG) {
      expect(m.url, m.id).toMatch(/^https:\/\/huggingface\.co\/.+\.gguf$/);
      expect(m.sizeBytes, m.id).toBeGreaterThan(0);
      expect(m.ramNeedMb, m.id).toBeGreaterThan(0);
      expect(templates.has(m.template), `${m.id} template`).toBe(true);
      expect(m.license.name, m.id).toBeTruthy();
      expect(m.license.url, m.id).toMatch(/^https:\/\//);
    }
  });

  it('keeps the four original Qwen entries on chatml', () => {
    for (const id of ['qwen3-0.6b', 'qwen3-1.7b', 'qwen3-4b', 'qwen3-8b']) {
      expect(MODEL_CATALOG.find((m) => m.id === id)?.template).toBe('chatml');
    }
  });

  it('llama/gemma entries carry their license notices', () => {
    for (const id of ['llama-3.2-1b', 'llama-3.2-3b', 'llama-3.1-8b']) {
      expect(MODEL_CATALOG.find((m) => m.id === id)?.license.notice).toBe('llama');
    }
    for (const id of ['gemma-3-4b', 'gemma-3-12b', 'gemma-3-27b']) {
      expect(MODEL_CATALOG.find((m) => m.id === id)?.license.notice).toBe('gemma-consent');
    }
  });

  it('all strengths/weaknesses/idealFor i18n keys exist in the real EN and DE locales', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const localesDir = join(here, '..', '..', '..', '..', 'packages', 'i18n', 'locales');
    const lookup = (data: unknown, key: string): unknown =>
      key.split('.').reduce<unknown>(
        (obj, part) =>
          typeof obj === 'object' && obj !== null
            ? (obj as Record<string, unknown>)[part]
            : undefined,
        data,
      );

    for (const lang of ['en', 'de']) {
      const data = JSON.parse(readFileSync(join(localesDir, lang, 'common.json'), 'utf8'));
      for (const m of MODEL_CATALOG) {
        for (const key of [m.strengthsKey, m.weaknessesKey, m.idealForKey]) {
          const value = lookup(data, key);
          expect(typeof value, `${lang}: ${key}`).toBe('string');
          expect((value as string).trim(), `${lang}: ${key}`).not.toBe('');
        }
      }
    }
  });
});
