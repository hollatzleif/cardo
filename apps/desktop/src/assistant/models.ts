/**
 * Local model catalog + hardware rating.
 * Pure module (no host, no Tauri) – fully unit-tested in models.test.ts.
 *
 * Model files are only downloaded from huggingface.co when the user
 * explicitly presses install. Every entry carries its license (with an
 * optional UI notice for Llama/Gemma terms) and honest strength/weakness
 * i18n keys under assistant.model.<id-with-dashes>.*.
 */

/** Speed class by (effective) parameter count – drives the speed rating. */
export type ModelTier = 'mini' | 'small' | 'medium' | 'large' | 'xl' | 'xxl';

export type PromptTemplate = 'chatml' | 'gemma' | 'llama3' | 'phi';

export interface ModelLicense {
  name: string;
  url: string;
  /** UI must show a license notice ('llama') or ask for consent ('gemma-consent'). */
  notice?: 'llama' | 'gemma-consent';
}

export interface ModelDef {
  id: string;
  tier: ModelTier;
  label: string;
  sizeBytes: number;
  ramNeedMb: number;
  url: string;
  template: PromptTemplate;
  license: ModelLicense;
  /** i18n keys (assistant.model.<id-with-dashes>.*) – honest plain language. */
  strengthsKey: string;
  weaknessesKey: string;
  idealForKey: string;
  /** MoE models: active parameters in billions (speed of a small model). */
  moeActiveB?: number;
}

const APACHE: ModelLicense = {
  name: 'Apache-2.0',
  url: 'https://www.apache.org/licenses/LICENSE-2.0',
};
const MIT: ModelLicense = { name: 'MIT', url: 'https://opensource.org/license/mit' };
const LLAMA_32: ModelLicense = {
  name: 'Llama 3.2 Community License',
  url: 'https://www.llama.com/llama3_2/license/',
  notice: 'llama',
};
const LLAMA_31: ModelLicense = {
  name: 'Llama 3.1 Community License',
  url: 'https://www.llama.com/llama3_1/license/',
  notice: 'llama',
};
const GEMMA: ModelLicense = {
  name: 'Gemma Terms of Use',
  url: 'https://ai.google.dev/gemma/terms',
  notice: 'gemma-consent',
};

/** Model ids contain dots (qwen3-0.6b) – i18next uses '.' as separator. */
export function modelI18nId(id: string): string {
  return id.replace(/\./g, '-');
}

type DefInput = Omit<ModelDef, 'strengthsKey' | 'weaknessesKey' | 'idealForKey'>;

function def(input: DefInput): ModelDef {
  const base = `assistant.model.${modelI18nId(input.id)}`;
  return {
    ...input,
    strengthsKey: `${base}.strengths`,
    weaknessesKey: `${base}.weaknesses`,
    idealForKey: `${base}.idealFor`,
  };
}

