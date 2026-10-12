import { describe, expect, it } from 'vitest';

import {
  ACP_SESSION_KEY_MAX_LENGTH,
  decode,
  encode,
  isAcpSessionKey,
} from '../session-key.js';

describe('session-key codec', () => {
  it('round-trips a link-safe native id in raw form', () => {
    const key = encode('omp', 'ses_abc-123_XYZ');
    expect(key).toBe('ses_acp-omp_rses_abc-123_XYZ');
    expect(isAcpSessionKey(key)).toBe(true);
    expect(decode(key)).toEqual({ backendId: 'omp', nativeId: 'ses_abc-123_XYZ' });
  });

  it('base64url-encodes native ids with unsafe characters', () => {
    const key = encode('pi-acp', 'sess/with spaces+plus');
    expect(key.startsWith('ses_acp-pi-acp_e')).toBe(true);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decode(key)).toEqual({ backendId: 'pi-acp', nativeId: 'sess/with spaces+plus' });
  });

  it('round-trips unicode native ids', () => {
    const key = encode('opencode', 'séance-日本語');
    expect(decode(key)).toEqual({ backendId: 'opencode', nativeId: 'séance-日本語' });
  });

  it('rejects backend ids outside the allowed shape', () => {
    for (const bad of ['OMP', 'om_p', '-omp', 'omp-', '', 'omp!', 'Omp']) {
      expect(() => encode(bad, 'abc')).toThrow();
      expect(isAcpSessionKey(`ses_acp-${bad}_rabc`)).toBe(false);
    }
    expect(encode('a-b2-c3', 'x')).toBe('ses_acp-a-b2-c3_rx');
  });

  it('rejects empty or non-string native ids', () => {
    expect(() => encode('omp', '')).toThrow();
    expect(() => encode('omp', null)).toThrow();
    expect(() => encode('omp', 42)).toThrow();
  });

  it('enforces the 128-character limit', () => {
    expect(ACP_SESSION_KEY_MAX_LENGTH).toBe(128);
    const fits = `ses_acp-omp_r${'a'.repeat(128 - 'ses_acp-omp_r'.length)}`;
    expect(fits).toHaveLength(128);
    expect(isAcpSessionKey(fits)).toBe(true);
    expect(() => encode('omp', 'a'.repeat(129))).toThrow(/128/);
    expect(isAcpSessionKey(`${fits}x`)).toBe(false);
    // The encoded form counts too, not just the native id.
    expect(() => encode('omp', 'é'.repeat(100))).toThrow(/128/);
  });

  it('rejects malformed keys', () => {
    expect(isAcpSessionKey('ses_abc123')).toBe(false);
    expect(isAcpSessionKey('ses_acp-omp')).toBe(false);
    expect(isAcpSessionKey('ses_acp-omp_rabc/def')).toBe(false);
    expect(isAcpSessionKey('ses_acp-omp_xabc')).toBe(false);
    expect(isAcpSessionKey('ses_acp-omp_r')).toBe(false);
    expect(isAcpSessionKey('ses_acp-_rabc')).toBe(false);
    expect(isAcpSessionKey('')).toBe(false);
    expect(isAcpSessionKey(null)).toBe(false);
    expect(isAcpSessionKey(42)).toBe(false);
    expect(decode('ses_abc123')).toBeNull();
    expect(decode('ses_acp-omp_r')).toBeNull();
  });

  it('returns null for _e keys that do not round-trip', () => {
    // Valid shape but decodes to empty / mismatched re-encode.
    expect(decode('ses_acp-omp_e====')).toBeNull();
  });
});
