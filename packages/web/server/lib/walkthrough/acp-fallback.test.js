import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-acp-fallback-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

// Mocking git rather than this module's own source loading: fewer of our own
// seams faked means the test exercises the real digest and prompt path.
vi.mock('../git/service.js', () => ({
  getRepositoryRoot: vi.fn(async () => '/repo'),
  getDiff: vi.fn(),
  getRangeDiff: vi.fn(),
  getUntrackedDiffs: vi.fn(async () => []),
  listUntrackedPaths: vi.fn(async () => []),
}));
vi.mock('../small-model/index.js', () => ({
  describeSmallModel: vi.fn(),
  generateSmallModelText: vi.fn(),
  getAcpOneOffFallback: vi.fn(),
}));
const { generateWalkthrough, getWalkthrough, cancelWalkthroughGeneration, isGenerating } = await import('./index.js');
const { describeSmallModel, generateSmallModelText, getAcpOneOffFallback } = await import('../small-model/index.js');
const { getDiff } = await import('../git/service.js');

const SOURCE = { kind: 'working-tree', scope: 'all' };

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
+const added = true;
`;

const RESPONSE = JSON.stringify({
  title: 'Change',
  focus: 'why',
  chapters: [{
    title: 'Data',
    icon: 'doc',
    blurb: '',
    stops: [{ title: 'Adds a flag', hunks: ['h1'], importance: 'normal', prose: 'It adds a flag.' }],
  }],
});

const OPENCODE_MODEL = {
  providerID: 'anthropic',
  modelID: 'claude-haiku-4-5',
  source: 'config',
  inputCharBudget: 1_000_000,
  structuredOutput: true,
};

describe('ACP one-off routing', () => {
  beforeEach(async () => {
    fs.rmSync(path.join(TEMP_DATA_DIR, 'walkthroughs'), { recursive: true, force: true });
    // A persisted override written by one test must not leak into the next:
    // the settings file lives in the shared temp data dir.
    fs.rmSync(path.join(TEMP_DATA_DIR, 'settings.json'), { force: true });
    if (isGenerating('/repo', 'working-tree:all')) {
      await cancelWalkthroughGeneration({ directory: '/repo', source: SOURCE }).catch(() => {});
    }
    describeSmallModel.mockReset();
    generateSmallModelText.mockReset();
    getAcpOneOffFallback.mockReset();
    getDiff.mockImplementation(async (_dir, options) => (options?.staged ? '' : PATCH));
  });

  afterAll(() => {
    fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
  });

  it('generates ACP-first when the caller names an ACP session', async () => {
    const resolveBackend = vi.fn(async () => 'acp-backend');
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend });
    const seen = [];
    generateSmallModelText.mockImplementation(async (options) => {
      seen.push(options);
      return { text: RESPONSE };
    });

    const result = await generateWalkthrough({ directory: '/repo', source: SOURCE, sessionKey: 'ses_acp-omp_rnative-1' });

    // OpenCode resolution is never consulted for ACP-scoped requests.
    expect(describeSmallModel).not.toHaveBeenCalled();
    expect(resolveBackend).toHaveBeenCalledWith({ sessionKey: 'ses_acp-omp_rnative-1' });
    expect(result.fromCache).toBe(false);
    expect(result.walkthrough.title).toBe('Change');
    expect(result.model).toMatchObject({ providerID: 'acp-oneoff', source: 'acp-oneoff' });
    // Straight to the schema-in-prompt form: no explicit OpenCode model, no
    // wasted with-schema call, and the shape instruction travels in the system
    // prompt instead; the selection forwards so generate routes ACP-first.
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBeUndefined();
    expect(seen[0].responseSchema).toBeUndefined();
    expect(seen[0].system).toContain('Return ONLY a JSON object');
    expect(seen[0].maxOutputTokens).toBe(24_000);
    expect(seen[0].sessionKey).toBe('ses_acp-omp_rnative-1');
  });

  it('reports readiness through the selected ACP backend', async () => {
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend: async () => 'acp-backend' });

    const read = await getWalkthrough({ directory: '/repo', source: SOURCE, backendId: 'omp' });

    expect(describeSmallModel).not.toHaveBeenCalled();
    expect(read.readiness.ready).toBe(true);
    expect(read.readiness.model).toMatchObject({ providerID: 'acp-oneoff', source: 'acp-oneoff' });
  });

  it('keeps OpenCode-only no-model behavior for non-ACP callers while set', async () => {
    describeSmallModel.mockResolvedValue(null);
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend: async () => 'acp-backend' });

    await expect(generateWalkthrough({ directory: '/repo', source: SOURCE }))
      .rejects.toMatchObject({ statusCode: 404, code: 'no-model' });
    expect(generateSmallModelText).not.toHaveBeenCalled();

    const read = await getWalkthrough({ directory: '/repo', source: SOURCE });
    expect(read.readiness).toMatchObject({ ready: false, reason: 'no-model' });
  });

  it('leaves the OpenCode structured path untouched while the provider is set', async () => {
    describeSmallModel.mockResolvedValue({ ...OPENCODE_MODEL });
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend: async () => 'acp-backend' });
    const sentSchema = [];
    generateSmallModelText.mockImplementation(async ({ responseSchema }) => {
      sentSchema.push(Boolean(responseSchema));
      return { text: RESPONSE };
    });

    const result = await generateWalkthrough({ directory: '/repo', source: SOURCE });

    expect(sentSchema).toEqual([true]);
    expect(result.model).toMatchObject({ providerID: 'anthropic', source: 'config' });
  });

  it('keeps serving the cache on the OpenCode path while the provider is set', async () => {
    describeSmallModel.mockResolvedValue({ ...OPENCODE_MODEL });
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend: async () => 'acp-backend' });
    generateSmallModelText.mockResolvedValue({ text: RESPONSE });

    await generateWalkthrough({ directory: '/repo', source: SOURCE });
    generateSmallModelText.mockClear();

    const second = await generateWalkthrough({ directory: '/repo', source: SOURCE });

    expect(second.fromCache).toBe(true);
    expect(generateSmallModelText).not.toHaveBeenCalled();
  });

  it('routes ACP-scoped requests to ACP even with an explicit model choice', async () => {
    // A usable OpenCode model: ACP must win on its own merits, not because
    // OpenCode had nothing to offer.
    describeSmallModel.mockResolvedValue({ ...OPENCODE_MODEL });
    const resolveBackend = vi.fn(async () => 'acp-backend');
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend });
    const seen = [];
    generateSmallModelText.mockImplementation(async (options) => {
      seen.push(options);
      return { text: RESPONSE };
    });

    const result = await generateWalkthrough({ directory: '/repo', source: SOURCE, model: 'anthropic/claude-haiku-4-5', sessionKey: 'ses_acp-omp_rnative-1' });

    expect(describeSmallModel).not.toHaveBeenCalled();
    expect(resolveBackend).toHaveBeenCalledWith({ sessionKey: 'ses_acp-omp_rnative-1' });
    expect(result.model).toMatchObject({ providerID: 'acp-oneoff', source: 'acp-oneoff' });
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBeUndefined();
    expect(seen[0].sessionKey).toBe('ses_acp-omp_rnative-1');
  });

  it('routes ACP-scoped requests to ACP even with a persisted override', async () => {
    fs.writeFileSync(
      path.join(TEMP_DATA_DIR, 'settings.json'),
      JSON.stringify({ walkthroughModelOverride: 'anthropic/claude-haiku-4-5' }),
      'utf8',
    );
    describeSmallModel.mockResolvedValue({ ...OPENCODE_MODEL });
    const resolveBackend = vi.fn(async () => 'acp-backend');
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend });
    const seen = [];
    generateSmallModelText.mockImplementation(async (options) => {
      seen.push(options);
      return { text: RESPONSE };
    });

    const result = await generateWalkthrough({ directory: '/repo', source: SOURCE, backendId: 'omp' });

    expect(describeSmallModel).not.toHaveBeenCalled();
    expect(resolveBackend).toHaveBeenCalledWith({ backendId: 'omp' });
    expect(result.model).toMatchObject({ providerID: 'acp-oneoff', source: 'acp-oneoff' });
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBeUndefined();
    expect(seen[0].backendId).toBe('omp');
  });

  it('keeps honoring the overrides for non-ACP requests', async () => {
    fs.writeFileSync(
      path.join(TEMP_DATA_DIR, 'settings.json'),
      JSON.stringify({ walkthroughModelOverride: 'anthropic/claude-haiku-4-5' }),
      'utf8',
    );
    describeSmallModel.mockResolvedValue({ ...OPENCODE_MODEL });
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend: async () => 'acp-backend' });
    const seen = [];
    generateSmallModelText.mockImplementation(async (options) => {
      seen.push(options);
      return { text: RESPONSE };
    });

    const result = await generateWalkthrough({ directory: '/repo', source: SOURCE });

    expect(describeSmallModel).toHaveBeenCalledWith(expect.objectContaining({
      overrideModel: 'anthropic/claude-haiku-4-5',
    }));
    expect(result.model).toMatchObject({ providerID: 'anthropic', source: 'config' });
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe('anthropic/claude-haiku-4-5');
  });
});
