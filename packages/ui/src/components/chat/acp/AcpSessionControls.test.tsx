import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

type SessionUIState = {
  currentSessionId: string | null;
  getDirectoryForSession: (id: string) => string | null;
  newSessionDraft: { open: boolean; acpBackendId?: string | null; acpConfig?: Record<string, string | number | boolean> | null };
  setDraftAcpConfig: (configId: string, value: string | number | boolean | null) => void;
};

const sessionUIState: SessionUIState = {
  currentSessionId: null,
  getDirectoryForSession: () => '/repo',
  newSessionDraft: { open: false },
  setDraftAcpConfig: () => undefined,
};

let uiIsMobile = false;
let sessionRecord: { metadata?: Record<string, unknown> } | null = null;
const configCalls: Array<{ key: string; configId: string; value: string | number | boolean }> = [];
let configError: Error | null = null;
const draftWrites: Array<{ configId: string; value: string | number | boolean | null }> = [];
const toastErrors: Array<{ message: string; description?: string }> = [];
type BackendOption = { id: string; name?: string; current?: string; options?: Array<{ id: string; name?: string }> };
const backendCaches = new Map<string, BackendOption[] | Promise<BackendOption[]>>();
const backendCacheCalls: string[] = [];

mock.module('@/sync/sync-context', () => ({
  useSession: () => sessionRecord,
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <T,>(selector: (state: SessionUIState) => T): T => selector(sessionUIState),
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: { isMobile: boolean }) => T): T => selector({ isMobile: uiIsMobile }),
}));
mock.module('@/lib/acp/client', () => ({
  acpClient: {
    setSessionConfig: async (key: string, configId: string, value: string | number | boolean) => {
      configCalls.push({ key, configId, value });
      if (configError) throw configError;
    },
    getBackendConfigCache: async (backendId: string) => {
      backendCacheCalls.push(backendId);
      return backendCaches.get(backendId) ?? [];
    },
  },
  // The real reader is covered by client.test.ts; the controls only need its output shape.
  readAcpSessionMeta: (session: { metadata?: Record<string, unknown> } | null | undefined) => {
    const acp = session?.metadata?.acp as
      | { backendId: string; configOptions?: unknown[]; modes?: Array<{ id: string; name?: string; current?: boolean }> }
      | undefined;
    if (!acp?.backendId) return null;
    return {
      backendId: acp.backendId,
      capabilities: {},
      configOptions: (acp.configOptions ?? []) as Array<{ id: string; name?: string; current?: string; options?: Array<{ id: string; name?: string }> }>,
      modes: acp.modes ?? [],
    };
  },
}));
mock.module('../chatColumnSession', () => ({
  useChatSessionSelection: () => ({ sessionId: sessionUIState.currentSessionId, directory: '/repo' }),
}));
mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string, options?: { description?: string }) => {
      toastErrors.push({ message, description: options?.description });
    },
  },
}));
mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
mock.module('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
mock.module('@/components/ui/MobileOverlayPanel', () => ({
  MobileOverlayPanel: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
}));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
mock.module('@/components/icon/Icon', () => ({
  Icon: () => <span />,
}));

// mock.module installs above must take effect before this module loads, so the import stays dynamic.
const { AcpSessionControls } = await import('./AcpSessionControls');

const ACP_ID = 'ses_acp-omp_r1';

const sessionWith = (acp: Record<string, unknown>) => ({ metadata: { acp } });

describe('AcpSessionControls', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    sessionUIState.currentSessionId = null;
    sessionUIState.newSessionDraft = { open: false };
    sessionUIState.setDraftAcpConfig = () => undefined;
    sessionRecord = null;
    uiIsMobile = false;
    configCalls.length = 0;
    configError = null;
    draftWrites.length = 0;
    toastErrors.length = 0;
    backendCaches.clear();
    backendCacheCalls.length = 0;
    windowInstance = new Window({ url: 'http://localhost/' });
    // SAFETY: the test installs a happy-dom Window for the component and restores the original global afterward.
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      Node: windowInstance.Node,
      Element: windowInstance.Element,
      HTMLElement: windowInstance.HTMLElement,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      MutationObserver: windowInstance.MutationObserver,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
      cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    windowInstance.close();
  });

  const render = async (variant?: 'desktop' | 'mobile') => {
    await act(async () => {
      root.render(<AcpSessionControls variant={variant} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  test('renders nothing for OpenCode sessions', async () => {
    sessionUIState.currentSessionId = 'ses_01ABc2';
    await render();
    expect(host.textContent).toBe('');
  });

  test('renders one select per config option with the current value', async () => {
    sessionUIState.currentSessionId = ACP_ID;
    sessionRecord = sessionWith({
      backendId: 'omp',
      configOptions: [
        { id: 'model', name: 'Model', current: 'm1', options: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }] },
        { id: 'effort', current: 'high', options: [{ id: 'low' }, { id: 'high' }] },
      ],
    });
    await render();
    expect(host.textContent).toContain('Model One');
    expect(host.textContent).toContain('Model Two');
    expect(host.textContent).toContain('high');
  });

  test('falls back to a modes select when the agent offers modes without config options', async () => {
    sessionUIState.currentSessionId = ACP_ID;
    sessionRecord = sessionWith({
      backendId: 'omp',
      configOptions: [],
      modes: [{ id: 'build', name: 'Build', current: true }, { id: 'plan', name: 'Plan' }],
    });
    await render();
    expect(host.textContent).toContain('Build');
    expect(host.textContent).toContain('Plan');
  });

  test('an opaque option plus modes renders no mode selector (server dispatch agrees)', async () => {
    sessionUIState.currentSessionId = ACP_ID;
    sessionRecord = sessionWith({
      backendId: 'omp',
      configOptions: [{ id: 'freeform' }],
      modes: [{ id: 'build', name: 'Build', current: true }, { id: 'plan', name: 'Plan' }],
    });
    await render();
    expect(host.textContent).toBe('');
  });
  test('switching draft backends hides the old backend values until the new cache lands', async () => {
    let releaseB!: (value: BackendOption[]) => void;
    const optionA = { id: 'model', name: 'Model A', options: [{ id: 'a1', name: 'Model A One' }] };
    backendCaches.set('backend-a', [optionA]);
    backendCaches.set(
      'backend-b',
      new Promise<BackendOption[]>((resolve) => {
        releaseB = resolve;
      }),
    );
    sessionUIState.newSessionDraft = { open: true, acpBackendId: 'backend-a', acpConfig: { model: 'a1' } };
    sessionUIState.setDraftAcpConfig = (configId, value) => {
      draftWrites.push({ configId, value });
    };
    await render();
    expect(backendCacheCalls).toEqual(['backend-a']);
    expect(host.textContent).toContain('Model A One');
    sessionUIState.newSessionDraft = { open: true, acpBackendId: 'backend-b' };
    // The mock store has no subscriptions; re-render to pick up the new backend.
    await render();
    expect(backendCacheCalls).toEqual(['backend-a', 'backend-b']);
    expect(host.textContent).toBe('');
    expect(draftWrites).toEqual([]);
    releaseB([{ id: 'model', name: 'Model B', options: [{ id: 'b1', name: 'Model B One' }] }]);
    await render();
    expect(host.textContent).toContain('Model B One');
    expect(host.textContent).not.toContain('Model A One');
  });

  test('the mobile option picker exposes radio state and group labels', async () => {
    sessionUIState.currentSessionId = ACP_ID;
    sessionRecord = sessionWith({
      backendId: 'omp',
      configOptions: [
        { id: 'model', name: 'Model', current: 'm1', options: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }] },
      ],
    });
    await render('mobile');
    const buttons = [...host.querySelectorAll('button')];
    await act(async () => {
      buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const group = host.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute('aria-labelledby')).toBe('acp-config-model-label');
    expect(host.querySelector('#acp-config-model-label')?.textContent).toBe('Model');
    const radios = [...host.querySelectorAll('[role="radio"]')];
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    await act(async () => {
      radios[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelectorAll('[role="radio"]')[0].getAttribute('aria-checked')).toBe('true');
  });

  test('a mobile change calls the config route', async () => {
    sessionUIState.currentSessionId = ACP_ID;
    sessionRecord = sessionWith({
      backendId: 'omp',
      configOptions: [
        { id: 'model', name: 'Model', current: 'm1', options: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }] },
      ],
    });
    await render('mobile');
    // Open the sheet, then pick the other model.
    const buttons = [...host.querySelectorAll('button')];
    await act(async () => {
      buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const options = [...host.querySelectorAll('button')].filter((button) => button.textContent?.includes('Model Two'));
    expect(options).toHaveLength(1);
    await act(async () => {
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(configCalls).toEqual([{ key: ACP_ID, configId: 'model', value: 'm2' }]);
  });

  test('an invalid value toasts the agent message', async () => {
    sessionUIState.currentSessionId = ACP_ID;
    sessionRecord = sessionWith({
      backendId: 'omp',
      configOptions: [
        { id: 'model', name: 'Model', current: 'm1', options: [{ id: 'm1' }, { id: 'm2' }] },
      ],
    });
    configError = new Error('acp.sessions.config failed (422): Unknown model "m2"');
    await render('mobile');
    const buttons = [...host.querySelectorAll('button')];
    await act(async () => {
      buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const options = [...host.querySelectorAll('button')].filter((button) => button.textContent === 'm2');
    await act(async () => {
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(configCalls).toHaveLength(1);
    expect(toastErrors).toEqual([{ message: 'chat.acpSessionControls.changeFailed', description: 'Unknown model "m2"' }]);
  });
});
