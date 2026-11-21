/**
 * The `@pin` block a prompt carries for an editor selection: the mention, the
 * selected words, then the annotation. Shared by every engine adapter so the
 * grammar a host writes is the grammar every engine reads.
 */
import { MAX_PIN_EXCERPT, type ChatPin } from '@morse/agent';

export function appendPinMentions(text: string, pins: ChatPin[] | undefined): string {
  if (!pins || pins.length === 0) {
    return text;
  }
  const mentions = pins.map((pin) => pinBlock(pin).join('\n')).join('\n');
  const prose = text.trim();
  return prose.length > 0 ? `${prose}\n\n${mentions}` : mentions;
}

/** One pin's wire block: its mention, its excerpt, then its annotation lines. */
function pinBlock(pin: ChatPin): string[] {
  return [mentionOf(pin), ...excerptLines(pin), ...noteLines(pin.note)];
}

/**
 * A pin's mention: `@path`, `@path:18-20` for whole lines, or
 * `@path:18:45-18:79` when both columns are known. The end line is always
 * written, even on one line, so the grammar never has to guess.
 */
function mentionOf(pin: ChatPin): string {
  if (pin.startLine === undefined) {
    return `@${pin.path}`;
  }
  const endLine = pin.endLine ?? pin.startLine;
  if (pin.startColumn !== undefined && pin.endColumn !== undefined) {
    return `@${pin.path}:${pin.startLine}:${pin.startColumn}-${endLine}:${pin.endColumn}`;
  }
  return `@${pin.path}:${pin.startLine}-${endLine}`;
}

/**
 * The selected words, as a generated `  | ` line. Only a one-line pin carries
 * one, and it is re-capped here so a hand-built pin cannot flood the prompt.
 */
function excerptLines(pin: ChatPin): string[] {
  if (pin.startLine === undefined || (pin.endLine !== undefined && pin.endLine !== pin.startLine)) {
    return [];
  }
  const excerpt = pin.text?.replace(/\r?\n/g, ' ').slice(0, MAX_PIN_EXCERPT);
  return excerpt === undefined || excerpt.length === 0 ? [] : [`  | ${excerpt}`];
}

/** A pin's annotation as wire lines: `  > one`, `  > per`, `  > line`. */
function noteLines(note: string | undefined): string[] {
  const trimmed = note?.trim();
  return trimmed === undefined || trimmed.length === 0
    ? []
    : trimmed.split('\n').map((line) => `  > ${line}`);
}
