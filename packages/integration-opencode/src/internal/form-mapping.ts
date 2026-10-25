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

/** The permission request recorded from a 2.1.4 server. */
export interface ApiPermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources?: string[];
  message?: string;
  metadata?: Record<string, unknown>;
}

/** One OpenCode form as the frontend's multi-field request. */
export function toFormRequest(form: ApiForm): AgentFormRequest {
  const message = form.metadata?.message;
  return {
    requestId: form.id,
    kind: 'form',
    title: form.title !== undefined && form.title.length > 0 ? form.title : 'OpenCode needs input',
    ...(typeof message === 'string' && message.length > 0 ? { message } : {}),
    fields: form.fields.map(toFormField),
  };
}

/** One OpenCode permission request as the once/always/reject choice. */
export function toPermissionRequest(request: ApiPermissionRequest): AgentSelectRequest {
  const detail = permissionDetail(request);
  return {
    requestId: request.id,
    kind: 'select',
    title: `Allow ${request.action}?`,
    ...(detail.length === 0 ? {} : { message: detail }),
    options: [
      { value: 'once', label: 'Allow once' },
      { value: 'always', label: 'Always allow' },
      { value: 'reject', label: 'Reject' },
    ],
  };
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
function permissionDetail(request: ApiPermissionRequest): string {
  const resources = request.resources?.filter((entry) => entry.length > 0) ?? [];
  if (resources.length > 0) {
    return resources.join('\n');
  }
  const command = request.metadata?.['command'];
  return typeof command === 'string' ? command : (request.message ?? '');
}
