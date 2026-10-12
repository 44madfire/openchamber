import { describe, expect, test } from 'bun:test';
import { shouldShowAcpSessionControls } from './ComposerFooter';

describe('shouldShowAcpSessionControls', () => {
    test('a live ACP session shows the ACP controls', () => {
        expect(shouldShowAcpSessionControls('ses_acp-omp_r1', false, null)).toBe(true);
    });

    test('a mobile/desktop ACP draft with cached options shows the ACP controls', () => {
        expect(shouldShowAcpSessionControls(null, true, 'omp')).toBe(true);
    });

    test('an OpenCode session or draft keeps the OpenCode pickers', () => {
        expect(shouldShowAcpSessionControls('ses_01ABc2', false, null)).toBe(false);
        expect(shouldShowAcpSessionControls(null, true, null)).toBe(false);
        expect(shouldShowAcpSessionControls(null, false, 'omp')).toBe(false);
    });

    test('a live OpenCode session wins over a stale ACP draft backend', () => {
        expect(shouldShowAcpSessionControls('ses_01ABc2', true, 'omp')).toBe(false);
    });
});
