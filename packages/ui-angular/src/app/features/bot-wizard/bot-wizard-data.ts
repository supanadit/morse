/**
 * The New bot wizard's fixed vocabulary: provider chips, API types, per-engine
 * defaults and the small name/environment parsers its form uses.
 */
import type { BotProviderApi, ThinkingLevel } from '@morse/protocol';
import type { BotProviderModel } from '@morse/system';

/** A catalog provider the engine discovers itself: a preset chip and a key. */
export interface KnownProviderPreset {
  /**
   * The credential's engine-side provider name — the key it lands under in the
   * bot's `auth.json`. Engine-specific, so the same brand may carry one name in
   * pi's catalog and another in OpenCode's; a row belongs to the engine whose
   * spelling it uses.
   */
  credential: string;
  label: string;
  /** Engines whose catalogs carry it; others hide the chip. */
  engines: readonly string[];
}

/**
 * Catalog providers per engine, as preset chips. The key goes into the bot's
 * own `auth.json` (OpenCode) / `auth.json` (pi) and the engine's probe lists
 * the models the key unlocks — no provider JSON needed for these.
 *
 * The pi rows mirror pi's own provider catalog (`getApiKeyEnvVars` in the
 * installed bundle, `docs/providers.md`): every provider a single API key is
 * enough for, spelled the way pi spells it in `auth.json`. A chip that only
 * appears for one engine says so in `engines` — the wizard never shows a key
 * field that engine cannot use.
 */
export const KNOWN_PROVIDERS: KnownProviderPreset[] = [
  { credential: 'opencode', label: 'OpenCode Zen (API key)', engines: ['opencode'] },
  { credential: 'anthropic', label: 'Anthropic', engines: ['opencode', 'pi'] },
  { credential: 'openai', label: 'OpenAI', engines: ['opencode', 'pi'] },
  { credential: 'google', label: 'Google', engines: ['opencode', 'pi'] },
  { credential: 'openrouter', label: 'OpenRouter', engines: ['opencode', 'pi'] },
  { credential: 'xai', label: 'xAI', engines: ['opencode', 'pi'] },
  // pi's remaining catalog providers. OpenCode's own list stays as it is: its
  // `auth.json` keys are models.dev ids (`moonshotai`, `togetherai`, …), which
  // differ from pi's for several of the same brands.
  { credential: 'opencode', label: 'OpenCode Zen', engines: ['pi'] },
  { credential: 'opencode-go', label: 'OpenCode Go', engines: ['pi'] },
  { credential: 'deepseek', label: 'DeepSeek', engines: ['pi'] },
  { credential: 'groq', label: 'Groq', engines: ['pi'] },
  { credential: 'mistral', label: 'Mistral', engines: ['pi'] },
  { credential: 'zai', label: 'Z.ai Coding Plan', engines: ['pi'] },
  { credential: 'zai-coding-cn', label: 'Z.ai Coding Plan (China)', engines: ['pi'] },
  { credential: 'minimax', label: 'MiniMax', engines: ['pi'] },
  { credential: 'minimax-cn', label: 'MiniMax (China)', engines: ['pi'] },
  { credential: 'moonshotai', label: 'Moonshot AI', engines: ['pi'] },
  { credential: 'moonshotai-cn', label: 'Moonshot AI (China)', engines: ['pi'] },
  { credential: 'kimi-coding', label: 'Kimi For Coding', engines: ['pi'] },
  { credential: 'qwen-token-plan', label: 'Qwen Token Plan', engines: ['pi'] },
  { credential: 'qwen-token-plan-cn', label: 'Qwen Token Plan (China)', engines: ['pi'] },
  { credential: 'qwen-token-plan-individual', label: 'Qwen Individual', engines: ['pi'] },
  { credential: 'qwen-token-plan-individual-cn', label: 'Qwen Individual (China)', engines: ['pi'] },
  { credential: 'xiaomi', label: 'Xiaomi MiMo', engines: ['pi'] },
  { credential: 'xiaomi-token-plan-cn', label: 'Xiaomi Token Plan (China)', engines: ['pi'] },
  { credential: 'xiaomi-token-plan-ams', label: 'Xiaomi Token Plan (Amsterdam)', engines: ['pi'] },
  { credential: 'xiaomi-token-plan-sgp', label: 'Xiaomi Token Plan (Singapore)', engines: ['pi'] },
  { credential: 'nvidia', label: 'NVIDIA NIM', engines: ['pi'] },
  { credential: 'cerebras', label: 'Cerebras', engines: ['pi'] },
  { credential: 'fireworks', label: 'Fireworks', engines: ['pi'] },
  { credential: 'together', label: 'Together AI', engines: ['pi'] },
  { credential: 'baseten', label: 'Baseten', engines: ['pi'] },
  { credential: 'vercel-ai-gateway', label: 'Vercel AI Gateway', engines: ['pi'] },
  { credential: 'ant-ling', label: 'Ant Ling', engines: ['pi'] },
  { credential: 'huggingface', label: 'Hugging Face', engines: ['pi'] },
  { credential: 'meta', label: 'Meta', engines: ['pi'] },
  { credential: 'radius', label: 'Radius', engines: ['pi'] },
  // Deliberately absent: providers a single pasted key cannot finish. Cloudflare
  // (Workers AI, AI Gateway) needs `CLOUDFLARE_ACCOUNT_ID` beside its key, Azure
  // needs a resource and deployment map, Google Vertex and Amazon Bedrock take
  // ambient cloud credentials, GitHub Copilot and Radius sign in with OAuth, and
  // `typesafe` serves classifier models only — a bot needs a chat model. Those
  // reach a bot through "Add provider" or the engine's own `/login` instead, and
  // a chip whose key could not work would be worse than no chip.
];

