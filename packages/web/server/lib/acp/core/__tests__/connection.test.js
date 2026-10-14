import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AcpVersionMismatchError } from '../protocol-version.js';
import { CLIENT_CAPABILITIES, connectAcpAgent } from '../connection.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

const spawnFake = (env = {}) => spawn(process.execPath, [FAKE_AGENT], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, ...env },
});

const kill = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve();
    return;
  }
  child.once('exit', () => resolve());
  child.kill();
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
    resolve();
  }, 2000).unref?.();
});

describe('client capabilities', () => {
  it('advertises elicitation forms, compaction and child updates — never fs/terminal', () => {
    expect(CLIENT_CAPABILITIES).toEqual({
      elicitation: { form: {} },
      session: { compaction: {} },
      _meta: { 'opencode/child-session-updates': true },
    });
    expect(CLIENT_CAPABILITIES).not.toHaveProperty('fs');
    expect(CLIENT_CAPABILITIES).not.toHaveProperty('terminal');
  });
});

describe('connectAcpAgent', () => {
  it('initializes at protocol version 1 and exposes agent metadata', async () => {
    const child = spawnFake({
      FAKE_ACP_AGENT_INFO: JSON.stringify({ name: 'fake', version: '9.9' }),
      FAKE_ACP_CAPABILITIES: JSON.stringify({ loadSession: false }),
      FAKE_ACP_AUTH_METHODS: JSON.stringify([{ id: 'm1', name: 'M1' }]),
    });
    try {
      const connected = await connectAcpAgent({ child });
      expect(connected.protocolVersion).toBe(1);
      expect(connected.agentInfo).toMatchObject({ name: 'fake', version: '9.9' });
      expect(connected.agentCapabilities).toMatchObject({ loadSession: false, listSessions: true });
      expect(connected.authMethods).toEqual([{ id: 'm1', name: 'M1' }]);
      expect(connected.exited).toBeNull();
    } finally {
      await kill(child);
    }
  });

  it('rejects a v2 answer with AcpVersionMismatchError', async () => {
    const child = spawnFake({ FAKE_ACP_PROTOCOL_VERSION: '2' });
    try {
      await expect(connectAcpAgent({ child })).rejects.toBeInstanceOf(AcpVersionMismatchError);
    } finally {
      await kill(child);
    }
  });

  it('fails fast when the child exits during startup', async () => {
    // Deterministic: the fixture exits on the first stdin byte, i.e. after
    // the client sent `initialize` but before any answer — no timer races.
    const child = spawnFake({ FAKE_ACP_EXIT_CODE: '3', FAKE_ACP_EXIT_AFTER_MS: '-1', FAKE_ACP_STDERR: 'boom-traceback' });
    await expect(connectAcpAgent({ child, getStderrTail: () => '' })).rejects.toMatchObject({
      code: 'ACP_EARLY_EXIT',
    });
    expect(child.exitCode).toBe(3);
  });

  it('reports an early exit even when the stream closes first', async () => {
    // The child exits immediately at spawn: stdio EOF typically arrives
    // before Node delivers `exit`. The guard must still classify this as
    // an early exit with the real code, never a transport error.
    const child = spawnFake({ FAKE_ACP_EXIT_CODE: '7' });
    const error = await connectAcpAgent({ child, getStderrTail: () => '' }).then(
      () => null,
      (value) => value,
    );
    expect(error).toMatchObject({ code: 'ACP_EARLY_EXIT' });
    expect(error.message).toContain('code 7');
  });

  it('times out a silent initialize', async () => {
    const child = spawnFake({ FAKE_ACP_INITIALIZE_DELAY_MS: '5000' });
    try {
      await expect(connectAcpAgent({ child, timeouts: { initializeMs: 150 } })).rejects.toMatchObject({
        code: 'ACP_INITIALIZE_TIMEOUT',
      });
    } finally {
      await kill(child);
    }
  });

  it('rejects children without piped stdio', async () => {
    await expect(connectAcpAgent({ child: {} })).rejects.toMatchObject({ code: 'ACP_NO_STDIO' });
  });

  it('routes session updates, ext notifications and waitForExit through hooks', async () => {
    const seen = { updates: [], ext: [], exits: [] };
    let extResolve;
    const extArrived = new Promise((resolve) => { extResolve = resolve; });
    const child = spawnFake({
      FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
        { notify: { method: '_fake/ping', params: { n: 1 } } },
        { stopReason: 'end_turn' },
      ]),
    });
    try {
      const connected = await connectAcpAgent({
        child,
        hooks: {
          onSessionUpdate: (params) => { seen.updates.push(params); },
          onUnknownNotification: (method, params) => {
            seen.ext.push([method, params]);
            extResolve();
          },
        },
      });
      connected.events.once('exit', (exit) => seen.exits.push(exit));
      const session = await connected.connection.newSession({ cwd: process.cwd(), mcpServers: [] });
      const result = await connected.connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
      expect(result.stopReason).toBe('end_turn');
      expect(seen.updates).toHaveLength(1);
      expect(seen.updates[0].update.sessionUpdate).toBe('agent_message_chunk');
      await Promise.race([
        extArrived,
        new Promise((_, reject) => setTimeout(() => reject(new Error('ext notification never arrived')), 5000)),
      ]);
      expect(seen.ext).toEqual([['_fake/ping', expect.objectContaining({ n: 1 })]]);
      child.kill();
      const exit = await connected.waitForExit();
       expect(exit.signal !== null || exit.code !== null).toBe(true);
      expect(seen.exits).toHaveLength(1);
      expect(connected.exited).not.toBeNull();
    } finally {
      await kill(child);
    }
  });

  it('falls back to cancelled permission and elicitation answers without handlers', async () => {
    let permissionError = null;
    let elicitationError = null;
    const child = spawnFake({
      FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
        {
          permission: {
            toolCall: { toolCallId: 't1', title: 'Do it', kind: 'execute', status: 'pending', rawInput: {} },
            options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }],
          },
        },
        { elicitation: { mode: 'form', message: 'Pick one', requestedSchema: { type: 'object', properties: { a: { type: 'string' } } } } },
      ]),
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    const stderrArrived = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stderr echoes never arrived')), 15_000);
      timer.unref?.();
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.includes('PERMISSION:') && stderr.includes('ELICITATION:')) {
          clearTimeout(timer);
          resolve(stderr);
        }
      });
    });
    stderrArrived.catch(() => {});
    try {
      const connected = await connectAcpAgent({ child });
      const session = await connected.connection.newSession({ cwd: process.cwd(), mcpServers: [] });
      await connected.connection.prompt({ sessionId: session.sessionId, prompt: [] });
      await stderrArrived;
      expect(stderr).toContain('PERMISSION:{"outcome":{"outcome":"cancelled"}}');
      expect(stderr).toContain('ELICITATION:{"action":"cancel"}');
    } catch (error) {
      permissionError = error;
      elicitationError = error;
    } finally {
      await kill(child);
    }
    expect(permissionError).toBeNull();
    expect(elicitationError).toBeNull();
  });
});
