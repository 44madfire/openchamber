import { isAcpSessionKey } from '../acp/core/session-key.js';

export function registerSmallModelRoutes(app, { getSmallModelService }) {
  app.get('/api/small-model', async (req, res) => {
    try {
      const { describeSmallModel, listAuthenticatedProviders, getAcpOneOffFallback } = await getSmallModelService();
      const sessionKey = typeof req.query.sessionKey === 'string' ? req.query.sessionKey : undefined;
      const backendId = typeof req.query.backendId === 'string' ? req.query.backendId : undefined;
      // ACP-scoped availability: the caller named an ACP session or
      // backend, so report the ACP route — but only when a backend can
      // actually be resolved, not merely because a provider is wired.
      if ((backendId || (sessionKey && isAcpSessionKey(sessionKey))) && getAcpOneOffFallback?.()) {
        const provider = getAcpOneOffFallback();
        try {
          const resolvedBackend = await provider.resolveBackend({
            ...(backendId ? { backendId } : {}),
            ...(sessionKey ? { sessionKey } : {}),
          });
          res.json({
            available: true,
            model: { source: 'acp-oneoff', backendId: resolvedBackend },
            authenticatedProviders: await listAuthenticatedProviders(),
          });
          return;
        } catch {
          res.json({ available: false, model: null, authenticatedProviders: await listAuthenticatedProviders() });
          return;
        }
      }
      const resolved = await describeSmallModel({
        directory: typeof req.query.directory === 'string' ? req.query.directory : undefined,
        preferredProviderID: typeof req.query.providerID === 'string' ? req.query.providerID : undefined,
        preferredModelID: typeof req.query.modelID === 'string' ? req.query.modelID : undefined,
      });
      res.json({
        available: Boolean(resolved),
        model: resolved,
        authenticatedProviders: await listAuthenticatedProviders(),
      });
    } catch (error) {
      console.error('Failed to resolve small model:', error);
      res.status(500).json({ error: error.message || 'Failed to resolve small model' });
    }
  });

  app.post('/api/small-model/generate', async (req, res) => {
    try {
      const { generateSmallModelText } = await getSmallModelService();
      const { prompt, system, maxOutputTokens, model, directory, preferredProviderID, preferredModelID, sessionKey, backendId } = req.body || {};
      const result = await generateSmallModelText({
        prompt,
        system,
        maxOutputTokens,
        model,
        directory,
        preferredProviderID,
        preferredModelID,
        ...(typeof sessionKey === 'string' && sessionKey ? { sessionKey } : {}),
        ...(typeof backendId === 'string' && backendId ? { backendId } : {}),
      });
      res.json(result);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Small model generation failed:', error);
      }
      // ACP one-off failures carry the agent's own error text: surface it
      // with the backend/agent codes so the UI toast can name the agent's
      // error and point at the helper model setting. Every other failure
      // keeps the historical small-model message.
      const isOneOffFailure = error?.code === 'ACP_ONEOFF_FAILED' || error?.code === 'ACP_ONEOFF_TIMEOUT';
      res.status(statusCode).json({
        error: statusCode === 404 || error?.code === 'small-model-unavailable'
          ? (error.message || 'No small model is available')
          : isOneOffFailure
            ? (error.message || 'The ACP helper could not complete this action.')
            : 'The selected Small Model could not complete this action. Choose another model in Settings → Sessions → Small Model and try again.',
        ...(error?.code ? { code: error.code } : {}),
        ...(isOneOffFailure && typeof error.backendId === 'string' && error.backendId ? { backendId: error.backendId } : {}),
        ...(isOneOffFailure && error.agentCode !== undefined ? { agentCode: error.agentCode } : {}),
      });
    }
  });
}
