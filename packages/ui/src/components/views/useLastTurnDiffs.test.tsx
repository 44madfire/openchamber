import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Message } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useLastTurnDiffs } from './useLastTurnDiffs';

const diffCalls: string[] = [];
let diffImpl: (sessionId: string) => Promise<Array<{ file: string; patch: string; status: string; additions: number; deletions: number }>> =
  async () => [];

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getSdkClient: () => null,
    getSessionTurnDiff: async (sessionId: string) => {
      diffCalls.push(sessionId);
      return diffImpl(sessionId);
    },
  },
}));
const directory = '/repo';
const sessionId = 'ses_acp-omp_r1';

const user = (id: string): Message => ({ id, sessionID: sessionId, role: 'user', time: { created: 1 } });
const assistant = (id: string, completed: boolean): Message => ({
  id,
  sessionID: sessionId,
  role: 'assistant',
  agent: 'build',
  providerID: 'p',
  modelID: 'm',
  time: completed ? { created: 1, completed: 2 } : { created: 1 },
  ...(completed ? { finish: 'stop' as const } : {}),
});

const Probe: React.FC = () => {
  const diffs = useLastTurnDiffs(sessionId, directory, true, true);
  return <div data-testid="diffs">{diffs.map((diff) => diff.file).join(',')}</div>;
};

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container, restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      void win.happyDOM.close();
    },
  };
};

describe('useLastTurnDiffs', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  // Bootstrap stays pending, so each test owns the directory store's contents.
  const sdk = OpenCode.make({ baseUrl: 'http://turndiff.test', fetch: () => new Promise<Response>(() => undefined) });
  const store = () => {
    const result = getSyncChildStores().getChild(directory);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };
  const text = () => dom.container.querySelector('[data-testid="diffs"]')?.textContent ?? '';

  beforeEach(async () => {
    diffCalls.length = 0;
    diffImpl = async () => [];
    dom = installDom();
    root = createRoot(dom.container);
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider><Probe /></I18nProvider>
      </SyncProvider>,
    ));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  test('refetches when the session settles even though no message id changed', async () => {
    // Turn 3 streams: the assistant record exists but is unfinished, and the
    // lookup serves the newest finished turn instead.
    diffImpl = async () => [{ file: 'turn2.ts', patch: '@@ -1 +1 @@', status: 'modified', additions: 1, deletions: 0 }];
    await act(async () => {
      store().setState({
        message: { [sessionId]: [user('u3'), assistant('a3', false)] },
        session_status: { [sessionId]: { type: 'busy' } },
      });
    });
    await act(async () => {});
    // Mount fetch plus the busy-state fetch.
    expect(diffCalls).toEqual([sessionId, sessionId]);
    expect(text()).toBe('turn2.ts');

    // The turn ends: same ids, completion patch on the assistant, status idle.
    // The end snapshot lands with it, so the refetch serves turn 3.
    diffImpl = async () => [{ file: 'turn3.ts', patch: '@@ -1 +1 @@', status: 'modified', additions: 1, deletions: 0 }];
    await act(async () => {
      store().setState({
        message: { [sessionId]: [user('u3'), assistant('a3', true)] },
        session_status: { [sessionId]: { type: 'idle' } },
      });
    });
    await act(async () => {});
    expect(diffCalls).toEqual([sessionId, sessionId, sessionId]);
    expect(text()).toBe('turn3.ts');
  });

  test('a new message refetches', async () => {
    await act(async () => {
      store().setState({ message: { [sessionId]: [user('u1')] } });
    });
    await act(async () => {});
    const calls = diffCalls.length;
    await act(async () => {
      store().setState({ message: { [sessionId]: [user('u1'), assistant('a1', true)] } });
    });
    await act(async () => {});
    expect(diffCalls.length).toBe(calls + 1);
  });
});
