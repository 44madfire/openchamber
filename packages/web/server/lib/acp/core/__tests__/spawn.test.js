import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSpawnTarget,
  killAcpProcessTree,
  resolveAcpCommand,
  resolveNpmCmdShim,
  spawnAcpAgent,
} from '../spawn.js';

// Spawn tests never touch the real managed-process registry: registration
// is stubbed per call (the orphan-recovery suite covers the real registry
// with an isolated dir).
const noRegistry = { registerProcess: () => {}, unregisterProcess: () => {} };
// Event-driven: resolves once the child's stderr pipe delivers `marker`
// (or the tail already holds it). A fixed sleep assumed the pipe had
// flushed by then; on a loaded runner it had not.
export const untilStderr = async (spawned, marker, { timeout = 15_000 } = {}) => {
  if (spawned.getStderrTail().includes(marker)) return spawned.getStderrTail();
  return new Promise((resolve, reject) => {
    let timer = null;
    const onData = () => {
      if (spawned.getStderrTail().includes(marker)) {
        clearTimeout(timer);
        spawned.child.stderr?.removeListener('data', onData);
        resolve(spawned.getStderrTail());
      }
    };
    timer = setTimeout(() => {
      spawned.child.stderr?.removeListener('data', onData);
      reject(new Error(`timed out waiting for stderr to contain ${JSON.stringify(marker)}`));
    }, timeout);
    timer.unref?.();
    spawned.child.stderr?.on('data', onData);
  });
};


const memoryFs = (files) => ({
  statSync: (candidate) => {
    if (Object.hasOwn(files, candidate)) return { isFile: () => true };
    const error = new Error('ENOENT');
    error.code = 'ENOENT';
    throw error;
  },
  accessSync: () => {},
  constants: { X_OK: 1 },
});

