/**
 * Local model catalog + hardware rating.
 * Pure module (no host, no Tauri) – fully unit-tested in assistant.test.ts.
 *
 * All models are Apache-2.0 licensed Qwen3 GGUF builds; the file is only
 * downloaded from huggingface.co when the user explicitly presses install.
 */

export type ModelTier = 'mini' | 'small' | 'medium' | 'large';

export interface ModelDef {
  id: string;
  tier: ModelTier;
  label: string;
  sizeBytes: number;
  ramNeedMb: number;
  url: string;
}

export const MODEL_CATALOG: ModelDef[] = [
  {
    id: 'qwen3-0.6b',
    tier: 'mini',
    label: 'Qwen3 0.6B',
    sizeBytes: 400_000_000,
    ramNeedMb: 2500,
    url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf',
  },
  {
    id: 'qwen3-1.7b',
    tier: 'small',
    label: 'Qwen3 1.7B',
    sizeBytes: 1_830_000_000,
    ramNeedMb: 4500,
    url: 'https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf',
  },
  {
    id: 'qwen3-4b',
    tier: 'medium',
    label: 'Qwen3 4B',
    sizeBytes: 2_330_000_000,
    ramNeedMb: 6500,
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
  },
  {
    id: 'qwen3-8b',
    tier: 'large',
    label: 'Qwen3 8B',
    sizeBytes: 4_680_000_000,
    ramNeedMb: 10500,
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
  },
];

export function modelById(id: string): ModelDef | null {
  return MODEL_CATALOG.find((m) => m.id === id) ?? null;
}

export type ModelRating = 'great' | 'ok' | 'slow' | 'tooBig';
/** Coarse speed estimate for the UI ("~how snappy will it feel"). */
export type ModelSpeed = 'veryFast' | 'fast' | 'moderate' | 'slow' | 'na';

export interface RatedModel {
  model: ModelDef;
  rating: ModelRating;
  speed: ModelSpeed;
  recommended: boolean;
}

export interface HwSummary {
  totalRamMb: number;
  appleSilicon: boolean;
}

const TIER_ORDER: Record<ModelTier, number> = { mini: 0, small: 1, medium: 2, large: 3 };

/** Baseline rating on Apple Silicon (unified memory, fast Metal inference). */
function appleBaseline(tier: ModelTier, totalRamMb: number): ModelRating {
  if (totalRamMb >= 16_000) return 'great';
  // Below 16 GB: small models fly, 4B is usable, 8B would crawl.
  if (tier === 'mini' || tier === 'small') return 'great';
  if (tier === 'medium') return 'ok';
  return 'slow';
}

function demote(rating: ModelRating): ModelRating {
  return rating === 'great' ? 'ok' : 'slow';
}

function speedFor(rating: ModelRating, tier: ModelTier): ModelSpeed {
  if (rating === 'tooBig') return 'na';
  if (rating === 'great') return tier === 'mini' || tier === 'small' ? 'veryFast' : 'fast';
  if (rating === 'ok') return 'moderate';
  return 'slow';
}

/**
 * Rates every catalog model against the machine.
 * Heuristic:
 * - tooBig when the model's working RAM exceeds a safe share of total RAM
 *   (Apple Silicon gets more headroom thanks to unified memory – this is
 *   what keeps Qwen3 4B usable on an 8 GB MacBook).
 * - Apple Silicon: 'great' up to 8B on >=16 GB, 4B on 8 GB is 'ok'.
 * - x86: everything one step worse; 8B never rates better than 'slow'.
 * recommended = biggest 'great' model, falling back to the biggest 'ok'.
 */
export function rateModels(hw: HwSummary): RatedModel[] {
  const ramBudget = hw.totalRamMb * (hw.appleSilicon ? 0.85 : 0.7);

  const rated: RatedModel[] = MODEL_CATALOG.map((model) => {
    let rating: ModelRating;
    if (model.ramNeedMb > ramBudget) {
      rating = 'tooBig';
    } else {
      rating = appleBaseline(model.tier, hw.totalRamMb);
      if (!hw.appleSilicon) {
        rating = demote(rating);
        if (model.tier === 'large') rating = 'slow'; // 8B is never better than 'slow' on x86
      }
    }
    return { model, rating, speed: speedFor(rating, model.tier), recommended: false };
  });

  const pick = (rating: ModelRating): RatedModel | null =>
    rated
      .filter((r) => r.rating === rating)
      .sort((a, b) => TIER_ORDER[b.model.tier] - TIER_ORDER[a.model.tier])[0] ?? null;

  const recommended = pick('great') ?? pick('ok');
  if (recommended) recommended.recommended = true;
  return rated;
}
