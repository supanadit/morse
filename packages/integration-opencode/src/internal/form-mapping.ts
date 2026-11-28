import type {
  AgentFormCondition,
  AgentFormField,
  AgentFormFieldType,
  AgentFormRequest,
  AgentFormValue,
  AgentSelectRequest,
} from '@morse/agent';

/**
 * OpenCode's two interaction surfaces → Morse's interaction requests.
 *
 * A **form** (`Form.Info`) is a named set of typed fields, exactly what
 * `AgentFormRequest` is for: the installed server's `string`/`number`/`integer`/
 * `boolean`/`multiselect` fields map onto Morse's field types, `when` becomes a
 * visibility condition, and `minimum`/`maximum`/`default` become constraints and
 * seeds. Its `external` field opens a browser page and answers a finished flag;
 * Morse renders it as a checkbox, because the frontend has no browser to open
 * outside the host.
 *
 * A **permission** (`Permission.Request`) is one question with three answers —
 * allow once, always allow, reject — which is precisely a select. It is not a
 * confirm, because a confirm cannot express "always".
 */

/** The form field shapes recorded from a 2.1.4 server. */
export interface ApiFormField {
  key: string;
  title?: string;
  description?: string;
  type?: string;
  options?: { value: string; label: string; description?: string }[];
  placeholder?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  required?: boolean;
  when?: { key: string; value: unknown; op: 'eq' | 'ne' }[];
  /** An `external` field's browser URL, and whether the list allows custom answers. */
  url?: string;
  custom?: boolean;
  multiple?: boolean;
}

export interface ApiForm {
  id: string;
  sessionID?: string;
  title?: string;
  metadata?: { message?: unknown };
  fields: ApiFormField[];
}

/** The permission request shape both wires send. 2.x names the action
 * `action` with `resources`; 1.x names it `permission` with `patterns`. */
export interface ApiPermissionRequest {
  id: string;
  sessionID: string;
  action?: string;
  permission?: string;
  resources?: string[];
  patterns?: string[];
  message?: string;
  metadata?: Record<string, unknown>;
}

/** One 1.x question option: the label is the answer the server matches on. */
export interface ApiQuestionOption {
  label: string;
  description?: string;
}