describe('resolveAcpCommand', () => {
  it('finds a bare command on PATH with PATHEXT probing on Windows', () => {
    const fsLike = memoryFs({ 'C:\\tools\\omp.exe': true });
    const env = { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(resolveAcpCommand('omp', { env, platform: 'win32', fsLike })).toBe('C:\\tools\\omp.exe');
  });

  it('prefers PATHEXT order when several shims exist', () => {
    const fsLike = memoryFs({ 'C:\\tools\\agent.bat': true, 'C:\\tools\\agent.cmd': true });
    const env = { PATH: 'C:\\tools', PATHEXT: '.CMD;.BAT;.EXE' };
    expect(resolveAcpCommand('agent', { env, platform: 'win32', fsLike })).toBe('C:\\tools\\agent.cmd');
  });

  it('resolves a relative path with extension directly', () => {
    const fsLike = memoryFs({ './agent.cmd': true });
    expect(resolveAcpCommand('./agent.cmd', { env: {}, platform: 'win32', fsLike })).toBe('./agent.cmd');
  });

  it('returns null for blank commands and misses', () => {
    const fsLike = memoryFs({});
    expect(resolveAcpCommand('', { env: {}, platform: 'win32', fsLike })).toBeNull();
    expect(resolveAcpCommand('nope', { env: { PATH: 'C:\\tools' }, platform: 'win32', fsLike })).toBeNull();
    expect(resolveAcpCommand('nope', { env: { PATH: '/bin' }, platform: 'linux', fsLike })).toBeNull();
  });
});

describe('buildSpawnTarget', () => {
  // A batch path that exists nowhere: shim resolution misses, so the cmd
  // fallback applies. Every arg is always quoted.
  it('wraps an unrecognized .cmd through cmd.exe /d /s /c with quoting', () => {
    const target = buildSpawnTarget('agent', ['acp', 'a b', 'q"uote'], {
      resolvedPath: 'C:\\tools\\agent.cmd',
      platform: 'win32',
    });
    expect(target.file).toBe('cmd.exe');
    expect(target.windowsVerbatimArguments).toBe(true);
    expect(target.argv.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(target.argv[3]).toBe('""C:\\tools\\agent.cmd" "acp" "a b" "q""uote""');
  });

  it('wraps .bat case-insensitively and quotes empty args', () => {
    const target = buildSpawnTarget('agent', [''], {
      resolvedPath: 'C:\\tools\\agent.BAT',
      platform: 'win32',
    });
    expect(target.file).toBe('cmd.exe');
    expect(target.windowsVerbatimArguments).toBe(true);
    expect(target.argv[3]).toBe('""C:\\tools\\agent.BAT" """');
  });

  it('refuses %/CR/LF/trailing-backslash args and paths through cmd.exe', () => {
    for (const bad of ['100%done', '%PATH%', 'a\nb', 'a\rb', 'trail\\']) {
      expect(() => buildSpawnTarget('agent', [bad], {
        resolvedPath: 'C:\\tools\\agent.cmd',
        platform: 'win32',
      })).toThrow(expect.objectContaining({ code: 'ACP_SPAWN_UNSAFE_ARG' }));
    }
    expect(() => buildSpawnTarget('agent', [], {
      resolvedPath: 'C:\\tools\\%DIR%\\agent.cmd',
      platform: 'win32',
    })).toThrow(expect.objectContaining({ code: 'ACP_SPAWN_UNSAFE_ARG' }));
  });

  it('spawns .exe and extensionless binaries directly', () => {
    expect(buildSpawnTarget('omp', ['acp'], { resolvedPath: 'C:\\tools\\omp.exe', platform: 'win32' }))
      .toEqual({ file: 'C:\\tools\\omp.exe', argv: ['acp'] });
    expect(buildSpawnTarget('agent', [], { resolvedPath: '/usr/bin/agent', platform: 'linux' }))
      .toEqual({ file: '/usr/bin/agent', argv: [] });
  });

  it('leaves unresolved commands for the OS to search', () => {
    expect(buildSpawnTarget('omp', ['acp'], { platform: 'win32' }))
      .toEqual({ file: 'omp', argv: ['acp'] });
  });
});

describe('resolveNpmCmdShim', () => {
  const writeShimDir = async (shimBody) => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-shim-'));
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'pkg', 'cli.js'), 'console.log("hi");');
    const shim = join(dir, 'agent.cmd');
    await writeFile(shim, shimBody);
    return { dir, shim, script: join(dir, 'node_modules', 'pkg', 'cli.js') };
  };

  const NODE_TEMPLATE = (scriptRel) => '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'
    + '\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n'
    + `\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${scriptRel}" %*\r\n`;

  it('resolves the node-target form to node + script', async () => {
    const { shim, script } = await writeShimDir(NODE_TEMPLATE('%dp0%\\node_modules\\pkg\\cli.js'));
    const resolved = resolveNpmCmdShim(shim);
    expect(resolved).not.toBeNull();
    expect(resolved.prefixArgs).toEqual([script]);
    expect(resolved.file.toLowerCase().endsWith('node.exe')).toBe(true);
  });

  it('resolves the direct-target form to the binary itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-shim-'));
    const exe = join(dir, 'agent.exe');
    await writeFile(exe, 'MZ');
    const shim = join(dir, 'agent.cmd');
    await writeFile(shim, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\agent.exe"   %*\r\n');
    expect(resolveNpmCmdShim(shim)).toEqual({ file: exe, prefixArgs: [] });
  });

  it('returns null for non-shims, missing targets and batch targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-shim-'));
    const plain = join(dir, 'plain.cmd');
    await writeFile(plain, '@echo off\r\necho hi %*\r\n');
    expect(resolveNpmCmdShim(plain)).toBeNull();
    expect(resolveNpmCmdShim(join(dir, 'missing.cmd'))).toBeNull();
    const dangling = join(dir, 'dangling.cmd');
    await writeFile(dangling, '@ECHO off\r\n"%dp0%\\node_modules\\pkg\\cli.js"   %*\r\n');
    expect(resolveNpmCmdShim(dangling)).toBeNull();
  });

  it('rejects custom wrappers that merely contain a similar invocation', async () => {
    const header = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';
    const script = '"%dp0%\\node_modules\\pkg\\cli.js" %*';
    const cases = {
      // Env setup the direct spawn would skip.
      'env-setting wrapper': `${header}SET FOO=bar\r\n"%_prog%"  ${script}\r\n`,
      // A different launcher behind _prog.
      'non-node _prog': `${header}SET "_prog=python"\r\n"%_prog%"  ${script}\r\n`,
      // Extra commands after the invocation.
      'trailing command': `${header}"%dp0%\\agent.exe"   %*\r\necho done\r\n`,
      // Extra commands before the invocation.
      'leading command': '@ECHO off\r\necho hi\r\n' + header.slice('@ECHO off\r\n'.length) + `"%dp0%\\agent.exe"   %*\r\n`,
      // _prog block with a substituted launcher.
      'deno _prog block': `${header}\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=deno"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n`
        + `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ${script}\r\n`,
    };
    for (const [name, body] of Object.entries(cases)) {
      const dir = await mkdtemp(join(tmpdir(), 'acp-shim-neg-'));
      await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(dir, 'node_modules', 'pkg', 'cli.js'), 'x');
      await writeFile(join(dir, 'agent.exe'), 'MZ');
      const shim = join(dir, 'agent.cmd');
      await writeFile(shim, body);
      expect(resolveNpmCmdShim(shim), name).toBeNull();
    }
  });

  it('runs a custom wrapper through cmd so its setup takes effect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-shim-wrap-'));
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    const script = join(dir, 'node_modules', 'pkg', 'cli.cjs');
    await writeFile(script, 'console.log(JSON.stringify({ env: process.env.REVIEW_SHIM_VAR ?? null }))');
    const shim = join(dir, 'agent.cmd');
    await writeFile(shim,
      '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'
      + 'SET REVIEW_SHIM_VAR=wrapper-value\r\n'
      + `"%_prog%"  "%dp0%\\node_modules\\pkg\\cli.cjs" %*\r\n`.replace('%_prog%', process.execPath));
    expect(resolveNpmCmdShim(shim)).toBeNull();
    const spawned = spawnAcpAgent({ command: shim, registerProcess: () => {}, unregisterProcess: () => {} });
    try {
      let out = '';
      spawned.child.stdout.setEncoding('utf8');
      spawned.child.stdout.on('data', (chunk) => { out += chunk; });
      const code = await new Promise((resolve) => spawned.child.once('exit', resolve));
      expect(code).toBe(0);
      expect(JSON.parse(out.trim())).toEqual({ env: 'wrapper-value' });
    } finally {
      await spawned.kill();
    }
  }, 15_000);
});

