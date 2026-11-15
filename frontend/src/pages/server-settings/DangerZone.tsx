import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { errorMessage } from '../../api/errors';
import type { ServerDetailResponse, ServerSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/toastContext';

import { deleteSummary } from './serverForm';

const ADMIN_DELETE_REASON = 'Only admins can delete servers.';

export interface DangerZoneProps {
  server: ServerSummary;
  counts: ServerDetailResponse['counts'];
  canDelete: boolean;
  /** Runs DELETE /servers/:id; the page owns the mutation so it can stop refetching the server. */
  onDelete: () => Promise<void>;
  deleting: boolean;
}

/** ServerSettings.dc.html "Danger zone": delete with the type-to-confirm dialog, then back to the overview. */
export function DangerZone({ server, counts, canDelete, onDelete, deleting }: DangerZoneProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  const confirm = async (): Promise<void> => {
    setError(null);
    try {
      await onDelete();
      toast({ tone: 'success', title: `Deleted ${server.name}` });
      void navigate('/', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <section aria-labelledby="danger-heading" className="flex flex-col gap-3 rounded-lg border border-crit p-5">
      <h2 id="danger-heading" className="m-0 text-h3 font-semibold text-crit">
        Danger zone
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-[1_1_260px] flex-col gap-0.5">
          <span className="font-medium">Delete this server</span>
          <span className="text-[13px] text-ink-muted">
            Removes metrics and alert history and takes it out of rule scopes. The agent will be rejected on its next heartbeat.
          </span>
        </div>
        <Button
          variant="danger"
          disabled={!canDelete}
          title={canDelete ? undefined : ADMIN_DELETE_REASON}
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          Delete server…
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        onConfirm={confirm}
        title={`Delete ${server.name}?`}
        description={deleteSummary(counts)}
        confirmLabel="Delete server"
        confirmText={server.name}
        pending={deleting}
        error={error}
      />
    </section>
  );
}
