/**
 * The meta line under a message: when it was said, and — in code mode — which
 * model answered. Pure formatting, so every surface (the code transcript, bot
 * chat) words it the same way.
 */
import type { ModelOption } from '@morse/protocol';

/**
 * The wall clock for a message (`14:32`), or `''` when the row carries no
 * timestamp — a persisted history entry older than timestamps. Callers render
 * nothing for an empty string rather than a placeholder.
 */
export function clockTime(at: number): string {
  if (at <= 0) {
    return '';
  }
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The full date and time, for the stamp's tooltip. */
export function fullTime(at: number): string {
  if (at <= 0) {
    return '';
  }
  return new Date(at).toLocaleString();
}

/** What a model stamp reads as on screen, and what its tooltip says. */
export interface ModelMeta {
  label: string;
  title: string;
}

/**
 * Resolves the model a transcript row names against the catalog the picker
 * shows, so an answer reads `GLM-5.3-Flash` instead of `glm-5.3-flash`.
 *
 * Two identifier shapes reach here: pi persists a bare id (`glm-5.3-flash`),
 * OpenCode persists `provider/id`. A model the catalog no longer lists keeps
 * its raw identifier — an answer never loses the name it was given.
 */
export function modelMeta(
  model: string | undefined,
  catalog: readonly ModelOption[],
): ModelMeta | undefined {
  if (model === undefined || model.length === 0) {
    return undefined;
  }
  const found = catalog.find((option) => `${option.provider}/${option.id}` === model) ??
    catalog.find((option) => option.id === model);
  if (found === undefined) {
    return { label: model, title: model };
  }
  return { label: found.name, title: `${found.provider}/${found.id}` };
}
