import type { AcpBackendManager } from '../core/backend-manager.js';
import type { AcpBackendRegistry } from '../core/registry.js';

interface AcpExpressApp {
  get(path: string, handler: (req: unknown, res: unknown) => unknown): unknown;
  put(path: string, ...handlers: Array<(req: unknown, res: unknown) => unknown>): unknown;
  post(path: string, ...handlers: Array<(req: unknown, res: unknown) => unknown>): unknown;
}

export declare function registerAcpRoutes(
  app: AcpExpressApp,
  dependencies: { registry: AcpBackendRegistry; manager: AcpBackendManager },
): void;
