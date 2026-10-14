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

describe('ACP one-off fallback', () => {
  beforeEach(async () => {
    fs.rmSync(path.join(TEMP_DATA_DIR, 'walkthroughs'), { recursive: true, force: true });
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

  it('generates through the fallback when OpenCode resolves no model', async () => {
    describeSmallModel.mockResolvedValue(null);
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend: async () => 'acp-backend' });
    const seen = [];
    generateSmallModelText.mockImplementation(async (options) => {
      seen.push(options);
      return { text: RESPONSE };
    });

    const result = await generateWalkthrough({ directory: '/repo', source: SOURCE });

    expect(result.fromCache).toBe(false);
    expect(result.walkthrough.title).toBe('Change');
    expect(result.model).toMatchObject({ providerID: 'acp-oneoff', source: 'acp-oneoff' });
    // Straight to the schema-in-prompt form: no explicit OpenCode model, no
    // wasted with-schema call, and the shape instruction travels in the system
    // prompt instead.
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBeUndefined();
    expect(seen[0].responseSchema).toBeUndefined();
    expect(seen[0].system).toContain('Return ONLY a JSON object');
    expect(seen[0].maxOutputTokens).toBe(24_000);
  });

  it('reports readiness through the fallback model', async () => {
    describeSmallModel.mockResolvedValue(null);
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend: async () => 'acp-backend' });

    const read = await getWalkthrough({ directory: '/repo', source: SOURCE });

    expect(read.readiness.ready).toBe(true);
    expect(read.readiness.model).toMatchObject({ providerID: 'acp-oneoff', source: 'acp-oneoff' });
  });

  it('keeps the no-model failure when the fallback is unset', async () => {
    describeSmallModel.mockResolvedValue(null);
    getAcpOneOffFallback.mockReturnValue(null);

    await expect(generateWalkthrough({ directory: '/repo', source: SOURCE }))
      .rejects.toMatchObject({ statusCode: 404, code: 'no-model' });
    expect(generateSmallModelText).not.toHaveBeenCalled();

    const read = await getWalkthrough({ directory: '/repo', source: SOURCE });
    expect(read.readiness).toMatchObject({ ready: false, reason: 'no-model' });
  });

  it('leaves the OpenCode structured path untouched while the fallback is set', async () => {
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

  it('keeps serving the cache on the OpenCode path while the fallback is set', async () => {
    describeSmallModel.mockResolvedValue({ ...OPENCODE_MODEL });
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend: async () => 'acp-backend' });
    generateSmallModelText.mockResolvedValue({ text: RESPONSE });

    await generateWalkthrough({ directory: '/repo', source: SOURCE });
    generateSmallModelText.mockClear();

    const second = await generateWalkthrough({ directory: '/repo', source: SOURCE });

    expect(second.fromCache).toBe(true);
    expect(generateSmallModelText).not.toHaveBeenCalled();
  });

  it('does not apply the fallback to an explicit model choice', async () => {
    describeSmallModel.mockResolvedValue(null);
    getAcpOneOffFallback.mockReturnValue({ generate: async () => ({}), resolveBackend: async () => 'acp-backend' });

    await expect(generateWalkthrough({ directory: '/repo', source: SOURCE, model: 'anthropic/claude-haiku-4-5' }))
      .rejects.toMatchObject({ statusCode: 404, code: 'no-model' });
    expect(generateSmallModelText).not.toHaveBeenCalled();
  });
});
