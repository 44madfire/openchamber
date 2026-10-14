export declare const MAX_PERMISSION_RESOURCES: number;
export declare const MAX_RESOURCE_CHARS: number;

export declare function permissionIdFor(key: string, toolCallId: string, nonce: number): string;
export declare function formIdFor(key: string, nonce: number): string;
export declare function resourcesForToolCall(action: string, toolCall: {
  locations?: unknown;
  rawInput?: unknown;
  title?: string | null;
} | null | undefined): string[];
export declare function isChoicePrompt(params: { options?: Array<{ kind?: string }> } | null | undefined): boolean;
export declare function choiceFormFor(formId: string, sessionID: string, params: {
  options?: Array<{ optionId?: string; name?: string }>;
  toolCall?: { title?: string | null; toolCallId?: string };
} | null | undefined): {
  id: string;
  sessionID: string;
  title: string;
  fields: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
};
export declare function permissionRequestFor(requestId: string, sessionID: string, params: {
  toolCall?: {
    toolCallId?: string;
    kind?: string | null;
    title?: string | null;
    name?: string | null;
    locations?: unknown;
    rawInput?: unknown;
    content?: unknown;
  };
  options?: unknown;
} | null | undefined, source?: { type: 'tool'; messageID: string; id: string } | null): {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: 'tool'; messageID: string; id: string };
  message?: string;
};
export declare function optionIdForReply(options: Array<{ kind?: string; optionId?: string }> | null | undefined, reply: 'once' | 'always' | 'reject'): string | null;

export declare function contentForAnswer(requestedSchema: {
  properties?: Record<string, { type?: string }>;
} | null | undefined, answer: Record<string, unknown> | null | undefined): Record<string, string | number | boolean | string[]>;
export declare function validateAnswerContent(requestedSchema: {
  properties?: Record<string, unknown>;
  required?: string[];
} | null | undefined, content: Record<string, unknown> | null | undefined): string | null;
export declare function fieldForProperty(key: string, schema: {
  type?: string;
  title?: string | null;
  description?: string | null;
  default?: unknown;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: unknown;
  oneOf?: unknown;
  anyOf?: unknown;
  items?: unknown;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
} | null | undefined, required: boolean): Record<string, unknown> | null;
export declare function elicitationFormFor(formId: string, sessionID: string, params: {
  message?: string;
  toolCallId?: string;
  requestedSchema?: {
    title?: string | null;
    properties?: Record<string, unknown>;
    required?: string[];
  };
} | null | undefined): {
  id: string;
  sessionID: string;
  title: string;
  fields: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
} | null;
