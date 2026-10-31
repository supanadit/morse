import {
  MODEL_INPUTS,
  THINKING_LEVELS,
  type ModelInput,
  type ModelRef,
  type ThinkingLevel,
} from '@morse/agent';

/**
 * OpenCode's model catalog → the harness contract.
 *
 * OpenCode calls a reasoning effort a *variant*: a model declares
 * `variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }, …]`, and the
 * session's model names the variant in use. Morse's vocabulary is
 * `ThinkingLevel`, so a level is a variant whose id maps onto it — never a level
 * the model has no variant for, which is what makes "a level carried over from
 * another model does not pretend to apply" true by construction.
 *
 * One wrinkle: a session that has not been given a variant reports `"default"`,
 * a sentinel rather than a level. The state must stay renderable, so it maps to a
 * real offered level (preferring `medium`), and the picker never shows a blank.
 */

/** The parts of a `Model.Info` this adapter reads. */
export interface ApiModel {
  id: string;
  modelID?: string;
  providerID: string;
  name?: string;
  variants?: { id: string; settings?: Record<string, unknown> }[];
  limit?: { context?: number; output?: number };
  capabilities?: { input?: string[] };
  enabled?: boolean;
  status?: string;
}

/** Variant ids that mean a Morse level but are spelled differently. */
const VARIANT_ALIASES: Record<string, ThinkingLevel> = { none: 'off' };

/** One catalog model as the picker sees it. Disabled entries are left out. */
export function toModelRefs(models: readonly ApiModel[]): ModelRef[] {
  return models
    .filter((model) => model.enabled !== false && model.status !== 'disabled')
    .map(toModelRef);
}

export function toModelRef(model: ApiModel): ModelRef {
  const input = model.capabilities?.input
    ?.filter((entry): entry is ModelInput => (MODEL_INPUTS as readonly string[]).includes(entry));
  return {
    provider: model.providerID,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.limit?.context === undefined ? {} : { contextWindow: model.limit.context }),
    ...(model.limit?.output === undefined ? {} : { maxTokens: model.limit.output }),
    ...(input === undefined || input.length === 0 ? {} : { input }),
  };
}

/** The levels a model offers, in Morse's order, without duplicates. */
export function thinkingLevelsOf(model: ApiModel | undefined): ThinkingLevel[] {
  if (model === undefined) {
    return [];
  }
  const offered = new Set<ThinkingLevel>();
  for (const variant of model.variants ?? []) {
    const level = levelOfVariant(variant.id);
    if (level !== undefined) {
      offered.add(level);
    }
  }
  return THINKING_LEVELS.filter((level) => offered.has(level));
}

/** The variant id to send for a level, or undefined when the model has none. */
export function variantForLevel(model: ApiModel | undefined, level: ThinkingLevel): string | undefined {
  if (model === undefined) {
    return undefined;
  }
  return (model.variants ?? []).find((variant) => levelOfVariant(variant.id) === level)?.id;
}

/**
 * The level to show for a session's variant.
 *
 * `"default"` (and anything else without a level) is a sentinel, not a level: the
 * session reports the model's preferred level so the picker stays usable, and
 * with no variants the only honest answer is `off`.
 */
export function levelOfVariant(variantId: string | undefined): ThinkingLevel | undefined {
  if (variantId === undefined) {
    return undefined;
  }
  const aliased = VARIANT_ALIASES[variantId];
  if (aliased !== undefined) {
    return aliased;
  }
  return (THINKING_LEVELS as readonly string[]).includes(variantId)
    ? (variantId as ThinkingLevel)
    : undefined;
}

/** The session model's level, tolerating the `default` sentinel. */
export function thinkingLevelOf(
  model: ApiModel | undefined,
  variantId: string | undefined,
): ThinkingLevel {
  const direct = levelOfVariant(variantId);
  if (direct !== undefined) {
    return direct;
  }
  const offered = thinkingLevelsOf(model);
  return offered.includes('medium') ? 'medium' : (offered[0] ?? 'off');
}

/** A model's wire key, for the agent's catalog lookup. */
export function modelKey(model: { providerID: string; id: string }): string {
  return `${model.providerID}/${model.id}`;
}

export { MODEL_INPUTS };
