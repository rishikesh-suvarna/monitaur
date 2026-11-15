import { Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle, Radio, RadioGroup } from '@headlessui/react';
import { UserPlusIcon } from '@heroicons/react/24/outline';
import { useState, type FormEvent } from 'react';

import { errorMessage, hasErrorCode } from '../../api/errors';
import type { CreateInviteResponse } from '../../api/types';
import { Button } from '../../components/Button';
import { CopyableCode } from '../../components/CopyableCode';
import { Input } from '../../components/Input';
import { labelClasses } from '../../components/inputClasses';
import { LimitReachedHint } from '../../components/LimitReachedHint';
import { useToast } from '../../components/toastContext';
import { useCreateInvite, useOrgDetails } from '../../hooks/api/org';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import { isEmail } from '../../lib/email';
import { INVITABLE_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type InvitableRole } from '../../lib/roles';
import { usageState } from '../../lib/usage';

export interface InviteDialogProps {
  orgName: string;
  onClose: () => void;
}

/**
 * POST /org/invites. When the server could not email the invite (no SMTP),
 * the dialog shows the one-time accept link to share by hand.
 */
export function InviteDialog({ orgName, onClose }: InviteDialogProps) {
  const desktop = useIsDesktop();
  const { toast } = useToast();
  const org = useOrgDetails();
  const create = useCreateInvite();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableRole>('member');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [sent, setSent] = useState<CreateInviteResponse | null>(null);

  const plan = org.data?.plan;
  const usage = org.data?.usage;
  const atLimit = plan !== undefined && usage !== undefined && usageState(usage.members, plan.max_members).atLimit;
  const limitReached = hasErrorCode(create.error, 'limit_reached');
  const apiError = create.error && !limitReached ? errorMessage(create.error) : null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const address = email.trim();
    if (!isEmail(address)) {
      setEmailError('Enter a single valid email address.');
      return;
    }
    create.mutate(
      { email: address, role },
      {
        onSuccess: (response) => {
          if (response.emailed) {
            toast({ title: `Invite sent to ${response.invite.email}`, description: `They join ${orgName} as ${ROLE_LABELS[role].toLowerCase()}.`, tone: 'success' });
            onClose();
          } else {
            setSent(response);
          }
        },
      },
    );
  };

  const finish = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onClose();
  };

  return (
    <Dialog open onClose={create.isPending ? () => undefined : onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-scrim" />
      <div className={cn('fixed inset-0 flex justify-center overflow-y-auto p-4', desktop ? 'items-center' : 'items-end')}>
        <DialogPanel
          as="form"
          noValidate
          onSubmit={sent ? finish : submit}
          className="flex w-full max-w-[480px] flex-col gap-4 rounded-xl border border-line-strong bg-surface-1 p-6 shadow-float"
        >
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-tint-accent text-accent">
              <UserPlusIcon className="h-5 w-5" strokeWidth={1.6} />
            </span>
            <div className="flex flex-col gap-1">
              <DialogTitle className="m-0 text-[16px] font-semibold leading-6">{sent ? 'Share the invite link' : `Invite to ${orgName}`}</DialogTitle>
              <Description className="m-0 text-[13px] text-ink-muted">
                {sent
                  ? `This server can’t send email, so send ${sent.invite.email} this link yourself. It works once and expires in 7 days.`
                  : 'We email them a link to join, or give you the link to share. Invites expire after 7 days.'}
              </Description>
            </div>
          </div>

          {sent ? (
            <CopyableCode code={sent.invite_url} copyLabel="Copy invite link" />
          ) : (
            <>
              <Input
                label="Email"
                size="lg"
                type="email"
                value={email}
                autoComplete="off"
                spellCheck={false}
                placeholder="teammate@yourteam.dev"
                error={emailError}
                // Headless UI Dialog's initial focus: the only text field.
                data-autofocus
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailError(undefined);
                  if (create.error) create.reset();
                }}
              />
              <RadioGroup value={role} onChange={setRole} aria-label="Role" className="flex flex-col gap-1.5">
                <span className={labelClasses}>Role</span>
                {INVITABLE_ROLES.map((option) => (
                  <Radio
                    key={option}
                    value={option}
                    className={cn(
                      'group flex cursor-pointer items-center gap-3 rounded-lg border border-line px-3 py-2.5',
                      'data-[checked]:border-accent data-[checked]:bg-tint-accent',
                      'focus:outline-none data-[focus]:outline data-[focus]:outline-2 data-[focus]:outline-offset-2 data-[focus]:outline-accent',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 flex-none rounded-full border border-line-strong bg-bg group-data-[checked]:border-[5px] group-data-[checked]:border-accent"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[13px] font-medium text-ink">{ROLE_LABELS[option]}</span>
                      <span className="text-[12px] leading-4 text-ink-faint">{ROLE_DESCRIPTIONS[option]}</span>
                    </span>
                  </Radio>
                ))}
              </RadioGroup>
              {(limitReached || atLimit) && (
                <LimitReachedHint
                  resource="members"
                  used={usage?.members}
                  limit={plan?.max_members}
                  planName={plan?.name}
                  action="Remove a member or revoke a pending invite first."
                />
              )}
              {apiError && (
                <div role="alert" className="rounded bg-tint-crit px-3 py-2.5 text-[13px] text-crit">
                  {apiError}
                </div>
              )}
            </>
          )}

          <div className="flex justify-end gap-2">
            {sent ? (
              <Button type="submit" variant="primary">
                Done
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" loading={create.isPending} disabled={atLimit}>
                  Send invite
                </Button>
              </>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
