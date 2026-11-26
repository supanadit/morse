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

  it('sends an absent bot to a thread, never to an invite a personal chat cannot make', () => {
    expect(BOT_BUS_INSTRUCTION).toMatch(/asked in a private thread/i);
    expect(BOT_BUS_INSTRUCTION).toMatch(/never ask anyone to add a bot to a personal chat/i);
    expect(BOT_BUS_INSTRUCTION).not.toMatch(/add it here/i);
  });

  it('asks for a new delivery every time, not the same text again', () => {
    expect(BOT_BUS_INSTRUCTION).toMatch(/never re-send text you have already sent/i);
  });

  it('names the speaker when relaying between humans, and reads short replies as answers', () => {
    expect(BOT_BUS_INSTRUCTION).toMatch(/Dari <name>/);
    expect(BOT_BUS_INSTRUCTION).toMatch(/last question you carried/i);
  });

  it('exposes the file name OpenCode names the instruction by', () => {
    expect(BOT_BUS_INSTRUCTION_FILE).toBe('morse-bot-bus.md');
  });
});
