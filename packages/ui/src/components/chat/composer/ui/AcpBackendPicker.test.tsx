import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

type SessionUIState = {
  newSessionDraft: { open: boolean; acpBackendId?: string | null };
  setDraftAcpBackendId: (backendId: string | null, options?: { remember?: boolean }) => void;
};

const sessionUIState: SessionUIState = {
  newSessionDraft: { open: false },
  setDraftAcpBackendId: () => undefined,
};

type BackendStatus = {
  id: string;
  label?: string;
  enabled?: boolean;
  state: 'unconfigured' | 'idle' | 'starting' | 'ready' | 'error';
};

let listedBackends: BackendStatus[] | Error = [];
const backendWrites: Array<{ backendId: string | null; options?: { remember?: boolean } }> = [];

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <T,>(selector: (state: SessionUIState) => T): T => selector(sessionUIState),
}));
mock.module('@/lib/acp/client', () => ({
  acpClient: {
    listBackends: async () => {
      if (listedBackends instanceof Error) throw listedBackends;
      return listedBackends;
    },
  },
}));
mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
mock.module('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange }: { children: React.ReactNode; value: string; onValueChange: (value: string) => void }) => (
    <div data-value={value} data-testid="backend-select">
      <button type="button" data-testid="pick-omp" onClick={() => onValueChange('omp')}>pick omp</button>
      <button type="button" data-testid="pick-opencode" onClick={() => onValueChange('')}>pick opencode</button>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// mock.module installs above must take effect before this module loads, so the import stays dynamic.
const { AcpBackendPicker } = await import('./AcpBackendPicker');

const usable = (overrides: Partial<BackendStatus> & { id: string }): BackendStatus => ({
  label: overrides.id,
  enabled: true,
  state: 'idle',
  ...overrides,
});

describe('AcpBackendPicker', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    sessionUIState.newSessionDraft = { open: true, acpBackendId: null };
    sessionUIState.setDraftAcpBackendId = (backendId, options) => {
      backendWrites.push({ backendId, options });
      sessionUIState.newSessionDraft = { ...sessionUIState.newSessionDraft, acpBackendId: backendId };
    };
    listedBackends = [];
    backendWrites.length = 0;
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

  const render = async () => {
    await act(async () => {
      root.render(<AcpBackendPicker />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const selectValue = () => host.querySelector('[data-testid="backend-select"]')?.getAttribute('data-value') ?? null;

  test('preselects the remembered agent and keeps it when usable', async () => {
    sessionUIState.newSessionDraft = { open: true, acpBackendId: 'omp' };
    listedBackends = [usable({ id: 'omp' }), usable({ id: 'pi-acp' })];
    await render();

    expect(selectValue()).toBe('omp');
    expect(backendWrites).toEqual([]);
  });
  test('a remembered agent the list no longer offers falls back to OpenCode without erasing the memory', async () => {
    sessionUIState.newSessionDraft = { open: true, acpBackendId: 'omp' };
    listedBackends = [usable({ id: 'pi-acp' })];
    await render();

    expect(backendWrites).toEqual([{ backendId: null, options: { remember: false } }]);
    // The mock store has no subscriptions; re-render to pick up the reset.
    await render();
    expect(selectValue()).toBe('');
  });
  test('disabled and erroring backends never become the fallback selection', async () => {
    sessionUIState.newSessionDraft = { open: true, acpBackendId: 'omp' };
    listedBackends = [usable({ id: 'omp', enabled: false }), usable({ id: 'pi-acp', state: 'error' })];
    await render();

    // No usable backend at all renders nothing, and the draft still resets —
    // but the reset is automatic, so the memory survives.
    expect(host.textContent).toBe('');
    expect(backendWrites).toEqual([{ backendId: null, options: { remember: false } }]);
  });

  test('an explicit user pick is recorded for the next draft', async () => {
    listedBackends = [usable({ id: 'omp' })];
    await render();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="pick-omp"]')?.click();
    });

    expect(backendWrites).toEqual([{ backendId: 'omp', options: undefined }]);
  });
});
