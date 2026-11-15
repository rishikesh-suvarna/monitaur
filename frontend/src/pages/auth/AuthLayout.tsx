import type { ReactNode } from 'react';

import { Logo } from '../../components/Logo';
import { useIsDesktop } from '../../hooks/useMediaQuery';

export const DOCS_URL = 'https://github.com/rishikesh-suvarna/monitaur#readme';

/** SignIn.dc.html frame: logo, a 400 px card, and a quiet footer, centred. */
export function AuthLayout({ children }: { children: ReactNode }) {
  const desktop = useIsDesktop();
  return (
    <div className="flex min-h-screen flex-col items-center gap-8 bg-bg px-5 pb-8 pt-12 text-[14px] text-ink">
      <div className="flex-1" />
      <Logo size={desktop ? 52 : 44} />
      <main className="flex w-full max-w-[400px] flex-col gap-5 rounded-xl border border-line bg-surface-1 p-7">{children}</main>
      <div className="flex-1" />
      <footer className="flex gap-4 text-[12px] text-ink-faint">
        <a href={DOCS_URL} target="_blank" rel="noreferrer" className="text-ink-faint hover:text-ink">
          Docs
        </a>
      </footer>
    </div>
  );
}

export function AuthHeading({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="m-0 text-h2 font-semibold">{title}</h1>
      {subtitle && <p className="m-0 text-[13px] text-ink-muted">{subtitle}</p>}
    </div>
  );
}

/** The crit-tinted alert used for sign-in errors. */
export function AuthAlert({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'success' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={
        tone === 'error'
          ? 'flex items-start gap-2 rounded bg-tint-crit px-3 py-2.5 text-[13px] text-crit'
          : 'flex items-start gap-2 rounded bg-tint-ok px-3 py-2.5 text-[13px] text-ok'
      }
    >
      {children}
    </div>
  );
}
