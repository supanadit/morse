import type { DraftCard } from '@morse/protocol';
import { readDraftCards, saveDraftCards } from './workbench-store.js';
import type { MorseLogger } from '../logger.js';

/**
 * Draft tabs' compositions (engine, model, thinking level, mode), keyed by
 * draft tab id. Host-owned and persisted (`draft-cards.json`), exactly like the
 * composer queue and for the same reason: a pick must survive a reload, a
 * reconnect or another device with the same tab, and the host must keep
 * draining it with no client connected. Live sessions need no card — their
 * engine persists the choice itself.
 */
const DRAFT_CARDS_VERSION = 1;

function asCard(value: unknown): DraftCard | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const card: DraftCard = {};
  if (typeof candidate['engine'] === 'string' && candidate['engine'].length > 0) {
    card.engine = candidate['engine'];
  }
  const model = candidate['model'];
  if (typeof model === 'object' && model !== null) {
    const entry = model as Record<string, unknown>;
    if (typeof entry['provider'] === 'string' && typeof entry['id'] === 'string') {
      card.model = {
        provider: entry['provider'],
        id: entry['id'],
        ...(typeof entry['name'] === 'string' ? { name: entry['name'] } : {}),
      };
    }
  }
  if (typeof candidate['thinking'] === 'string' && candidate['thinking'].length > 0) {
    card.thinking = candidate['thinking'] as DraftCard['thinking'];
  }
  if (typeof candidate['mode'] === 'string' && candidate['mode'].length > 0) {
    card.mode = candidate['mode'];
  }
  return card.engine === undefined &&
    card.model === undefined &&
    card.thinking === undefined &&
    card.mode === undefined
    ? undefined
    : card;
}

export class DraftCardStore {
  private readonly cards = new Map<string, DraftCard>();

  constructor(
    private readonly dataDir: string | undefined,
    private readonly logger: MorseLogger,
  ) {
    this.load();
  }

  /** Every card, for the hello snapshot a reconnecting device restores from. */
  all(): Record<string, DraftCard> {
    const cards: Record<string, DraftCard> = {};
    for (const [key, card] of this.cards) {
      cards[key] = { ...card };
    }
    return cards;
  }

  get(key: string): DraftCard | undefined {
    return this.cards.get(key);
  }

  /** Records a pick and persists it; an empty card forgets the tab instead. */
  set(key: string, card: DraftCard): void {
    if (
      card.engine === undefined &&
      card.model === undefined &&
      card.thinking === undefined &&
      card.mode === undefined
    ) {
      this.delete(key);
      return;
    }
    // Replays resend the whole composition on every tab switch: only a real
    // change touches the disk and the clients.
    const prev = this.cards.get(key);
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify({ ...card })) {
      return;
    }
    this.cards.set(key, { ...card });
    this.persist();
  }

  delete(key: string): void {
    if (this.cards.delete(key)) {
      this.persist();
    }
  }

  private load(): void {
    if (this.dataDir === undefined) {
      return;
    }
    let saved;
    try {
      saved = readDraftCards(this.dataDir);
    } catch {
      return;
    }
    if (saved === undefined) {
      return;
    }
    const cards = (saved.data as { cards?: unknown } | undefined)?.cards;
    if (typeof cards !== 'object' || cards === null) {
      return;
    }
    for (const [key, value] of Object.entries(cards)) {
      const card = asCard(value);
      if (card !== undefined) {
        this.cards.set(key, card);
      }
    }
  }

  private persist(): void {
    if (this.dataDir === undefined) {
      return;
    }
    try {
      saveDraftCards(this.dataDir, {
        version: DRAFT_CARDS_VERSION,
        data: { cards: this.all() },
      });
    } catch (error) {
      this.logger.warn('The draft picks could not be saved', error);
    }
  }
}
