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

  it('exposes the file name OpenCode names the instruction by', () => {
    expect(BOT_BUS_INSTRUCTION_FILE).toBe('morse-bot-bus.md');
  });
});
