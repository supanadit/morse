import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { BotConversationSummary } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { Dialog } from '../../ui/dialog/dialog';

/**
 * The New/Edit group dialog: one room over the bots this host runs.
 *
 * Members come from the roster — there is nothing else to pick from — and the
 * lead is deliberately limited to the members chosen here: a bot that is not in
 * the room cannot answer for it. No lead is a real choice: a message that
 * mentions nobody then gets silence rather than an invented speaker.
 *
 * The same form edits an existing group: the shell names it in
 * `ui.groupTarget`, and the roster already carries its summary, so the fields
 * open on what the group is now.
 */
@Component({
  selector: 'morse-bot-group-dialog',
  templateUrl: './bot-group-dialog.html',
  imports: [Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './bot-group-dialog.css',
})
export class BotGroupDialog {
  private readonly morse = inject(MorseService);

  /** The group this dialog edits, read once on open; absent for a new group. */
  private readonly initial = this.initialGroup();

  protected readonly editing = this.initial !== undefined;
  protected readonly bots = computed(() => this.morse.bot.roster()?.bots ?? []);
  protected readonly name = signal(this.initial?.title ?? '');
  protected readonly members = signal<string[]>([...(this.initial?.members ?? [])]);
  protected readonly lead = signal(this.initial?.lead ?? '');
  /** Bot-to-bot relays one human message may set off; the service's own default. */
  protected readonly chainCap = signal(this.initial?.chainCap ?? 8);
  protected readonly ready = computed(
    () => this.name().trim().length > 0 && this.members().length > 0,
  );

  private initialGroup(): BotConversationSummary | undefined {
    const id = this.morse.ui.groupTarget();
    if (id === null) {
      return undefined;
    }
    return (this.morse.bot.roster()?.conversations ?? []).find(
      (conversation) => conversation.id === id && conversation.kind === 'group',
    );
  }

  protected setName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  /** A member's display name: the lead picker names readers, not handles. */
  protected label(username: string): string {
    return this.bots().find((bot) => bot.username === username)?.name ?? username;
  }

  /** Adding or removing a member; a lead that leaves stops being the lead. */
  protected toggleMember(name: string): void {
    this.members.update((members) =>
      members.includes(name) ? members.filter((member) => member !== name) : [...members, name],
    );
    if (!this.members().includes(this.lead())) {
      this.lead.set('');
    }
  }

  protected setLead(event: Event): void {
    this.lead.set((event.target as HTMLSelectElement).value);
  }

  protected setChainCap(event: Event): void {
    const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
    this.chainCap.set(Number.isFinite(parsed) && parsed >= 1 ? parsed : 1);
  }

  protected submit(): void {
    if (!this.ready()) {
      return;
    }
    const lead = this.lead();
    const input = {
      name: this.name().trim(),
      members: [...this.members()],
      ...(lead.length > 0 ? { lead } : {}),
      chainCap: this.chainCap(),
    };
    if (this.initial === undefined) {
      this.morse.createGroup(input);
    } else {
      this.morse.updateGroup({ id: this.initial.id, ...input });
    }
    this.close();
  }

  protected cancel(): void {
    this.close();
  }

  private close(): void {
    this.morse.ui.groupOpen.set(false);
    this.morse.ui.groupTarget.set(null);
  }
}