/** One 1.x question: a prompt with fixed options, optionally multi and custom. */
export interface ApiQuestionInfo {
  question: string;
  header?: string;
  options?: ApiQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** A 1.x `question.asked` payload: several questions answered together. */
export interface ApiQuestion {
  id: string;
  sessionID?: string;
  questions: ApiQuestionInfo[];
}

/** One OpenCode form as the frontend's multi-field request. Never throws: a
 * form shell with no `fields` array (or no usable fields) becomes an empty
 * form rather than killing the host — callers skip empty shells. */
export function toFormRequest(form: ApiForm): AgentFormRequest {
  const message = (form as ApiForm | undefined)?.metadata?.message;
  const raw = Array.isArray((form as ApiForm | undefined)?.fields)
    ? ((form as ApiForm).fields as unknown[])
    : [];
  return {
    requestId: typeof (form as ApiForm | undefined)?.id === 'string' ? (form as ApiForm).id : '',
    kind: 'form',
    title:
      typeof (form as ApiForm | undefined)?.title === 'string' &&
      (form as ApiForm).title!.length > 0
        ? (form as ApiForm).title!
        : 'OpenCode needs input',
    ...(typeof message === 'string' && message.length > 0 ? { message } : {}),
    fields: raw
      .filter(
        (field): field is ApiFormField =>
          typeof field === 'object' &&
          field !== null &&
          typeof (field as { key?: unknown }).key === 'string',
      )
      .map(toFormField),
  };
}

/** One OpenCode permission request as the once/always/reject choice. Reads
 * both wire shapes: 2.x `action`/`resources`, 1.x `permission`/`patterns`. */
export function toPermissionRequest(request: ApiPermissionRequest): AgentSelectRequest {
  const action = request.action ?? request.permission ?? 'permission';
  const resources = request.resources ?? request.patterns;
  const detail = permissionDetail({ resources, request });
  return {
    requestId: request.id,
    kind: 'select',
    title: `Allow ${action}?`,
    ...(detail.length === 0 ? {} : { message: detail }),
    options: [
      { value: 'once', label: 'Allow once' },
      { value: 'always', label: 'Always allow' },
      { value: 'reject', label: 'Reject' },
    ],
  };
}

/**
 * One 1.x question request as a form with one field per question, so the
 * reply can carry every answer in the server's order. A single question is
 * still a form (not a select): the reply path stays one shape, and a custom
 * answer rides along as an optional text field merged after the picked labels.
 * Returns `undefined` when there is nothing answerable (no usable options).
 */
export function toQuestionRequest(question: ApiQuestion): AgentFormRequest | undefined {
  const infos = Array.isArray(question.questions)
    ? question.questions.filter(
        (info): info is ApiQuestionInfo =>
          typeof info === 'object' &&
          info !== null &&
          typeof info.question === 'string' &&
          Array.isArray(info.options) &&
          info.options.length > 0,
      )
    : [];
  if (infos.length === 0) {
    return undefined;
  }
  const titleOf = (info: ApiQuestionInfo): string =>
    typeof info.header === 'string' && info.header.length > 0 ? info.header : info.question;
  return {
    requestId: question.id,
    kind: 'form',
    title: infos.length === 1 ? titleOf(infos[0]!) : 'OpenCode has questions',
    fields: infos.flatMap((info, index) => {
      const key = `q${index}`;
      const options = info.options!.map((option) => ({
        value: option.label,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      }));
      const field: AgentFormField = {
        key,
        label: titleOf(info),
        type: info.multiple === true ? 'multiselect' : 'select',
        options,
        required: true,
      };
      // A custom answer rides along as an optional text field; the reply
      // merges it after the picked labels, in the server's answer order.
      if (info.custom === true) {
        return [field, { key: `${key}~custom`, label: `${titleOf(info)} (custom)`, type: 'text' as const }];
      }
      return [field];
    }),
  };
}

/**
 * A 1.x question reply in the server's answer order: one label array per
 * question, picked labels first, then a typed custom answer when present.
 */
export function questionAnswers(
  question: ApiQuestion,
  values: Record<string, AgentFormValue> | undefined,
): string[][] {
  return question.questions.map((_info, index) => {
    const value = values?.[`q${index}`];
    const picked = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : typeof value === 'string' ? [value] : [];
    const custom = values?.[`q${index}~custom`];
    if (typeof custom === 'string' && custom.length > 0) {
      return [...picked, custom];
    }
    return picked;
  });
}

function toFormField(field: ApiFormField): AgentFormField {
  const type = fieldType(field);
  const label = field.title ?? field.key;
  const options =
    field.options === undefined
      ? undefined
      : field.options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        }));
  return {
    key: field.key,
    label: type === 'boolean' && field.url !== undefined ? `${label} (opens ${field.url})` : label,
    type,
    // Every visible OpenCode field must be answered (`form.reply` carries the
    // whole form), except a checkbox: "unchecked" is a real answer, and Morse's
    // `required` means "must be true".
    ...(type === 'boolean' ? {} : { required: true }),
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
    ...(field.minimum === undefined ? {} : { min: field.minimum }),
    ...(field.maximum === undefined ? {} : { max: field.maximum }),
    ...(options === undefined ? {} : { options }),
    ...(defaultValueOf(field.default) === undefined ? {} : { defaultValue: defaultValueOf(field.default) }),
    ...(conditionOf(field) === undefined ? {} : { when: conditionOf(field) }),
  };
}

/** OpenCode's type names → the renderer's, with one honest degradation. */
function fieldType(field: ApiFormField): AgentFormFieldType {
  switch (field.type) {
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'multiselect':
      return 'multiselect';
    case 'external':
      // A browser handshake the frontend cannot perform; the TUI answers it with
      // a "finished" flag too, so it becomes that checkbox.
      return 'boolean';
    case 'string':
    default:
      return field.options !== undefined && field.options.length > 0 ? 'select' : 'text';
  }
}

/**
 * A field's visibility, when it can be stated in one condition.
 *
 * OpenCode ANDs a `when` list; Morse's condition compares one field. A list of
 * two or more is therefore not representable — and hiding a field that would be
 * required is worse than showing it, so the whole condition is dropped and the
 * field stays visible.
 */
function conditionOf(field: ApiFormField): AgentFormCondition | undefined {
  const conditions = field.when ?? [];
  if (conditions.length !== 1) {
    return undefined;
  }
  const condition = conditions[0]!;
  const value = defaultValueOf(condition.value);
  if (value === undefined) {
    return undefined;
  }
  return condition.op === 'ne'
    ? { field: condition.key, notEquals: value }
    : { field: condition.key, equals: value };
}

/** A form value, limited to what the wire can carry. */
function defaultValueOf(value: unknown): AgentFormValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')) {
    return value;
  }
  return undefined;
}

/** What the permission is about, as the message under the title. */
function permissionDetail({ resources, request }: { resources?: unknown; request: ApiPermissionRequest }): string {
  const patterns = Array.isArray(resources)
    ? resources.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  if (patterns.length > 0) {
    return patterns.join('\n');
  }
  const command = request.metadata?.['command'];
  return typeof command === 'string' ? command : (request.message ?? '');
}
