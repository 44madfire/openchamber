import React from 'react';
import { selectAcpBackend, useAcpBackendsStore } from '@/stores/useAcpBackendsStore';
import { AcpDetail } from './AcpDetail';
import { AcpGrid } from './AcpGrid';

/**
 * Settings → Agents (ACP): grid of backend cards, or the detail editor for
 * the selected (or newly created) backend. Leaving the page drops the
 * selection so the next visit starts at the grid again.
 */
export const AcpPage: React.FC = () => {
  const selectedId = useAcpBackendsStore((state) => state.selectedId);
  const creating = useAcpBackendsStore((state) => state.creating);
  const selected = useAcpBackendsStore((state) => selectAcpBackend(state, selectedId));
  const select = useAcpBackendsStore((state) => state.select);

  React.useEffect(() => () => {
    useAcpBackendsStore.getState().select(null);
  }, []);
  // A grid-level "add" passes the fresh id through the selection.
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (creating) {
      const id = useAcpBackendsStore.getState().selectedId;
      if (id) setPendingId(id);
    } else {
      setPendingId(null);
    }
  }, [creating]);

  // A selected id that vanishes (removed elsewhere) drops back to the grid.
  React.useEffect(() => {
    if (selectedId && !selected && !creating) select(null);
  }, [selectedId, selected, creating, select]);

  if (creating) return <AcpDetail backendId={pendingId} creating />;
  if (selectedId && selected) return <AcpDetail backendId={selectedId} creating={false} />;
  return <AcpGrid />;
};
