import type { AgentRouter, BotBusPort, BotService, MorseLogger } from '@morse/system';
import type { PiRpcAdapter } from '@morse/integration-pi';

export const MORSE_CONFIG = 'MORSE_CONFIG';
export const MORSE_LOGGER = 'MORSE_LOGGER';
export const MORSE_PI_ADAPTER = 'MORSE_PI_ADAPTER';
export const MORSE_AGENT_ROUTER = 'MORSE_AGENT_ROUTER';
export const MORSE_SESSION_REGISTRY = 'MORSE_SESSION_REGISTRY';
export const MORSE_TRANSCRIPT_STORE = 'MORSE_TRANSCRIPT_STORE';
export const MORSE_PROJECT_POLICY = 'MORSE_PROJECT_POLICY';
/** The host's one bot roster, shared by every connection (bot mode). */
export const MORSE_BOT_SERVICE = 'MORSE_BOT_SERVICE';
/**
 * The narrow slice of the bot service the internal bus endpoint may use: the
 * token it names a caller by, and the two tools. Absent with the service itself
 * when the registry cannot be read.
 */
export const MORSE_BOT_BUS = 'MORSE_BOT_BUS';

export type { AgentRouter, BotBusPort, BotService, MorseLogger, PiRpcAdapter };



