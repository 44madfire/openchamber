import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const requests: Array<{ url: URL; method: string; body: unknown }> = [];
const responses: Response[] = [];

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock<RuntimeFetch>(async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url, 'http://runtime.test');
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    // Background OpenCode probes (location, sessions) must not eat queued answers.
    if (!url.pathname.startsWith('/api/acp/')) return json({ data: {} });
    const next = responses.shift();
    if (!next) throw new Error('No mocked response queued');
    return next;
  }),
}));

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
type Root = import('react-dom/client').Root;
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { useAcpBackendsStore } = await import('@/stores/useAcpBackendsStore');
const { AcpPage } = await import('./AcpPage');
const { authTerminalDisplayLines } = await import('./AcpDetail');

const terminalCreates: Array<Record<string, unknown>> = [];
const backend = {
  id: 'omp',
  label: 'omp',
  enabled: true,
  state: 'ready',
  protocolVersion: 1,
  agentInfo: { name: 'omp', version: '18.8.7' },
  agentCapabilities: { loadSession: {}, deleteSession: {} },
  authMethods: [{ id: 'oauth', name: 'OAuth', type: 'agent' }],
  lastError: null,
  stderrTail: '',
  entry: { id: 'omp', label: 'omp', command: 'omp', args: ['acp'], enabled: true },
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  requests.length = 0;
  responses.length = 0;
  useAcpBackendsStore.setState({ backends: null, loadError: null, loading: false, selectedId: null, creating: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  // Dialogs portal to document.body outside the container.
  document.body.innerHTML = '';
});

const render = () => act(async () => {
  root.render(
    <RuntimeAPIContext.Provider value={{
      terminal: {
        createSession: async (options: Record<string, unknown>) => {
          terminalCreates.push(options);
          return { sessionId: 'term-auth-1', cols: 80, rows: 24, status: 'running', mode: 'direct' };
        },
      },
    } as never}>
      <I18nProvider><AcpPage /></I18nProvider>
    </RuntimeAPIContext.Provider>,
  );
});

const setInputValue = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setValue) throw new Error('Missing value setter');
  await act(async () => {
    setValue.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('AcpPage', () => {
  test('grid renders backend status', async () => {
    responses.push(json({ backends: [backend] }));
    await render();
    await act(async () => {});
    expect(container.textContent).toContain('omp');
    expect(container.textContent).toContain('Ready');
    expect(container.textContent).toContain('18.8.7');
  });

  test('editing and saving PUTs the whole registry', async () => {
    responses.push(json({ backends: [backend] }));
    await render();
    await act(async () => {});
    const card = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('omp'));
    if (!card) throw new Error('Missing backend card');
    await act(async () => { card.click(); });
    const commandField = [...container.querySelectorAll('input')].find((input) => input.placeholder === 'omp');
    if (!commandField) throw new Error('Missing command field');
    await setInputValue(commandField as HTMLInputElement, 'omp-new');
    const updated = { ...backend, entry: { ...backend.entry, command: 'omp-new' } };
    responses.push(json({ backends: [updated] }));
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save');
    if (!save) throw new Error('Missing save button');
    await act(async () => { save.click(); });
    await act(async () => {});
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.url.pathname).toBe('/api/acp/backends');
    expect(put?.body).toEqual({ backends: [{ ...backend.entry, command: 'omp-new' }] });
  });

  test('restart posts and refreshes the entry', async () => {
    responses.push(json({ backends: [backend] }));
    await render();
    await act(async () => {});
    const card = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('omp'));
    if (!card) throw new Error('Missing backend card');
    await act(async () => { card.click(); });
    const restarted = { id: 'omp', state: 'ready', protocolVersion: 1, agentInfo: null, agentCapabilities: null, authMethods: [], lastError: null, stderrTail: '' };
    responses.push(json({ backend: restarted }));
    const restart = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Restart');
    if (!restart) throw new Error('Missing restart button');
    await act(async () => { restart.click(); });
    await act(async () => {});
    const restartRequest = requests.find((request) => request.url.pathname === '/api/acp/backends/omp/restart');
    expect(restartRequest?.method).toBe('POST');
    // The restart snapshot carries no registry entry: the store merges it
    // over the held record so the editor keeps its form source.
    expect(useAcpBackendsStore.getState().backends?.[0]).toMatchObject({ id: 'omp', state: 'ready', entry: backend.entry });
  });

  test('terminal auth opens a dialog showing the structured invocation', async () => {
    const terminalBackend = {
      ...backend,
      authMethods: [{ id: 'login', name: 'Login', type: 'terminal' }],
    };
    responses.push(json({ backends: [terminalBackend] }));
    await render();
    await act(async () => {});
    const card = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('omp'));
    if (!card) throw new Error('Missing backend card');
    await act(async () => { card.click(); });
    responses.push(json({ command: 'C:\\Program Files\\omp\\omp.exe', args: ['auth', 'login flow', ''], env: { TOKEN_DIR: '/tmp/a b' }, methodId: 'login' }));
    const terminalButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent === 'Open terminal sign-in',
    );
    if (!terminalButton) throw new Error('Missing terminal auth button');
    await act(async () => { terminalButton.click(); });
    for (let tick = 0; tick < 10 && !document.body.textContent?.includes('Terminal sign-in'); tick += 1) {
      await act(async () => {});
    }
    const authRequest = requests.find((request) => request.url.pathname === '/api/acp/backends/omp/auth/terminal');
    expect(authRequest?.method).toBe('POST');
    expect(authRequest?.body).toEqual({ methodId: 'login' });
    // The dialog portals to document.body: env lines plus indexed argv words,
    // verbatim — no shell quoting, so PowerShell/cmd paths stay intact.
    expect(document.body.textContent).toContain('TOKEN_DIR=/tmp/a b');
    expect(document.body.textContent).toContain('[0] C:\\Program Files\\omp\\omp.exe');
    expect(document.body.textContent).toContain('[1] auth');
    expect(document.body.textContent).toContain('[2] login flow');
    expect(document.body.textContent).toContain('Restart backend');
  });

  test('opening the terminal spawns argv/env directly with no shell string', async () => {
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    useProjectsStore.setState({
      projects: [{ id: 'proj_1', path: '/repo' } as never],
      activeProjectId: 'proj_1',
    });
    const terminalBackend = {
      ...backend,
      authMethods: [{ id: 'login', name: 'Login', type: 'terminal' }],
    };
    responses.push(json({ backends: [terminalBackend] }));
    responses.push(json({ command: 'C:\\Program Files\\omp\\omp.exe', args: ['auth', 'x y', ''], env: { TOKEN_DIR: 'C:\\Users\\me\\a b' }, methodId: 'login' }));
    await render();
    await act(async () => {});
    const card = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('omp'));
    if (!card) throw new Error('Missing backend card');
    await act(async () => { card.click(); });
    const terminalButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent === 'Open terminal sign-in',
    );
    if (!terminalButton) throw new Error('Missing terminal auth button');
    await act(async () => { terminalButton.click(); });
    for (let tick = 0; tick < 10 && !document.body.textContent?.includes('Terminal sign-in'); tick += 1) {
      await act(async () => {});
    }
    terminalCreates.length = 0;
    const openButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Open terminal');
    if (!openButton) throw new Error('Missing open-terminal button');
    await act(async () => { openButton.click(); });
    await act(async () => {});
    expect(terminalCreates).toHaveLength(1);
    expect(terminalCreates[0]).toMatchObject({
      mode: 'direct',
      argv: ['C:\\Program Files\\omp\\omp.exe', 'auth', 'x y', ''],
      env: { TOKEN_DIR: 'C:\\Users\\me\\a b' },
    });
    expect(terminalCreates[0]).not.toHaveProperty('command');
  });

  test('a registry-invalid save surfaces the server message and keeps the prior registry', async () => {
    responses.push(json({ backends: [backend] }));
    await render();
    await act(async () => {});
    const card = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('omp'));
    if (!card) throw new Error('Missing backend card');
    await act(async () => { card.click(); });
    // 65 args passes the form but violates the server's 64-arg limit.
    const argsField = [...container.querySelectorAll('textarea')].find((field) => field.getAttribute('aria-label') === 'Arguments');
    if (!argsField) throw new Error('Missing args field');
    await setInputValue(argsField as HTMLTextAreaElement, Array.from({ length: 65 }, (_, i) => `arg${i}`).join('\n'));
    responses.push(json({ error: 'Too many args: at most 64 allowed', code: 'ACP_REGISTRY_INVALID' }, 422));
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save');
    if (!save) throw new Error('Missing save button');
    await act(async () => { save.click(); });
    await act(async () => {});
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Too many args: at most 64 allowed');
    expect(useAcpBackendsStore.getState().backends).toEqual([backend]);
  });

  test('every editor control has an accessible name', async () => {
    responses.push(json({ backends: [backend] }));
    await render();
    await act(async () => {});
    const card = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('omp'));
    if (!card) throw new Error('Missing backend card');
    await act(async () => { card.click(); });
    const named = (element: Element | null | undefined): string =>
      element?.getAttribute('aria-label') ?? '';
    const byName = (name: string): Element => {
      const field = [...container.querySelectorAll('input, textarea')].find((entry) => named(entry) === name);
      if (!field) throw new Error(`Missing control named ${name}`);
      return field;
    };
    // Every editor control carries the visible label as its accessible name
    // (the checkbox primitive's hidden input is excluded: its name lives on
    // the checkbox root, asserted below).
    byName('ID');
    byName('Label');
    byName('Command');
    byName('Arguments');
    expect(container.querySelector('[role="checkbox"]')?.getAttribute('aria-label')).toBe('Enable backend');
  });
});

describe('authTerminalDisplayLines', () => {
  test('renders env lines then indexed argv words verbatim', () => {
    expect(authTerminalDisplayLines({ command: 'omp', args: ['acp'], env: {}, methodId: 'm' }))
      .toEqual(['[0] omp', '[1] acp']);
    expect(authTerminalDisplayLines({
      command: 'C:\\Program Files\\omp\\omp.exe',
      args: ['a b', 'say "hi"', ''],
      env: { K: 'v v' },
      methodId: 'm',
    })).toEqual([
      'K=v v',
      '[0] C:\\Program Files\\omp\\omp.exe',
      '[1] a b',
      '[2] say "hi"',
      '[3] ',
    ]);
  });
});