export const MODEL_CATALOG: ModelDef[] = [
  def({
    id: 'qwen3-0.6b',
    tier: 'mini',
    label: 'Qwen3 0.6B',
    sizeBytes: 400_000_000,
    ramNeedMb: 2500,
    template: 'chatml',
    license: APACHE,
    url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf',
  }),
  def({
    id: 'qwen3-1.7b',
    tier: 'small',
    label: 'Qwen3 1.7B',
    sizeBytes: 1_830_000_000,
    ramNeedMb: 4500,
    template: 'chatml',
    license: APACHE,
    url: 'https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf',
  }),
  def({
    id: 'qwen3-4b',
    tier: 'medium',
    label: 'Qwen3 4B',
    sizeBytes: 2_330_000_000,
    ramNeedMb: 6500,
    template: 'chatml',
    license: APACHE,
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
  }),
  def({
    id: 'qwen3-8b',
    tier: 'large',
    label: 'Qwen3 8B',
    sizeBytes: 4_680_000_000,
    ramNeedMb: 10500,
    template: 'chatml',
    license: APACHE,
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
  }),
  def({
    id: 'qwen3-14b',
    tier: 'xl',
    label: 'Qwen3 14B',
    sizeBytes: 9_000_000_000,
    ramNeedMb: 12000,
    template: 'chatml',
    license: APACHE,
    url: 'https://huggingface.co/Qwen/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q4_K_M.gguf',
  }),
  def({
    id: 'qwen3-30b-a3b',
    tier: 'xxl',
    label: 'Qwen3 30B A3B (MoE)',
    sizeBytes: 18_600_000_000,
    ramNeedMb: 24000,
    template: 'chatml',
    license: APACHE,
    moeActiveB: 3,
    url: 'https://huggingface.co/Qwen/Qwen3-30B-A3B-GGUF/resolve/main/Qwen3-30B-A3B-Q4_K_M.gguf',
  }),
  def({
    id: 'phi-4-mini',
    tier: 'medium',
    label: 'Phi-4 Mini',
    sizeBytes: 2_500_000_000,
    ramNeedMb: 6000,
    template: 'phi',
    license: MIT,
    url: 'https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/resolve/main/Phi-4-mini-instruct-Q4_K_M.gguf',
  }),
  def({
    id: 'phi-4',
    tier: 'xl',
    label: 'Phi-4',
    sizeBytes: 8_900_000_000,
    ramNeedMb: 12000,
    template: 'phi',
    license: MIT,
    url: 'https://huggingface.co/unsloth/phi-4-GGUF/resolve/main/phi-4-Q4_K_M.gguf',
  }),
  def({
    id: 'mistral-7b',
    tier: 'large',
    label: 'Mistral 7B',
    sizeBytes: 4_400_000_000,
    ramNeedMb: 7500,
    // Mistral v0.3 has its own [INST] format but works acceptably with
    // ChatML for our constrained-JSON use – the JSON grammar constraint does
    // the heavy lifting, the template only frames system/user turns.
    template: 'chatml',
    license: APACHE,
    url: 'https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
  }),
  def({
    id: 'mistral-small-24b',
    tier: 'xxl',
    label: 'Mistral Small 24B',
    sizeBytes: 14_400_000_000,
    ramNeedMb: 20000,
    template: 'chatml',
    license: APACHE,
    url: 'https://huggingface.co/bartowski/Mistral-Small-24B-Instruct-2501-GGUF/resolve/main/Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf',
  }),
  def({
    id: 'granite-3.1-8b',
    tier: 'large',
    label: 'Granite 3.1 8B',
    sizeBytes: 4_950_000_000,
    ramNeedMb: 8000,
    template: 'chatml',
    license: APACHE,
    url: 'https://huggingface.co/bartowski/granite-3.1-8b-instruct-GGUF/resolve/main/granite-3.1-8b-instruct-Q4_K_M.gguf',
  }),
  def({
    id: 'deepseek-r1-7b',
    tier: 'large',
    label: 'DeepSeek R1 7B',
    sizeBytes: 4_700_000_000,
    ramNeedMb: 8000,
    template: 'chatml',
    license: MIT,
    // Weakness: visible chain-of-thought → slow; the Rust think-strip
    // removes <think>…</think> before parsing.
    url: 'https://huggingface.co/unsloth/DeepSeek-R1-Distill-Qwen-7B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf',
  }),
  def({
    id: 'llama-3.2-1b',
    tier: 'mini',
    label: 'Llama 3.2 1B',
    sizeBytes: 810_000_000,
    ramNeedMb: 2500,
    template: 'llama3',
    license: LLAMA_32,
    url: 'https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
  }),
  def({
    id: 'llama-3.2-3b',
    tier: 'small',
    label: 'Llama 3.2 3B',
    sizeBytes: 2_020_000_000,
    ramNeedMb: 4500,
    template: 'llama3',
    license: LLAMA_32,
    url: 'https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
  }),
  def({
    id: 'llama-3.1-8b',
    tier: 'large',
    label: 'Llama 3.1 8B',
    sizeBytes: 4_920_000_000,
    ramNeedMb: 8000,
    template: 'llama3',
    license: LLAMA_31,
    url: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
  }),
  def({
    id: 'gemma-3-4b',
    tier: 'medium',
    label: 'Gemma 3 4B',
    sizeBytes: 2_490_000_000,
    ramNeedMb: 6000,
    template: 'gemma',
    license: GEMMA,
    url: 'https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf',
  }),
  def({
    id: 'gemma-3-12b',
    tier: 'xl',
    label: 'Gemma 3 12B',
    sizeBytes: 7_300_000_000,
    ramNeedMb: 11000,
    template: 'gemma',
    license: GEMMA,
    url: 'https://huggingface.co/unsloth/gemma-3-12b-it-GGUF/resolve/main/gemma-3-12b-it-Q4_K_M.gguf',
  }),
  def({
    id: 'gemma-3-27b',
    tier: 'xxl',
    label: 'Gemma 3 27B',
    sizeBytes: 16_550_000_000,
    ramNeedMb: 22000,
    template: 'gemma',
    license: GEMMA,
    url: 'https://huggingface.co/unsloth/gemma-3-27b-it-GGUF/resolve/main/gemma-3-27b-it-Q4_K_M.gguf',
  }),
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

const TIER_ORDER: Record<ModelTier, number> = {
  mini: 0,
  small: 1,
  medium: 2,
  large: 3,
  xl: 4,
  xxl: 5,
};

function tierForParamsB(b: number): ModelTier {
  if (b <= 1.5) return 'mini';
  if (b <= 3.5) return 'small';
  if (b <= 5) return 'medium';
  if (b <= 9) return 'large';
  if (b <= 16) return 'xl';
  return 'xxl';
}

/**
 * The tier that determines SPEED: MoE models compute like their active
 * parameter count (Qwen3 30B A3B runs like a ~3B model) even though the
 * full weights must fit in RAM (ramNeedMb stays authoritative for tooBig).
 */
export function effectiveSpeedTier(model: ModelDef): ModelTier {
  return model.moeActiveB != null ? tierForParamsB(model.moeActiveB) : model.tier;
}

/** Baseline rating on Apple Silicon (unified memory, fast Metal inference). */
function appleBaseline(tier: ModelTier, totalRamMb: number): ModelRating {
  const idx = TIER_ORDER[tier];
  if (totalRamMb >= 32_000) return idx <= TIER_ORDER.xl ? 'great' : 'ok';
  if (totalRamMb >= 16_000) {
    if (idx <= TIER_ORDER.large) return 'great';
    return tier === 'xl' ? 'ok' : 'slow';
  }
  // Below 16 GB: small models fly, ~4B is usable, 7B+ would crawl.
  if (idx <= TIER_ORDER.small) return 'great';
  return tier === 'medium' ? 'ok' : 'slow';
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
 *   (Apple Silicon gets more headroom thanks to unified memory). MoE models
 *   are checked by ramNeedMb like everyone else – the full expert weights
 *   must be resident.
 * - Speed is rated by the *effective* tier: MoE models rate like their
 *   active parameter count (Qwen3 30B A3B ≈ a 3B model).
 * - x86: everything one step worse; 7B+ never rates better than 'slow'.
 * recommended = biggest (by sizeBytes) 'great' model, else biggest 'ok'.
 */
export function rateModels(hw: HwSummary): RatedModel[] {
  const ramBudget = hw.totalRamMb * (hw.appleSilicon ? 0.85 : 0.7);

  const rated: RatedModel[] = MODEL_CATALOG.map((model) => {
    const speedTier = effectiveSpeedTier(model);
    let rating: ModelRating;
    if (model.ramNeedMb > ramBudget) {
      rating = 'tooBig';
    } else {
      rating = appleBaseline(speedTier, hw.totalRamMb);
      if (!hw.appleSilicon) {
        rating = demote(rating);
        if (TIER_ORDER[speedTier] >= TIER_ORDER.large) rating = 'slow';
      }
    }
    return { model, rating, speed: speedFor(rating, speedTier), recommended: false };
  });

  const pick = (rating: ModelRating): RatedModel | null =>
    rated
      .filter((r) => r.rating === rating)
      .sort((a, b) => b.model.sizeBytes - a.model.sizeBytes)[0] ?? null;

  const recommended = pick('great') ?? pick('ok');
  if (recommended) recommended.recommended = true;
  return rated;
}

/**
 * Effective "how fast does it feel" size in bytes: MoE models count their
 * active parameters (~Q4 bytes per param), dense models their file size.
 */
function effectiveSizeBytes(model: ModelDef): number {
  return model.moeActiveB != null ? model.moeActiveB * 700_000_000 : model.sizeBytes;
}

/**
 * Picks the fastest model of the given ids (smallest effective param/size).
 * Unknown ids are ignored; falls back to the first id when none is known.
 */
export function fastestModelId(modelIds: string[]): string {
  let best = modelIds[0] ?? '';
  let bestSize = Number.POSITIVE_INFINITY;
  for (const id of modelIds) {
    const model = modelById(id);
    if (!model) continue;
    const eff = effectiveSizeBytes(model);
    if (eff < bestSize) {
      bestSize = eff;
      best = id;
    }
  }
  return best;
}
