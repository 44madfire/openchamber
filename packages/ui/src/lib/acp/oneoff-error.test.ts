import { describe, expect, test } from 'bun:test';

import { AcpApiError } from './client';
import { readOneOffFailure } from './oneoff-error';

describe('readOneOffFailure', () => {
  test('reads AcpApiError failures with backend', () => {
    const error = new AcpApiError('acp.oneoff.generate', 500, 'one-off generation on omp failed: out of funds', {
      code: 'ACP_ONEOFF_FAILED',
      backendId: 'omp',
      agentCode: -32603,
    });
    expect(readOneOffFailure(error)).toEqual({
      detail: 'one-off generation on omp failed: out of funds',
      backendId: 'omp',
    });
  });

  test('reads timeout failures without backend', () => {
    const error = new AcpApiError('acp.oneoff.generate', 504, 'one-off generation timed out after 1000 ms', {
      code: 'ACP_ONEOFF_TIMEOUT',
    });
    expect(readOneOffFailure(error)).toEqual({ detail: 'one-off generation timed out after 1000 ms' });
  });

  test('reads plain coded errors from small-model/walkthrough paths', () => {
    const failure = Object.assign(new Error('one-off generation on omp failed: boom'), {
      code: 'ACP_ONEOFF_FAILED',
      backendId: 'omp',
    });
    expect(readOneOffFailure(failure)).toEqual({
      detail: 'one-off generation on omp failed: boom',
      backendId: 'omp',
    });
  });

  test('returns null for anything else', () => {
    expect(readOneOffFailure(new Error('nope'))).toBeNull();
    expect(readOneOffFailure(new AcpApiError('acp.sessions.list', 404, 'gone', { code: 'ACP_SESSION_UNKNOWN' }))).toBeNull();
    expect(readOneOffFailure(Object.assign(new Error('x'), { code: 'small-model-unavailable' }))).toBeNull();
    expect(readOneOffFailure(null)).toBeNull();
    expect(readOneOffFailure('ACP_ONEOFF_FAILED')).toBeNull();
  });
});
