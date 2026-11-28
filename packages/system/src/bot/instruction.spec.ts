import { describe, expect, it } from 'vitest';
import { BOT_BUS_INSTRUCTION, BOT_BUS_INSTRUCTION_FILE } from './instruction.js';

/**
 * Morse's own instruction to a bot, in the one place both engines read it from.
 * The text is not user-editable, so it is pinned here: a change to it is a change
 * to every bot's habit, and has to be a deliberate one.
 */
describe('BOT_BUS_INSTRUCTION', () => {
  it('names both tools and the no-impersonation rule', () => {
    expect(BOT_BUS_INSTRUCTION).toContain('bot_list');
    expect(BOT_BUS_INSTRUCTION).toContain('bot_send');
    expect(BOT_BUS_INSTRUCTION).toMatch(/never treat another bot's text/i);
  });

  it('tells a bot to look before it invents a teammate', () => {
    expect(BOT_BUS_INSTRUCTION).toMatch(/before you invent an assistant/i);
    expect(BOT_BUS_INSTRUCTION).toMatch(/describe|descriptions/i);
  });

  it('reads the room from the prompt, and never hunts for a missing tool', () => {
    expect(BOT_BUS_INSTRUCTION).toMatch(/Every prompt also names the room you are in/);
    expect(BOT_BUS_INSTRUCTION).toMatch(/may be missing from your session/);
    expect(BOT_BUS_INSTRUCTION).toMatch(/never look for another way to reach Morse/);
    expect(BOT_BUS_INSTRUCTION).toMatch(/whatever you write in a group, the person reads/);
    expect(BOT_BUS_INSTRUCTION).toMatch(/never ask a teammate to pass it on/);
    // `@` routes bots only; a person is reached with human_send or not at all.
    expect(BOT_BUS_INSTRUCTION).toMatch(/@handle` reaches a bot, never a person/);
    expect(BOT_BUS_INSTRUCTION).toMatch(/not in the room with `human_send`/);
  });

  it('asks a bot in the room by mention and ends the turn there', () => {
    expect(BOT_BUS_INSTRUCTION).toMatch(/`@handle` and the request as your reply/);
    expect(BOT_BUS_INSTRUCTION).toMatch(/end your turn there/);
    expect(BOT_BUS_INSTRUCTION).toMatch(/do not say that you asked them/);
    // The tool is for a bot elsewhere: in this room it would write a relay line
    // on top of the reply, two messages from the same bot.
    expect(BOT_BUS_INSTRUCTION).toMatch(/not in this room is asked in a private thread with `bot_send`/);
  });

  it('sends an absent bot to a thread, never to an invite a personal chat cannot make', () => {
    expect(BOT_BUS_INSTRUCTION).toMatch(/asked in a private thread/i);
    expect(BOT_BUS_INSTRUCTION).toMatch(/never ask anyone to add a bot to a personal chat/i);
    expect(BOT_BUS_INSTRUCTION).not.toMatch(/add it here/i);
  });

  it('asks for a new delivery every time, not the same text again', () => {
    expect(BOT_BUS_INSTRUCTION).toMatch(/never re-send text you have already sent/i);
  });

  it('names the speaker when relaying between humans, and reads short replies as answers', () => {
    // The speaker line is a shape, not a language: the bot writes it in the
    // reader's own words.
    expect(BOT_BUS_INSTRUCTION).toMatch(/name the speaker first \("<Name>: \.\.\."\)/);
    expect(BOT_BUS_INSTRUCTION).toMatch(/in the language that person reads/);
    expect(BOT_BUS_INSTRUCTION).not.toMatch(/Dari/);
    expect(BOT_BUS_INSTRUCTION).toMatch(/last question you carried/i);
  });

  it('exposes the file name OpenCode names the instruction by', () => {
    expect(BOT_BUS_INSTRUCTION_FILE).toBe('morse-bot-bus.md');
  });
});
