import type {
  BotConfig,
  BotConversationSummary,
  BotCreateInput,
  BotGroupCreateInput,
  BotGroupUpdateInput,
  BotOutgoingAttachments,
  BotProviderCredentialInput,
  BotRoutingState,
  BotUpdateInput,
  BotUsage,
} from '@morse/protocol';
import type { AuthUser } from '@morse/protocol';
import type { ModelRef } from '@morse/agent';
import type { BotProviderModel } from './types.js';
import type { BotKnownUser } from './service.js';
import type { TranscriptSlice } from './transcripts.js';
import type { BotControllerPort, BotRoster, BotService } from './service.js';

/**
 * One reader's lens over the shared bot service (Slack semantics: two readers
 * talking to the same bot never share a room).
 *
 * Bot *definitions* stay global — every reader sees the same apps — but only
 * an admin may manage them: a scoped reader whose login role is not `admin`
 * is refused at `createBot`, `updateBot`, `deleteBot` and `inspectBot` (the
 * last reads stored keys and bot env, so it is management too). Chatting,
 * groups and discussions stay per reader. Every *conversation* belongs to the
 * login user who opened it. The
 * DM alias `dm-<bot>` the sidebar has always used resolves to the caller's own
 * room (`dm:<ownerId>:<bot>`, created on first open), so the frontend needs no
 * new wire: every id it already holds keeps working, per reader.
 *
 * Undefined `ownerId` is the unscoped single-user lens: everything visible,
 * exactly like talking to the service directly.
 */
export class ScopedBotPort implements BotControllerPort {
  private readonly ownerId?: string;
  private readonly owner?: BotKnownUser;
  /** True when the login role behind this lens is not `admin`: definitions are read-only. */
  private readonly manageDenied: boolean;

  constructor(
    private readonly service: BotService,
    owner?: string | AuthUser,
  ) {
    if (typeof owner === 'string' || owner === undefined) {
      this.ownerId = owner;
      this.manageDenied = false;
    } else {
      this.ownerId = owner.id;
      this.owner = { id: owner.id, username: owner.username, name: owner.name ?? owner.username };
      this.manageDenied = owner.role !== 'admin';
    }
  }

  /** True for a conversation id this reader's UI may name. */
  private isAlias(id: string): boolean {
    // The legacy `dm-<bot>` shape doubles as the per-user alias: a scoped
    // reader naming it means their own room. Owned storage ids (`dm__…`)
    // never match, so they pass through untouched.
    return id.startsWith('dm-') && !id.startsWith('dm__');
  }

  /** The storage id behind a UI-named id: owned DMs resolve per owner. */
  private resolve(id: string): string {
    if (this.ownerId !== undefined && this.isAlias(id)) {
      return this.service.resolveDm(id.slice('dm-'.length), this.ownerId).id;
    }
    return id;
  }

  /**
   * The UI-named id for a storage id, for pushed events: an owned room reads
   * as its `dm-<bot>` alias, so a second reader's socket never learns the
   * first reader's storage key. Non-DM rooms and unscoped mode pass through.
   */
  displayId(id: string): string {
    if (this.ownerId === undefined) {
      return id;
    }
    const prefix = `dm__${this.ownerId}__`;
    return id.startsWith(prefix) ? `dm-${id.slice(prefix.length)}` : id;
  }

  /** Whether a storage id belongs in this reader's sidebar. */
  visible(id: string): boolean {
    if (this.ownerId === undefined) {
      return true;
    }
    const owner = this.service.ownerOf(id);
    // Legacy rooms (written before owners) stay invisible once scoped: they
    // belong to nobody, so showing them would leak the shared past.
    return owner === this.ownerId;
  }

  /** Throws when this reader may not manage bot definitions — unscoped lenses stay open. */
  private requireManage(): void {
    if (this.manageDenied) {
      throw new Error('Only an admin can manage bots.');
    }
  }

  /** Throws when this reader may not touch the room — BotWire turns it into a notice. */
  private requireVisible(id: string): string {
    const storageId = this.isAlias(id) && this.ownerId !== undefined ? this.resolve(id) : id;
    if (!this.visible(storageId)) {
      throw new Error('That conversation belongs to another user.');
    }
    return storageId;
  }

