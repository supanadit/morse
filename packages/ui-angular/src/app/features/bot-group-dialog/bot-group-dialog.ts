import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MorseService } from '../../host/morse.service';
import { Dialog } from '../../ui/dialog/dialog';

/**
 * The New group dialog: one room over the bots this host runs.
 *
 * Members come from the roster — there is nothing else to pick from — and the
 * lead is deliberately limited to the members chosen here: a bot that is not in
 * the room cannot answer for it. No lead is a real choice: a message that
 * mentions nobody then gets silence rather than an invented speaker.
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

  protected readonly bots = computed(() => this.morse.bot.roster()?.bots ?? []);
  protected readonly name = signal('');
  protected readonly members = signal<string[]>([]);
  protected readonly lead = signal('');
  /** Bot-to-bot relays one human message may set off; the service's own default. */
  protected readonly chainCap = signal(8);
  protected readonly ready = computed(
    () => this.name().trim().length > 0 && this.members().length > 0,
  );

  protected setName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
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
    this.morse.createGroup({
      name: this.name().trim(),
      members: [...this.members()],
      ...(lead.length > 0 ? { lead } : {}),
      chainCap: this.chainCap(),
    });
    this.morse.ui.groupOpen.set(false);
  }

  protected cancel(): void {
    this.morse.ui.groupOpen.set(false);
  }
}
