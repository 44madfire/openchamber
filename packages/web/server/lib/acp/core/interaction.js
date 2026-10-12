/**
 * Phase 1.4 agent→client mappings: `session/request_permission` →
 * `PermissionRequest`, `elicitation/create` (form mode) → `FormRequest`.
 *
 * Host-agnostic (D1): pure functions over the wire params; the session
 * service parks the JSON-RPC resolver and fans the returned events out. The
 * domain shapes mirror the UI's `PermissionRequest` (`Permission.Request`)
 * and `FormRequest` (`Form.Info`) — the reducer stores them verbatim and the
 * cards render them.
 *
 * Permission derivation (§3.2/§3.3): the `action` is the resolved tool name
 * (§3.4 via the projector's `resolveToolName`), `resources` names what the
 * call wants to touch (file paths from `locations`, the shell command, …),
 * `metadata` carries the capped tool input plus `title`/`kind`/`toolCallId`
 * so the renderers show what the UI's HTTP path shows.
 * More than one `allow_*` option (pi-acp choice prompts) becomes a
 * single-select form instead of a permission.
 */

import { cappedToolInput, resolveToolName } from './projector.js';

/** Permission/form request ids are namespaced per session. */
export const permissionIdFor = (key, toolCallId, nonce) => `perm_acp-${nonce}-${toolCallId}`;
export const formIdFor = (key, nonce) => `form_acp-${nonce}`;

/** Resources cap: the agent's locations are untrusted and unbounded. */
export const MAX_PERMISSION_RESOURCES = 20;
/** Resource strings are capped like retained text. */
export const MAX_RESOURCE_CHARS = 4096;

const cappedResource = (value) => {
  if (typeof value !== 'string' || !value) return null;
  return value.length > MAX_RESOURCE_CHARS ? `${value.slice(0, MAX_RESOURCE_CHARS)}…[truncated]` : value;
};

const locationPathOf = (location) => {
  if (typeof location === 'string') return location;
  if (location && typeof location === 'object') {
    if (typeof location.path === 'string') return location.path;
    if (typeof location.uri === 'string') return location.uri;
  }
  return null;
};

/**
 * What the call wants to touch: file paths from `locations` first (they are
 * typed data), then the most informative raw-input field for the resolved
 * tool (shell `command`, read/write/edit `path`, …). Size-capped.
 */
export const resourcesForToolCall = (action, toolCall) => {
  const out = [];
  const push = (value) => {
    const capped = cappedResource(value);
    if (capped && !out.includes(capped) && out.length < MAX_PERMISSION_RESOURCES) out.push(capped);
  };
  const locations = Array.isArray(toolCall?.locations) ? toolCall.locations : [];
  for (const location of locations) push(locationPathOf(location));
  const input = toolCall?.rawInput;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (action === 'shell' || action === 'subagent' || action === 'acp') {
      push(typeof input.command === 'string' ? input.command : null);
    }
    for (const field of ['path', 'file_path', 'filePath', 'filepath', 'filename', 'file', 'url', 'pattern']) {
      push(typeof input[field] === 'string' ? input[field] : null);
    }
    if (typeof input.description === 'string' && action === 'subagent') push(input.description);
  } else if (typeof input === 'string') {
    push(input);
  }
  // A shell request carries its commands as resources; when nothing typed
  // arrived, the title is the only human-readable subject.
  if (out.length === 0 && typeof toolCall?.title === 'string' && toolCall.title) push(toolCall.title);
  return out;
};

const ALLOW_KIND = (kind) => kind === 'allow_once' || kind === 'allow_always';

/**
 * True when the permission is really a choice prompt: several distinct
 * allow options (pi-acp), not the standard once/always pair. The standard
 * allow_once + allow_always + reject triple stays a permission card.
 */
export const isChoicePrompt = (params) => {
  const options = Array.isArray(params?.options) ? params.options : [];
  const allows = options.filter((option) => ALLOW_KIND(option?.kind));
  if (allows.length <= 1) return false;
  if (allows.length > 2) return true;
  // Exactly two: a choice only when both are the same kind (two distinct
  // allow_once picks); once+always is the standard permission pair.
  return allows[0]?.kind === allows[1]?.kind;
};

const optionLabel = (option, index) =>
  (typeof option?.name === 'string' && option.name) || (typeof option?.optionId === 'string' && option.optionId) || `option ${index + 1}`;

/** A choice prompt as a single-select form (one field, one option per permission option). */
export const choiceFormFor = (formId, sessionID, params) => {
  const options = (Array.isArray(params?.options) ? params.options : []).map((option, index) => ({
    value: String(option?.optionId ?? `option-${index}`),
    label: optionLabel(option, index),
  }));
  return {
    id: formId,
    sessionID,
    title: (typeof params?.toolCall?.title === 'string' && params.toolCall.title) || 'Choose an option',
    fields: [{
      key: 'choice',
      type: 'string',
      title: (typeof params?.toolCall?.title === 'string' && params.toolCall.title) || undefined,
      required: true,
      options,
    }],
    metadata: {
      kind: 'permission-choice',
      toolCallId: params?.toolCall?.toolCallId,
      title: params?.toolCall?.title,
    },
  };
};