/** The API types a custom provider can speak, with the picker's wording. */
export const PROVIDER_APIS: { value: BotProviderApi; label: string; hint: string }[] = [
  { value: 'openai-completions', label: 'OpenAI-compatible (chat completions)', hint: 'Most proxies, gateways, Ollama, vLLM, LM Studio' },
  { value: 'openai-responses', label: 'OpenAI Responses', hint: 'Endpoints speaking /responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages', hint: 'Anthropic-compatible gateways' },
  { value: 'google-generative-ai', label: 'Google Generative AI', hint: 'Gemini-style endpoints' },
];

/** pi's thinking levels, ordered from least to most. */
export const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** A wizard-local request id for probes; the host echoes it whole. */
let wizardRequests = 0;
export function nextRequestId(): string {
  wizardRequests += 1;
  return `wizard-${Date.now()}-${wizardRequests}`;
}

/** `A, B  C` → `['A', 'B', 'C']`: names, however the reader separated them. */
/**
 * The built-in tools each engine can give a bot, in that engine's own names.
 *
 * `pi` is a coding harness: read, bash, edit and write, and no web tool at all —
 * reaching the internet means an MCP server or an extension, not a built-in.
 * OpenCode ships a wider set, web tools included. The wizard offers exactly what
 * the chosen engine can do, rather than one abstraction over both.
 */
export const ENGINE_TOOLS: Record<string, { name: string; hint?: string }[]> = {
  pi: [
    { name: 'read', hint: 'read files' },
    { name: 'bash', hint: 'run shell commands' },
    { name: 'edit', hint: 'change files' },
    { name: 'write', hint: 'create files' },
  ],
  opencode: [
    { name: 'read' },
    { name: 'edit' },
    { name: 'glob' },
    { name: 'grep' },
    { name: 'shell', hint: 'run shell commands' },
    { name: 'subagent', hint: 'launch subagents' },
    { name: 'webfetch', hint: 'fetch a URL' },
    { name: 'websearch', hint: 'search the web' },
    { name: 'todowrite' },
  ],
};

/** What a new bot starts with, per engine: the engine's own defaults, not "none". */
export const DEFAULT_TOOLS: Record<string, string[]> = {
  pi: ['read', 'bash', 'edit', 'write'],
  opencode: ['read', 'edit', 'glob', 'grep', 'shell'],
};

/** The username rules, mirrored from the host so the form can say what is wrong. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * A name turned into a candidate username: lowercase, ASCII-ish, spaces and
 * punctuation folded to dashes. Only a starting point — the reader may edit it,
 * and the host validates whatever is sent.
 */
export function usernameFrom(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

export function parseEnvVars(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
