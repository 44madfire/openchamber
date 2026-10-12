import { describe, expect, it } from 'vitest';

import {
  choiceFormFor,
  contentForAnswer,
  elicitationFormFor,
  fieldForProperty,
  isChoicePrompt,
  optionIdForReply,
  permissionRequestFor,
  resourcesForToolCall,
  validateAnswerContent,
} from '../interaction.js';

const PERMISSION_PARAMS = {
  toolCall: {
    toolCallId: 'toolu_1',
    name: 'shell',
    title: 'echo hi',
    kind: 'execute',
    status: 'pending',
    locations: [{ path: 'C:/work' }],
    rawInput: { command: 'echo hi', cwd: 'C:/work' },
  },
  options: [
    { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
  ],
};

describe('acp permission projection', () => {
  it('derives action/resources/metadata from the tool call', () => {
    const request = permissionRequestFor('perm_1', 'ses_key', PERMISSION_PARAMS);
    expect(request).toMatchObject({
      id: 'perm_1',
      sessionID: 'ses_key',
      action: 'shell',
    });
    expect(request.resources).toContain('C:/work');
    expect(request.resources).toContain('echo hi');
    expect(request.metadata).toMatchObject({ command: 'echo hi', title: 'echo hi', toolCallId: 'toolu_1' });
    expect(request.message).toBe('echo hi');
  });

  it('links the card to the tool part home when given', () => {
    const request = permissionRequestFor('perm_1', 'ses_key', PERMISSION_PARAMS, {
      type: 'tool',
      messageID: 'msg_1',
      id: 'toolu_1',
    });
    expect(request.source).toEqual({ type: 'tool', messageID: 'msg_1', id: 'toolu_1' });
  });

  it('falls back to the title when nothing typed names a resource', () => {
    const resources = resourcesForToolCall('acp', { title: 'do the thing', locations: [], rawInput: {} });
    expect(resources).toEqual(['do the thing']);
  });

  it('caps resources and truncates long ones', () => {
    const locations = Array.from({ length: 50 }, (_, index) => ({ path: `/file-${index}` }));
    const resources = resourcesForToolCall('read', { locations, rawInput: {} });
    expect(resources).toHaveLength(20);
    const long = resourcesForToolCall('shell', { locations: [], rawInput: { command: `echo ${'x'.repeat(5000)}` } });
    expect(long[0].length).toBeLessThan(5000);
    expect(long[0]).toMatch(/truncated\]$/);
  });

  it('maps replies to option ids', () => {
    const options = PERMISSION_PARAMS.options;
    expect(optionIdForReply(options, 'once')).toBe('once');
    expect(optionIdForReply(options, 'always')).toBe('always');
    expect(optionIdForReply(options, 'reject')).toBe('reject');
    // `always` degrades to `allow_once`; unknown shapes yield null (cancelled).
    expect(optionIdForReply([{ optionId: 'o', kind: 'allow_once' }], 'always')).toBe('o');
    expect(optionIdForReply([], 'once')).toBeNull();
    expect(optionIdForReply(null, 'reject')).toBeNull();
    // §3.2: `reject` maps ONLY to `reject_once` — never to `reject_always`
    // (a one-time rejection must not become a persistent one).
    expect(optionIdForReply([{ optionId: 'r', kind: 'reject_always' }], 'reject')).toBeNull();
  });
  it('detects choice prompts by multiple allow_* options', () => {
    expect(isChoicePrompt(PERMISSION_PARAMS)).toBe(false);
    expect(isChoicePrompt({
      options: [
        { optionId: 'a', kind: 'allow_once', name: 'Red' },
        { optionId: 'b', kind: 'allow_once', name: 'Blue' },
      ],
    })).toBe(true);
  });

  it('projects a choice prompt as a single-select form', () => {
    const form = choiceFormFor('form_1', 'ses_key', {
      toolCall: { title: 'Pick a color', toolCallId: 'toolu_9' },
      options: [
        { optionId: 'red', kind: 'allow_once', name: 'Red' },
        { optionId: 'blue', kind: 'allow_once', name: 'Blue' },
      ],
    });
    expect(form).toMatchObject({ id: 'form_1', sessionID: 'ses_key', title: 'Pick a color' });
    expect(form.fields).toHaveLength(1);
    expect(form.fields[0]).toMatchObject({
      key: 'choice',
      type: 'string',
      required: true,
      options: [
        { value: 'red', label: 'Red' },
        { value: 'blue', label: 'Blue' },
      ],
    });
  });
});