/**
 * Project `session/request_permission` params to a domain `PermissionRequest`.
 * `requestId` is caller-minted (`permissionIdFor`); `source` links the card
 * to the tool part when the tool call is already in the transcript.
 */
export const permissionRequestFor = (requestId, sessionID, params, source = null) => {
  const toolCall = params?.toolCall ?? {};
  const action = resolveToolName(toolCall);
  const request = {
    id: requestId,
    sessionID,
    action,
    resources: resourcesForToolCall(action, toolCall),
  };
  const metadata = {
    ...cappedToolInput(toolCall?.rawInput),
    ...(typeof toolCall?.title === 'string' && toolCall.title ? { title: toolCall.title } : {}),
    ...(typeof toolCall?.kind === 'string' && toolCall.kind ? { kind: toolCall.kind } : {}),
    ...(typeof toolCall?.toolCallId === 'string' && toolCall.toolCallId ? { toolCallId: toolCall.toolCallId } : {}),
  };
  if (Object.keys(metadata).length > 0) request.metadata = metadata;
  if (source) request.source = source;
  if (typeof toolCall?.title === 'string' && toolCall.title) request.message = toolCall.title;
  return request;
};

/**
 * Map a UI reply (`once`/`always`/`reject`) to the option id the agent
 * offered: `once`→`allow_once`, `always`→`allow_always` (else `allow_once`),
 * `reject`→`reject_once`. Returns null when no matching option exists (the
 * caller answers `cancelled`).
 */
export const optionIdForReply = (options, reply) => {
  const list = Array.isArray(options) ? options : [];
  const byKind = (kind) => list.find((option) => option?.kind === kind)?.optionId ?? null;
  if (reply === 'always') return byKind('allow_always') ?? byKind('allow_once');
  if (reply === 'reject') return byKind('reject_once');
  return byKind('allow_once');
};

// ---------------------------------------------------------------------------
// Elicitation (form mode): JSON-Schema → `FormRequest` fields.
// ---------------------------------------------------------------------------

const ELICITATION_TYPE_TO_FIELD = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  array: 'multiselect',
};

const enumOptionsOf = (schema) => {
  const list = Array.isArray(schema?.enum) ? schema.enum
    : Array.isArray(schema?.oneOf) ? schema.oneOf
    : Array.isArray(schema?.anyOf) ? schema.anyOf
    : null;
  if (!list) return null;
  const options = [];
  for (const item of list) {
    if (typeof item === 'string') {
      options.push({ value: item, label: item });
    } else if (item && typeof item === 'object') {
      const value = item.const ?? item.value;
      if (typeof value !== 'string') continue;
      options.push({
        value,
        label: typeof item.title === 'string' && item.title ? item.title : value,
        ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}),
      });
    }
    if (options.length >= 100) break;
  }
  return options.length > 0 ? options : null;
};

/**
 * Project one JSON-Schema property to a form field. Returns null for
 * untranslatable types (a form with no translatable field is declined).
 */
export const fieldForProperty = (key, schema, required) => {
  const type = ELICITATION_TYPE_TO_FIELD[schema?.type];
  if (!type || typeof key !== 'string' || !key) return null;
  // Multi-select is string items only; unknown item types have no control.
  if (type === 'multiselect') {
    const items = schema?.items;
    if (!items || typeof items !== 'object' || (items.type !== undefined && items.type !== 'string')) return null;
  }
  const field = { key, type };
  if (typeof schema.title === 'string' && schema.title) field.title = schema.title;
  if (typeof schema.description === 'string' && schema.description) field.description = schema.description;
  if (required === true) field.required = true;
  if (schema.default !== undefined && (typeof schema.default === 'string' || typeof schema.default === 'number'
    || typeof schema.default === 'boolean' || (type === 'multiselect' && Array.isArray(schema.default)))) {
    field.default = schema.default;
  }
  if (type === 'string') {
    const options = enumOptionsOf(schema);
    if (options) field.options = options;
    if (typeof schema.format === 'string') field.format = schema.format;
    if (typeof schema.minLength === 'number') field.minLength = schema.minLength;
    if (typeof schema.maxLength === 'number') field.maxLength = schema.maxLength;
    if (typeof schema.pattern === 'string') field.pattern = schema.pattern;
  }
  if (type === 'number') {
    if (typeof schema.minimum === 'number') field.minimum = schema.minimum;
    if (typeof schema.maximum === 'number') field.maximum = schema.maximum;
  }
  if (type === 'multiselect') {
    const options = enumOptionsOf(schema?.items);
    if (options) field.options = options;
    if (typeof schema.minItems === 'number') field.minItems = schema.minItems;
    if (typeof schema.maxItems === 'number') field.maxItems = schema.maxItems;
  }
  return field;
};

