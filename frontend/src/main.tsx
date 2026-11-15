import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { EnvError, getEnv } from './config/env';
import './styles/index.css';

/** Plain, dependency-free screen for a misconfigured build. */
function ConfigError({ error }: { error: EnvError }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6 text-ink">
      <div role="alert" className="flex max-w-[560px] flex-col gap-3 rounded-lg border border-crit bg-surface-1 p-6">
        <h1 className="m-0 text-h2 font-semibold">Monitaur is not configured</h1>
        <p className="m-0 text-[13px] text-ink-muted">
          The build is missing required environment variables. Set them in <code className="num">.env.development.local</code> for
          local work, or in the build environment for deploys, then rebuild.
        </p>
        <ul className="num m-0 flex flex-col gap-1 pl-5 text-[13px]">
          {error.missing.map((key) => (
            <li key={key}>{key} (missing)</li>
          ))}
          {error.invalid.map((key) => (
            <li key={key}>{key} (not a valid URL)</li>
          ))}
        </ul>
      </div>
    </main>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element in index.html');
const root = createRoot(rootElement);

async function boot(): Promise<void> {
  try {
    // Fail fast: validate before Firebase or the API client are even imported.
    getEnv();
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    console.error(error.message);
    root.render(<ConfigError error={error} />);
    return;
  }
  const { default: App } = await import('./App');
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
