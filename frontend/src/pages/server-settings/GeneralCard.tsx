import { useState, type FormEvent } from 'react';

import { errorMessage, isApiError } from '../../api/errors';
import type { ServerSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Input } from '../../components/Input';
import { TagInput } from '../../components/TagInput';
import { useToast } from '../../components/toastContext';
import { useUpdateServer } from '../../hooks/api/servers';
import { VIEWER_EDIT_REASON } from '../server-detail/routes';

import { draftFrom, updateBody, validateServerName, type ServerDraft } from './serverForm';

/** ServerSettings.dc.html "General": display name and tags, with Reset and Save changes. */
export function GeneralCard({ server, canEdit }: { server: ServerSummary; canEdit: boolean }) {
  const update = useUpdateServer();
  const { toast } = useToast();
  const [draft, setDraft] = useState<ServerDraft>(() => draftFrom(server));
  const [touched, setTouched] = useState(false);
  const body = updateBody(server, draft);
  const localError = validateServerName(draft.name);
  const apiError = isApiError(update.error) && update.error.code === 'invalid' ? update.error.message : null;
  const nameError = touched ? (localError ?? apiError) : null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setTouched(true);
    if (!canEdit || body === null || localError !== null) return;
    update.mutate(
      { serverId: server.id, body },
      {
        onSuccess: ({ server: saved }) => {
          setDraft(draftFrom(saved));
          setTouched(false);
          toast({ tone: 'success', title: 'Server saved' });
        },
        onError: (caught) => {
          if (isApiError(caught) && caught.code === 'invalid') return;
          toast({ tone: 'error', title: 'Couldn’t save the server', description: errorMessage(caught) });
        },
      },
    );
  };

  return (
    <Card as="section" aria-labelledby="general-heading" className="p-5">
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <h2 id="general-heading" className="m-0 text-h3 font-semibold">
          General
        </h2>
        <Input
          label="Display name"
          size="lg"
          className="num"
          value={draft.name}
          disabled={!canEdit}
          title={canEdit ? undefined : VIEWER_EDIT_REASON}
          autoComplete="off"
          spellCheck={false}
          error={nameError ?? undefined}
          onChange={(event) => {
            setDraft((current) => ({ ...current, name: event.target.value }));
          }}
          onBlur={() => {
            setTouched(true);
          }}
        />
        <div title={canEdit ? undefined : VIEWER_EDIT_REASON}>
          <TagInput
            label="Tags"
            value={draft.tags}
            disabled={!canEdit}
            onChange={(tags) => {
              setDraft((current) => ({ ...current, tags }));
            }}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            disabled={!canEdit || body === null || update.isPending}
            title={canEdit ? undefined : VIEWER_EDIT_REASON}
            onClick={() => {
              setDraft(draftFrom(server));
              setTouched(false);
              update.reset();
            }}
          >
            Reset
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!canEdit || body === null}
            loading={update.isPending}
            title={canEdit ? undefined : VIEWER_EDIT_REASON}
          >
            Save changes
          </Button>
        </div>
      </form>
    </Card>
  );
}