describe('spawnAcpAgent', () => {
  it('spawns node directly and captures the stderr ring', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-spawn-'));
    const script = join(dir, 'agent.mjs');
    await writeFile(script, 'process.stderr.write("hello-stderr\\n"); setTimeout(() => {}, 5000);');
    const spawned = spawnAcpAgent({ command: process.execPath, args: [script], ...noRegistry });
    try {
      expect(spawned.resolvedPath).toBe(process.execPath);
      expect(Number.isInteger(spawned.pid)).toBe(true);
      expect(await untilStderr(spawned, 'hello-stderr')).toContain('hello-stderr');
    } finally {
      await spawned.kill();
    }
     expect(spawned.child.exitCode !== null || spawned.child.signalCode !== null).toBe(true);
   });

  it('runs a plain .cmd on Windows through cmd.exe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-cmd-'));
    const shim = join(dir, 'agent.cmd');
    await writeFile(shim, '@echo off\r\necho shim-stdout\r\n');
    const spawned = spawnAcpAgent({ command: shim, ...noRegistry });
    try {
      let out = '';
      spawned.child.stdout.setEncoding('utf8');
      spawned.child.stdout.on('data', (chunk) => { out += chunk; });
      await new Promise((resolve) => spawned.child.once('exit', resolve));
      expect(out).toContain('shim-stdout');
    } finally {
      await spawned.kill();
    }
  }, 15_000);

  // The hostile argv matrix: every arg must arrive byte-exact, and none may
  // execute as a second command (an injection would print INJECTED on its own
  // line). Runs through both the shim-resolution path and the cmd fallback —
  // except %/CR/LF/trailing-backslash, which the fallback refuses by design.
  const HOSTILE_ARGS = [
    'plain', 'a b', 'safe&echo.INJECTED', 'chain&&echo.INJECTED', 'pipe|echo.INJECTED',
    'redir>echo.INJECTED', 'lt<gt', 'caret^up', 'q"uote', 'semi;colon', 'par(en)',
    'excl!mark', 'tick`x', "squote'x", 'dollar$var', 'back\\slash',
    'tab\there', 'uni-é-日本',
  ];
  // The shim path spawns with no shell, so it additionally round-trips the
  // args the cmd fallback must refuse.
  const HOSTILE_WITH_UNSAFE = [...HOSTILE_ARGS, '%PATH%', '100%done', '%UNDEF_XYZ%', 'trail\\', 'line\nbreak'];

  const collectStdout = (child) => {
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    return { text: () => out };
  };

  it('passes hostile argv byte-exact through an npm-shim .cmd (no shell)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-shim-argv-'));
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    const script = join(dir, 'node_modules', 'pkg', 'cli.js');
    await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const shim = join(dir, 'agent.cmd');
    await writeFile(shim,
      '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'
      + '\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n'
      + '\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" %*\r\n');
    const spawned = spawnAcpAgent({ command: shim, args: HOSTILE_WITH_UNSAFE, ...noRegistry });
    try {
      const out = collectStdout(spawned.child);
      const code = await new Promise((resolve) => spawned.child.once('exit', resolve));
      expect(code).toBe(0);
      // No second command ran (no INJECTED line) and argv matches exactly.
      expect(out.text()).not.toMatch(/^INJECTED$/m);
      expect(JSON.parse(out.text().trim())).toEqual(HOSTILE_WITH_UNSAFE);
    } finally {
      await spawned.kill();
    }
  }, 15_000);

  it('passes hostile argv byte-exact through a plain .bat (cmd fallback)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-bat-argv-'));
    const script = join(dir, 'cli.js');
    await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const shim = join(dir, 'plain.bat');
    // Deliberately not an npm shim: exercises the cmd.exe fallback.
    await writeFile(shim, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const spawned = spawnAcpAgent({ command: shim, args: HOSTILE_ARGS, ...noRegistry });
    try {
      const out = collectStdout(spawned.child);
      const code = await new Promise((resolve) => spawned.child.once('exit', resolve));
      expect(code).toBe(0);
      expect(out.text()).not.toMatch(/^INJECTED$/m);
      expect(JSON.parse(out.text().trim())).toEqual(HOSTILE_ARGS);
    } finally {
      await spawned.kill();
    }
  }, 15_000);

  it('refuses %-bearing args through the cmd fallback instead of expanding them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-bat-pct-'));
    const shim = join(dir, 'plain.bat');
    await writeFile(shim, '@ECHO off\r\necho hi %*\r\n');
    expect(() => spawnAcpAgent({ command: shim, args: ['%PATH%'], ...noRegistry }))
      .toThrow(expect.objectContaining({ code: 'ACP_SPAWN_UNSAFE_ARG' }));
  });

  it('handles metacharacters in the batch path itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-bat-path-'));
    const weird = join(dir, 'my dir&name');
    await mkdir(weird, { recursive: true });
    const script = join(weird, 'cli.js');
    await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const shim = join(weird, 'plain.bat');
    await writeFile(shim, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const spawned = spawnAcpAgent({ command: shim, args: ['ok', 'a&b'], ...noRegistry });
    try {
      const out = collectStdout(spawned.child);
      const code = await new Promise((resolve) => spawned.child.once('exit', resolve));
      expect(code).toBe(0);
      expect(JSON.parse(out.text().trim())).toEqual(['ok', 'a&b']);
    } finally {
      await spawned.kill();
    }
  }, 15_000);

  it('rejects unknown commands without spawning', () => {
    const spawnImpl = () => { throw new Error('must not spawn'); };
    expect(() => spawnAcpAgent({ command: 'definitely-not-an-acp-agent-xyz', spawnImpl }))
      .toThrow(/not found on PATH/);
    expect(() => spawnAcpAgent({ command: '  ', spawnImpl })).toThrow(/non-empty/);
  });

  it('converts synchronous spawn throws into AcpSpawnError', () => {
    const spawnImpl = () => {
      const error = new Error('EINVAL');
      error.code = 'EINVAL';
      throw error;
    };
    // process.execPath resolves on every platform (absolute file path).
    try {
      spawnAcpAgent({ command: process.execPath, spawnImpl });
      expect.unreachable('must throw');
    } catch (error) {
      expect(error.name).toBe('AcpSpawnError');
      expect(error.code).toBe('EINVAL');
    }
  });
});

describe('killAcpProcessTree', () => {
  it('ends a live child and tolerates repeats', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await killAcpProcessTree(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await killAcpProcessTree(child);
    await killAcpProcessTree(null);
  }, 15_000);
});
