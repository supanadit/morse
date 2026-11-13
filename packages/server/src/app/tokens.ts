import type { AgentRouter, BotService, MorseLogger } from '@morse/system';
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

export type { AgentRouter, BotService, MorseLogger, PiRpcAdapter };



