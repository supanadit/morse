import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ModelInput } from '@morse/protocol';

/** What each modality is called, in the badge's tooltip and the picker's search. */
export const MODEL_INPUT_LABELS: Record<ModelInput, string> = {
  text: 'Text',
  image: 'Vision (images)',
  audio: 'Audio',
  video: 'Video',
  pdf: 'PDF',
};

/** Extra search terms a modality answers to, so “vision” finds an image model. */
const MODEL_INPUT_ALIASES: Record<ModelInput, string> = {
  text: 'text',
  image: 'image vision multimodal',
  audio: 'audio',
  video: 'video',
  pdf: 'pdf',
};

/**
 * Lucide's `type`, `image`, `mic`, `video` and `file-text` glyphs, as stroke
 * paths, so a badge stays crisp at 12px and inherits `currentColor` instead of
 * shipping raster assets. Same approach as the thinking picker's brain.
 */
const MODALITY_PATHS: Record<ModelInput, string[]> = {
  text: ['M4 7V4h16v3', 'M9 20h6', 'M12 4v16'],
  image: [
    'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    'M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21',
  ],
  audio: ['M12 19v3', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0Z'],
  video: [
    'm16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11',
    'M2 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z',
  ],
  pdf: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4'],
};

export interface ModelInputBadge {
  modality: ModelInput;
  label: string;
  paths: string[];
}

/** One badge per modality pi reported; unknown or empty input yields nothing. */
export function modelInputBadges(input: readonly ModelInput[] | undefined): ModelInputBadge[] {
  if (!input) {
    return [];
  }
  return input.map((modality) => ({
    modality,
    label: MODEL_INPUT_LABELS[modality] ?? modality,
    paths: MODALITY_PATHS[modality] ?? MODALITY_PATHS.text,
  }));
}

/** The searchable words a model's modalities contribute to the picker filter. */
export function modelInputKeywords(input: readonly ModelInput[] | undefined): string {
  return input ? input.map((modality) => MODEL_INPUT_ALIASES[modality] ?? modality).join(' ') : '';
}

/**
 * The input modalities a model accepts, as small icons with a tooltip each.
 *
 * pi reports `input` on every model it lists (`["text"]`, `["text","image"]`,
 * …). The badge is how the picker tells a vision model from a text-only one
 * before the reader picks it — an icon per modality, not a wall of words.
 */
@Component({
  selector: 'morse-model-inputs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './model-inputs.html',
  styleUrl: './model-inputs.css',
})
export class ModelInputs {
  readonly input = input<readonly ModelInput[] | undefined>(undefined);
  protected readonly badges = computed(() => modelInputBadges(this.input()));
}
