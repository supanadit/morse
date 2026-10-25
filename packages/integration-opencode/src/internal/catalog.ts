import type { AgentMode } from '@morse/agent';
import type { MorseLogger } from '@morse/system';
import type { OpenCodeApi } from './client.js';
import type { ApiModel } from './model-mapping.js';

/**
 * The catalogs OpenCode keeps in its own configuration: the primary agents that
 * become Morse's modes, and the model a new session would use.
 *
 * Both reads are best effort. A server that cannot answer leaves the picker
 * without that catalog rather than failing the draft; the conversation still
 * opens. The agent list is filtered to primary, non-hidden agents, exactly the
 * set OpenCode's own picker offers — subagents and internal agents (compaction,
 * title, summary) are not user choices.
 */

/** The parts of an `Agent.Info` this adapter reads. */
export interface ApiAgent {
  id?: string;
  name?: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
}

/** One configuration entry from `GET /api/config` (lowest to highest priority). */
export interface ApiConfigEntry {
  type?: string;
  path?: string;
  info?: { default_agent?: unknown };
}

/**
 * The primary agents OpenCode reports, in the server's order, with its resolved
 * default marked.
 *
 * The default follows OpenCode's own rule: the last configuration document that
 * sets `default_agent` wins; without one, the first primary agent is the default
 * (the server places the resolved default first). Morse never supplies an id of
 * its own, so a user who configures `plan` gets plan, and a future default the
 * server introduces does too.
 */
export async function readAgentModes(
  api: OpenCodeApi,
  directory: string,
  logger: MorseLogger,
): Promise<AgentMode[]> {
  const [agents, documents] = await Promise.all([
    api
      .get<ApiAgent[]>('/agent', { 'location[directory]': directory })
      .catch((error: unknown): ApiAgent[] => {
        logger.warn('Could not read the OpenCode agent catalog', { error });
        return [];
      }),
    api
      .get<ApiConfigEntry[]>('/config', { 'location[directory]': directory })
      .catch((error: unknown): ApiConfigEntry[] => {
        logger.warn('Could not read the OpenCode configuration for its default agent', { error });
        return [];
      }),
  ]);

  const primary = (Array.isArray(agents) ? agents : [])
    .filter(
      (agent): agent is ApiAgent & { id: string } =>
        typeof agent.id === 'string' &&
        agent.id.length > 0 &&
        agent.mode === 'primary' &&
        agent.hidden !== true,
    )
    .map((agent) => ({
      id: agent.id,
      name: typeof agent.name === 'string' && agent.name.length > 0 ? agent.name : agent.id,
      ...(typeof agent.description === 'string' && agent.description.length > 0
        ? { description: agent.description }
        : {}),
    }));
  if (primary.length === 0) {
    return [];
  }

  const configured = (Array.isArray(documents) ? documents : [])
    .filter(
      (entry) =>
        entry.type === 'document' &&
        typeof entry.info?.default_agent === 'string' &&
        entry.info.default_agent.trim().length > 0,
    )
    .at(-1)?.info?.default_agent as string | undefined;
  const defaultId =
    configured !== undefined && primary.some((agent) => agent.id === configured)
      ? configured
      : primary[0]?.id;

  return primary.map((agent) => ({
    ...agent,
    ...(agent.id === defaultId ? { default: true } : {}),
  }));
}

/** The default mode's id, when the harness names one. */
export function defaultModeId(modes: readonly AgentMode[]): string | undefined {
  return modes.find((mode) => mode.default === true)?.id ?? modes[0]?.id;
}

/**
 * The model OpenCode would use for a new session in this workspace. Best effort:
 * a server that cannot answer leaves the draft's model unset, and the session
 * still opens on whatever the server chooses at prompt time.
 */
export async function readDefaultModel(
  api: OpenCodeApi,
  directory: string,
  logger: MorseLogger,
): Promise<ApiModel | undefined> {
  try {
    const model = await api.get<ApiModel | null>('/model/default', {
      'location[directory]': directory,
    });
    return model ?? undefined;
  } catch (error: unknown) {
    logger.warn('Could not read the OpenCode default model', { error });
    return undefined;
  }
}