describe('acp elicitation projection', () => {
  it('translates a question schema to form fields', () => {
    const form = elicitationFormFor('form_1', 'ses_key', {
      message: 'Questions',
      requestedSchema: {
        type: 'object',
        properties: {
          q0: {
            type: 'string',
            title: 'Color preference',
            description: 'Which color?',
            oneOf: [
              { const: 'Red', title: 'Red', description: 'Choose red' },
              { const: 'Blue', title: 'Blue', description: 'Choose blue' },
            ],
          },
          q0_custom: { type: 'string', title: 'Other', description: 'Type your own' },
          count: { type: 'integer', title: 'Count', minimum: 1, maximum: 10 },
          ok: { type: 'boolean', title: 'Confirm' },
          tags: {
            type: 'array',
            title: 'Tags',
            items: { type: 'string', enum: ['red', 'blue'] },
            minItems: 1,
            maxItems: 2,
          },
        },
        required: ['q0'],
      },
    });
    expect(form.title).toBe('Questions');
    expect(form.fields.map((field) => field.key)).toEqual(['q0', 'q0_custom', 'count', 'ok', 'tags']);
    expect(form.fields[0]).toMatchObject({
      type: 'string',
      title: 'Color preference',
      required: true,
      options: [
        { value: 'Red', label: 'Red', description: 'Choose red' },
        { value: 'Blue', label: 'Blue', description: 'Choose blue' },
      ],
    });
    expect(form.fields[2]).toMatchObject({ type: 'number', minimum: 1, maximum: 10 });
    expect(form.fields[3]).toMatchObject({ type: 'boolean' });
    expect(form.fields[4]).toMatchObject({
      type: 'multiselect',
      options: [{ value: 'red', label: 'red' }, { value: 'blue', label: 'blue' }],
      minItems: 1,
      maxItems: 2,
    });
  });

  it('returns null when nothing is translatable', () => {
    expect(elicitationFormFor('form_1', 'ses_key', {
      requestedSchema: { type: 'object', properties: { x: { type: 'object' } } },
    })).toBeNull();
    expect(elicitationFormFor('form_1', 'ses_key', { requestedSchema: { type: 'object' } })).toBeNull();
  });

  it('rejects untranslatable field types', () => {
    expect(fieldForProperty('x', { type: 'object' }, false)).toBeNull();
    expect(fieldForProperty('', { type: 'string' }, false)).toBeNull();
    // Multi-select without string items has no control: never render it.
    expect(fieldForProperty('tags', { type: 'array' }, false)).toBeNull();
    expect(fieldForProperty('tags', { type: 'array', items: { type: 'number' } }, false)).toBeNull();
  });

  it('translates titled multi-select options from items.anyOf', () => {
    expect(fieldForProperty('tags', {
      type: 'array',
      items: { type: 'string', anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] },
    }, false)).toMatchObject({
      type: 'multiselect',
      options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
    });
  });

  it('coerces answers back to the schema', () => {
    const schema = {
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
        ok: { type: 'boolean' },
        tags: { type: 'array' },
      },
    };
    expect(contentForAnswer(schema, {
      name: 'x',
      count: '3',
      ok: 'true',
      tags: ['a', 1, 'b'],
      extra: 'dropped',
    })).toEqual({ name: 'x', count: 3, ok: true, tags: ['a', 'b'] });
    expect(contentForAnswer(schema, null)).toEqual({});
    // No lossy integer truncation: fractional values survive coercion so
    // validation can reject them.
    expect(contentForAnswer(schema, { count: 0.8 })).toEqual({ count: 0.8 });
  });

  it('validates coerced answers against the restricted schema', () => {
    const schema = {
      properties: {
        name: { type: 'string', minLength: 2 },
        color: { type: 'string', enum: ['red'] },
        n: { type: 'integer', minimum: 1, maximum: 5 },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 2 },
      },
      required: ['name', 'color', 'n'],
    };
    expect(validateAnswerContent(schema, { name: 'ab', color: 'red', n: 3, tags: ['a'] })).toBeNull();
    expect(validateAnswerContent(schema, { color: 'red', n: 3 })).toMatch(/missing required field: name/);
    expect(validateAnswerContent(schema, { name: 'x', color: 'red', n: 3 })).toMatch(/too short/);
    expect(validateAnswerContent(schema, { name: 'ab', color: 'blue', n: 3 })).toMatch(/invalid choice/);
    expect(validateAnswerContent(schema, { name: 'ab', color: 'red', n: 0.8 })).toMatch(/invalid integer/);
    expect(validateAnswerContent(schema, { name: 'ab', color: 'red', n: 0 })).toMatch(/too small/);
    expect(validateAnswerContent(schema, { name: 'ab', color: 'red', n: 3, tags: ['zzz'] })).toMatch(/invalid choice/);
    expect(validateAnswerContent(schema, { name: 'ab', color: 'red', n: 3, tags: ['a', 'b', 'a'] })).toMatch(/too many/);
  });

  it('never evaluates agent-supplied patterns', () => {
    const schema = {
      properties: {
        // Pathological on purpose: catastrophic backtracking if evaluated.
        evil: { type: 'string', pattern: '^([a-z]+)+$' },
        mismatch: { type: 'string', pattern: '^a+$' },
      },
    };
    // A non-matching value is still accepted: pattern conformance is the
    // agent's job, and the check must not hang the reply path.
    expect(validateAnswerContent(schema, { evil: `${'a'.repeat(30)}!`, mismatch: 'b' })).toBeNull();
    // The other bounded checks still apply alongside an unevaluated pattern.
    expect(validateAnswerContent(
      { properties: { s: { type: 'string', pattern: '^a+$', minLength: 5 } } },
      { s: 'b' },
    )).toMatch(/too short/);
  });
});
