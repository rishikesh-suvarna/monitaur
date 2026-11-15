/** Server settings form logic: name validation, the PATCH body and the delete summary. */
import type { ServerDetailResponse, ServerSummary, UpdateServerBody } from '../../api/types';
import { plural } from '../../lib/format';
import { MAX_SERVER_NAME_LENGTH } from '../../lib/names';

/** backend/api/servers.go serverNamePattern. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ServerDraft {
  name: string;
  tags: string[];
}

export function draftFrom(server: Pick<ServerSummary, 'name' | 'tags'>): ServerDraft {
  return { name: server.name, tags: [...server.tags] };
}

/** An error message for the display name, or null when the backend will accept it. */
export function validateServerName(raw: string): string | null {
  const name = raw.trim();
  if (name === '') return 'Give the server a name.';
  if (name.length > MAX_SERVER_NAME_LENGTH) return `Use at most ${MAX_SERVER_NAME_LENGTH} characters.`;
  if (!SERVER_NAME_PATTERN.test(name)) return 'Start with a letter or number; then letters, numbers, dots, dashes or underscores.';
  return null;
}

const sameTags = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/** Only the fields that changed, or null when nothing did. */
export function updateBody(server: Pick<ServerSummary, 'name' | 'tags'>, draft: ServerDraft): UpdateServerBody | null {
  const body: UpdateServerBody = {};
  const name = draft.name.trim();
  if (name !== server.name) body.name = name;
  if (!sameTags(server.tags, draft.tags)) body.tags = draft.tags;
  return Object.keys(body).length === 0 ? null : body;
}

/**
 * The delete dialog's consequences, from GET /servers/:id counts. Rules are
 * not deleted with the server; it is only taken out of their scopes.
 */
export function deleteSummary(counts: ServerDetailResponse['counts']): string {
  const removes = [
    counts.metrics_days > 0 ? `${plural(counts.metrics_days, 'day')} of metrics` : 'its metrics',
    plural(counts.incidents, 'incident'),
  ].join(' and ');
  const rules = counts.rules > 0 ? `, and takes it out of ${plural(counts.rules, 'alert rule')}` : '';
  return `This removes ${removes}${rules}. The agent token stops working immediately. It can’t be undone.`;
}