  roster(): BotRoster {
    const roster = this.service.roster();
    if (this.ownerId === undefined) {
      return roster;
    }
    // Readers address DMs by the alias they opened (`dm-<bot>`), never by
    // the storage id the room lives under.
    return {
      ...roster,
      conversations: roster.conversations
        .filter((conversation) => this.visible(conversation.id))
        .map((conversation) => {
          const shownAs = this.displayId(conversation.id);
          return conversation.id === shownAs ? conversation : { ...conversation, id: shownAs };
        }),
    };
  }

  createBot(input: BotCreateInput): Promise<void> {
    this.requireManage();
    return this.service.createBot(input);
  }

  deleteBot(username: string): Promise<void> {
    this.requireManage();
    return this.service.deleteBot(username);
  }

  inspectBot(username: string): BotConfig {
    this.requireManage();
    return this.service.inspectBot(username);
  }

  updateBot(input: BotUpdateInput): Promise<void> {
    this.requireManage();
    return this.service.updateBot(input);
  }

  createGroup(input: BotGroupCreateInput): BotConversationSummary {
    const summary = this.service.createGroup(input);
    // Groups belong to whoever made them — Slack DMs and channels alike.
    if (this.ownerId !== undefined) {
      this.service.setConversationOwner(summary.id, this.ownerId);
    }
    return summary;
  }

  updateGroup(input: BotGroupUpdateInput): Promise<BotConversationSummary> {
    this.requireVisible(input.id);
    return this.service.updateGroup(input);
  }

  deleteGroup(id: string): Promise<void> {
    this.requireVisible(id);
    return this.service.deleteGroup(id);
  }

  deleteThread(id: string): Promise<void> {
    this.requireVisible(id);
    return this.service.deleteThread(id);
  }

  probeModels(
    kind: string,
    envVars: string[],
    credentials: { provider: string; apiKey: string }[],
    extraEnv?: Record<string, string>,
    useGlobalConfig?: boolean,
  ): Promise<ModelRef[]> {
    return this.service.probeModels(kind, envVars, credentials, extraEnv, useGlobalConfig);
  }

  discoverModels(
    baseUrl: string,
    credential: BotProviderCredentialInput,
  ): Promise<BotProviderModel[]> {
    return this.service.discoverModels(baseUrl, credential);
  }

  open(conversationId: string, limit?: number): TranscriptSlice {
    // Opening a DM alias creates the owned room on first touch.
    const storageId =
      this.ownerId !== undefined && this.isAlias(conversationId)
        ? this.resolve(conversationId)
        : this.requireVisible(conversationId);
    return this.service.open(storageId, limit);
  }

  history(
    conversationId: string,
    beforeId: string | undefined,
    limit?: number,
  ): TranscriptSlice {
    return this.service.history(this.requireVisible(conversationId), beforeId, limit);
  }

  send(conversationId: string, text: string, attachments?: BotOutgoingAttachments): Promise<void> {
    return this.service.send(this.requireVisible(conversationId), text, attachments, this.owner);
  }

  stop(conversationId: string, username?: string, followAsks = false): void {
    return this.service.stop(this.requireVisible(conversationId), username, followAsks);
  }

  newDiscussion(conversationId: string): void {
    return this.service.newDiscussion(this.requireVisible(conversationId));
  }

  clear(conversationId: string): Promise<void> {
    return this.service.clear(this.requireVisible(conversationId));
  }

  compact(conversationId: string): Promise<void> {
    return this.service.compact(this.requireVisible(conversationId));
  }

  routing(conversationId: string): BotRoutingState | null {
    return this.service.routing(this.requireVisible(conversationId));
  }

  usages(conversationId: string): BotUsage[] {
    const resolved = this.requireVisible(conversationId);
    // The wire echoes usage rows into the room the reader named: counters
    // stored under the room's storage id are shown under its alias.
    return this.service
      .usages(resolved)
      .map((usage) =>
        usage.conversationId === resolved
          ? { ...usage, conversationId: this.displayId(resolved) }
          : usage,
      );
  }
}