/**
 * Project an `elicitation/create` (form mode) request to a domain
 * `FormRequest`. Returns null when nothing is translatable (the caller
 * declines).
 */
export const elicitationFormFor = (formId, sessionID, params) => {
  const schema = params?.requestedSchema ?? {};
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const fields = [];
  for (const [key, property] of Object.entries(properties)) {
    const field = fieldForProperty(key, property, required.has(key));
    if (field) fields.push(field);
    if (fields.length >= 50) break;
  }
  if (fields.length === 0) return null;
  return {
    id: formId,
    sessionID,
    title: (typeof schema.title === 'string' && schema.title)
      || (typeof params?.message === 'string' && params.message)
      || 'Input needed',
    fields,
    metadata: {
      ...(typeof params?.message === 'string' && params.message ? { message: params.message } : {}),
      ...(typeof params?.toolCallId === 'string' && params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    },
  };
};

/**
 * Coerce a UI answer back to the elicitation schema: unknown keys dropped,
 * values coerced to the property type where unambiguous. Fractional numbers
 * for `integer` properties are NOT truncated (validation rejects them).
 * Returns the content object for `{action:'accept',content}`.
 */
export const contentForAnswer = (requestedSchema, answer) => {
  const properties = requestedSchema?.properties && typeof requestedSchema.properties === 'object'
    ? requestedSchema.properties
    : {};
  const source = answer && typeof answer === 'object' ? answer : {};
  const content = {};
  for (const [key, schema] of Object.entries(properties)) {
    const value = source[key];
    if (value === undefined) continue;
    if (schema?.type === 'boolean') {
      if (typeof value === 'boolean') content[key] = value;
      else if (value === 'true') content[key] = true;
      else if (value === 'false') content[key] = false;
    } else if (schema?.type === 'number' || schema?.type === 'integer') {
      if (typeof value === 'number' && Number.isFinite(value)) {
        content[key] = value;
      } else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        content[key] = Number(value);
      }
    } else if (schema?.type === 'array') {
      if (Array.isArray(value)) content[key] = value.filter((item) => typeof item === 'string').slice(0, 100);
      else if (typeof value === 'string') content[key] = [value];
    } else if (typeof value === 'string') {
      content[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      content[key] = String(value);
    }
  }
  return content;
};

const allowedValuesOf = (schema) => {
  const options = enumOptionsOf(schema);
  return options ? new Set(options.map((option) => option.value)) : null;
};

/**
 * Validate a coerced answer against the retained schema: required fields,
 * enum/oneOf/anyOf membership, integer-ness, numeric/string/array bounds.
 * Returns null when valid, else a human-readable reason. The caller rejects
 * with `ACP_INVALID_REQUEST` and RETAINS the parked form for correction.
 */
export const validateAnswerContent = (requestedSchema, content) => {
  const schema = requestedSchema && typeof requestedSchema === 'object' ? requestedSchema : {};
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const values = content && typeof content === 'object' ? content : {};
  for (const [key, property] of Object.entries(properties)) {
    const value = values[key];
    if (value === undefined || (property?.type === 'string' && value === '' && required.has(key))) {
      if (required.has(key)) return `missing required field: ${key}`;
      continue;
    }
    if (property?.type === 'string') {
      if (typeof value !== 'string') return `invalid value for field: ${key}`;
      const allowed = allowedValuesOf(property);
      if (allowed && !allowed.has(value)) return `invalid choice for field: ${key}`;
      if (typeof property.minLength === 'number' && value.length < property.minLength) {
        return `value too short for field: ${key}`;
      }
      if (typeof property.maxLength === 'number' && value.length > property.maxLength) {
        return `value too long for field: ${key}`;
      }
      // `pattern` is deliberately NOT evaluated: agent-supplied regexes are
      // untrusted input and may be pathological (ReDoS). Pattern conformance
      // stays the agent's job; the server enforces only the bounded checks.
    } else if (property?.type === 'number' || property?.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `invalid value for field: ${key}`;
      if (property.type === 'integer' && !Number.isInteger(value)) return `invalid integer for field: ${key}`;
      if (typeof property.minimum === 'number' && value < property.minimum) {
        return `value too small for field: ${key}`;
      }
      if (typeof property.maximum === 'number' && value > property.maximum) {
        return `value too large for field: ${key}`;
      }
    } else if (property?.type === 'boolean') {
      if (typeof value !== 'boolean') return `invalid value for field: ${key}`;
    } else if (property?.type === 'array') {
      if (!Array.isArray(value)) return `invalid value for field: ${key}`;
      const allowed = allowedValuesOf(property?.items);
      if (allowed && value.some((item) => !allowed.has(item))) return `invalid choice for field: ${key}`;
      if (typeof property.minItems === 'number' && value.length < property.minItems) {
        return `not enough items for field: ${key}`;
      }
      if (typeof property.maxItems === 'number' && value.length > property.maxItems) {
        return `too many items for field: ${key}`;
      }
    }
  }
  return null;
};
