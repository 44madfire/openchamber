import { afterEach, describe, expect, test } from 'bun:test';

/**
 * Same directory, two runtimes: the OpenCode agent catalog and the ACP backend
 * registry both belong to the runtime that answered them, so the endpoint reset
 * must drop both. Two runtimes can serve the same directory (a local server
 * and a remote one over the same checkout), and the agents store keys its
 * catalog by directory alone — without its reset, runtime B keeps serving A's
 * agents from cache, within TTL without even refetching.
 *
 * The whole switch on real modules: the endpoint event, the app-wide reset,
 * the client rebind and both stores, with only `fetch` stubbed. Each runtime
 * answers its own agent list and registry; everything else is not there.
 */

const RUNTIME_A = 'http://127.0.0.1:4100';
const RUNTIME_B = 'https://runtime-b.example';
const DIRECTORY = '/srv/shared/checkout';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch;

const installWindow = (): void => {
  const events = new EventTarget();
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, String(value));
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: () => null,
    length: 0,
  } satisfies Storage;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __OPENCHAMBER_LOCAL_ORIGIN__: RUNTIME_A,
      __OPENCHAMBER_API_BASE_URL__: RUNTIME_A,
      localStorage,
      // The packaged desktop page: not an http origin, so the API base comes
      // from the injected globals above.
      location: new URL('openchamber-ui://app/index.html'),
      matchMedia: () => ({ matches: false }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
};

type SeenRequest = { origin: string; path: string };
const seen: SeenRequest[] = [];

const sdkAgent = (name: string) => ({
  id: name,
  name,
  displayName: name,
  mode: 'primary',
  hidden: false,
  request: { settings: {}, headers: {}, body: {} },
  permissions: [],
});

const acpBackend = (id: string) => ({
  id,
  label: id,
  state: 'ready',
  protocolVersion: null,
  agentInfo: null,
  agentCapabilities: null,
  authMethods: [],
  lastError: null,
  stderrTail: '',
});

// Each runtime answers with its own catalog and registry.
const stubFetch = (): void => {
  const respond = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({ origin: url.origin, path: url.pathname });
    const isRuntimeB = url.origin === new URL(RUNTIME_B).origin;
    if (url.pathname === '/api/agent') {
      const name = isRuntimeB ? 'agent-from-b' : 'agent-from-a';
      return Response.json({ data: [sdkAgent(name)] });
    }
    if (url.pathname.startsWith('/api/config/agents/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/config/agents/'.length));
      return Response.json({
        name,
        scope: 'user',
        sources: { md: { exists: true, scope: 'user', path: `/home/u/.config/opencode/agents/${name}.md` } },
        isBuiltIn: false,
      });
    }
    if (url.pathname === '/api/acp/backends') {
      const id = isRuntimeB ? 'backend-from-b' : 'backend-from-a';
      return Response.json({ backends: [acpBackend(id)] });
    }
    return new Response(null, { status: 404 });
  };
  // SAFETY: the modules under test only call fetch(input, init); Bun's extra
  // `preconnect` member is never read.
  globalThis.fetch = respond as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of [['window', originalWindow], ['localStorage', originalLocalStorage]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('agent catalog across a same-directory runtime switch', () => {
  test("runtime B cannot use runtime A's cached agents, and neither can its ACP registry", async () => {
    installWindow();
    stubFetch();
    // Deferred imports: these modules read `window` at load time (runtime URL
    // injection, persisted stores), so they can only load after the shim above
    // is installed — static imports would bind before it exists.
    const { opencodeClient } = await import('@/lib/opencode/client');
    const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
    const { selectAgentsForDirectory, useAgentsStore } = await import('@/stores/useAgentsStore');
    const { useAcpBackendsStore } = await import('@/stores/useAcpBackendsStore');
    const { installRuntimeEndpointReset } = await import('./runtimeEndpointReset');

    // Runtime A serves the directory; both catalogs load from it.
    opencodeClient.setDirectory(DIRECTORY);
    expect(await useAgentsStore.getState().loadAgents(DIRECTORY)).toBe(true);
    await useAcpBackendsStore.getState().load();
    expect(selectAgentsForDirectory(useAgentsStore.getState(), DIRECTORY).map((agent) => agent.name)).toEqual(['agent-from-a']);
    expect(useAcpBackendsStore.getState().backends?.map((backend) => backend.id)).toEqual(['backend-from-a']);

    const agentListRequests = (): number => seen.filter((request) => request.path === '/api/agent').length;
    const requestsBeforeSwitch = agentListRequests();
    expect(requestsBeforeSwitch).toBeGreaterThan(0);

    // The A→B switch through the same subscriber the app installs.
    const uninstall = installRuntimeEndpointReset();
    try {
      seen.length = 0;
      switchRuntimeEndpoint({ apiBaseUrl: RUNTIME_B, runtimeKey: 'runtime-b' });

      // Both stores reset: no catalog, no registry, no selection survives.
      // The agents store keys by directory alone, so B's directory hits the
      // same cache entry A filled — it must be empty now.
      expect(selectAgentsForDirectory(useAgentsStore.getState(), DIRECTORY)).toEqual([]);
      expect(useAgentsStore.getState().agents).toEqual([]);
      expect(useAcpBackendsStore.getState().backends).toBeNull();

      // B refetches both from its own runtime instead of serving A's cache:
      // the agents freshness bookkeeping was cleared too, so this load cannot
      // return early within TTL. (Without the agents reset this request never
      // fires and the catalog below still names A's agent.)
      opencodeClient.setDirectory(DIRECTORY);
      expect(await useAgentsStore.getState().loadAgents(DIRECTORY)).toBe(true);
      await useAcpBackendsStore.getState().load();

      expect(agentListRequests()).toBeGreaterThan(0);
      expect(seen.filter((request) => request.path === '/api/agent').every((request) => request.origin === new URL(RUNTIME_B).origin)).toBe(true);
      expect(selectAgentsForDirectory(useAgentsStore.getState(), DIRECTORY).map((agent) => agent.name)).toEqual(['agent-from-b']);
      expect(useAcpBackendsStore.getState().backends?.map((backend) => backend.id)).toEqual(['backend-from-b']);
    } finally {
      uninstall();
    }
  });
});
