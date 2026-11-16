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

/** The model an `Agent.Info` is configured to run. */
export interface ApiAgentModel {
  id: string;
  providerID: string;
  variant?: string;
}

/** The parts of an `Agent.Info` this adapter reads. */
export interface ApiAgent {
  id?: string;
  name?: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
  /** `null` on the wire means the agent names no model, same as absent. */
  model?: ApiAgentModel | null;
}

/** One configuration entry from `GET /api/config` (lowest to highest priority). */
export interface ApiConfigEntry {
  type?: string;
  path?: string;
  info?: { default_agent?: unknown };
}

/**
 * The primary agents OpenCode reports, in the server's order, with its resolved
 * default marked, and the model each of those agents is configured to run.
 *
 * The default follows OpenCode's own rule: the last configuration document that
 * sets `default_agent` wins; without one, the first primary agent is the default
 * (the server places the resolved default first). Morse never supplies an id of
 * its own, so a user who configures `plan` gets plan, and a future default the
 * server introduces does too.
 *
 * The model map only carries the primary, non-hidden agents — the user's choices
 * — and only those the server reported a usable model for. An agent with no
 * configured model is simply absent, so a caller can fall back to the server's
 * own default.
 */
export interface AgentCatalog {
  modes: AgentMode[];
  defaultMode?: string;
  models: Map<string, ApiAgentModel>;
}

/** Reads the mode catalog and each primary agent's configured model in one pass. */
export async function readAgentCatalog(
  api: OpenCodeApi,
  directory: string,
  logger: MorseLogger,
): Promise<AgentCatalog> {
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

  const primary = (Array.isArray(agents) ? agents : []).filter(
    (agent): agent is ApiAgent & { id: string } =>
      typeof agent.id === 'string' &&
      agent.id.length > 0 &&
      agent.mode === 'primary' &&
      agent.hidden !== true,
  );
  if (primary.length === 0) {
    return { modes: [], models: new Map() };
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

  const models = new Map<string, ApiAgentModel>();
  for (const agent of primary) {
    const model = agentModel(agent);
    if (model !== undefined) {
      models.set(agent.id, model);
    }
  }

  return {
    modes: primary.map((agent) => ({
      id: agent.id,
      name: typeof agent.name === 'string' && agent.name.length > 0 ? agent.name : agent.id,
      ...(typeof agent.description === 'string' && agent.description.length > 0
        ? { description: agent.description }
        : {}),
      ...(agent.id === defaultId ? { default: true } : {}),
    })),
    ...(defaultId === undefined ? {} : { defaultMode: defaultId }),
    models,
  };
}

/** Just the modes, for callers that only fill the picker. */
export async function readAgentModes(
  api: OpenCodeApi,
  directory: string,
  logger: MorseLogger,
): Promise<AgentMode[]> {
  const { modes } = await readAgentCatalog(api, directory, logger);
  return modes;
}

/** The agent's configured model, normalised, when the server reported one. */
function agentModel(agent: ApiAgent): ApiAgentModel | undefined {
  const model = agent.model;
  if (
    model === undefined ||
    model === null ||
    typeof model.id !== 'string' ||
    model.id.length === 0 ||
    typeof model.providerID !== 'string' ||
    model.providerID.length === 0
  ) {
    return undefined;
  }
  return {
    id: model.id,
    providerID: model.providerID,
    ...(typeof model.variant === 'string' && model.variant.length > 0
      ? { variant: model.variant }
      : {}),
  };
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
