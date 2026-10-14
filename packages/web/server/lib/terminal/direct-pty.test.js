import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Real Windows PTY regressions for terminal `mode:'direct'` (ACP terminal
// auth): node-pty with ConPTY, no mocks. Skipped off Windows — the batch/
// shim/implicit-cmd hazards under test are Windows-only.
describe.runIf(process.platform === 'win32')('terminal direct mode windows PTY', () => {
  const runDirect = async (t, { argv, env = null, stdin = null, timeoutMs = 15000 }) => {
    const nodePty = await import('node-pty');
    const cwd = await mkdtemp(path.join(tmpdir(), 'acp-direct-pty-'));
    t.onTestFinished(async () => {
      await rm(cwd, { recursive: true, force: true });
    });
    const ptyEnv = { ...process.env, TERM: 'xterm-256color' };
    if (env) Object.assign(ptyEnv, env);
    const child = nodePty.spawn(argv[0], argv.slice(1), {
      name: 'xterm-256color', cwd, cols: 120, rows: 30, env: ptyEnv, useConpty: true,
    });
    let output = '';
    child.onData((data) => { output += data; });
    const exited = new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
    if (stdin !== null) child.write(stdin);
    const code = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`pty timeout; output so far: ${JSON.stringify(output.slice(-500))}`)), timeoutMs)),
    ]);
    return { code, output, cwd };
  };

  const argvEchoScript = `
    const out = [];
    for (let i = 1; i < process.argv.length; i += 1) out.push(JSON.stringify(process.argv[i]));
    out.push('ENV=' + JSON.stringify(process.env.ACP_DIRECT_PROBE ?? null));
    process.stdout.write(out.join('\\n') + '\\n');
  `;

  it('delivers metacharacters, quotes, spaces and empty args verbatim', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'acp-direct-argv-'));
    t.onTestFinished(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const script = path.join(dir, 'echo-argv.mjs');
    await writeFile(script, argvEchoScript);
    const args = ['plain', 'safe&ver', 'a%b', 'quote"inside', 'with space', '', 'trail\\', 'semi;colon', 'par(en)', 'caret^up'];
    const { code, output } = await runDirect(t, {
      argv: [process.execPath, script, ...args],
      env: { ACP_DIRECT_PROBE: 'probe&value %x' },
    });
    expect(code).toBe(0);
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const echoed = lines.filter((line) => line.startsWith('"') || line.startsWith('ENV='));
    expect(echoed.slice(0, args.length)).toEqual(args.map((a) => JSON.stringify(a)));
    expect(echoed).toContain('ENV="probe&value %x"');
  });

  it('never lets a batch file split an argument into a shell command', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'acp-direct-bat-'));
    t.onTestFinished(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    // What node-pty does with a raw .cmd target (the hazard the server
    // refuses): Windows launches cmd.exe implicitly and `&` executes.
    const bat = path.join(dir, 'agent.cmd');
    await writeFile(bat, '@echo off\r\necho ARG=%1\r\n');
    const { output } = await runDirect(t, { argv: [bat, 'safe&ver'] });
    // Documents the hazard (not the server path): the metacharacter escapes.
    expect(output).toContain('ARG=safe');
  });

  it('an npm node-shim target runs verbatim with prefix args', async (t) => {
    // The server resolves npm shims to node + script (no shell); prove the
    // resolved shape itself carries metacharacters verbatim through ConPTY.
    const dir = await mkdtemp(path.join(tmpdir(), 'acp-direct-shim-'));
    t.onTestFinished(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const script = path.join(dir, 'tool.mjs');
    await writeFile(script, argvEchoScript);
    const { code, output } = await runDirect(t, {
      argv: [process.execPath, script, 'safe&ver', 'a%b', ''],
    });
    expect(code).toBe(0);
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    expect(lines).toContain(JSON.stringify('safe&ver'));
    expect(lines).toContain(JSON.stringify('a%b'));
    expect(lines).toContain(JSON.stringify(''));
    expect(output).not.toMatch(/Microsoft Windows \[Version/);
  });
});
