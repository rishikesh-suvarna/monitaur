import { describe, expect, it } from 'vitest';

import { deleteSummary, draftFrom, updateBody, validateServerName } from './serverForm';

describe('deleteSummary', () => {
  it('spells out what goes, from the counts', () => {
    expect(deleteSummary({ metrics_days: 30, incidents: 6, rules: 4 })).toBe(
      'This removes 30 days of metrics and 6 incidents, and takes it out of 4 alert rules. The agent token stops working immediately. It can’t be undone.',
    );
    expect(deleteSummary({ metrics_days: 0, incidents: 1, rules: 0 })).toBe(
      'This removes its metrics and 1 incident. The agent token stops working immediately. It can’t be undone.',
    );
  });
});

describe('validateServerName', () => {
  it.each(['db-primary-fra1', 'API_prod.02', 'a'])('accepts %s', (name) => {
    expect(validateServerName(name)).toBeNull();
  });

  it.each([
    ['', 'Give the server a name.'],
    ['   ', 'Give the server a name.'],
    ['-leading-dash', 'Start with a letter or number; then letters, numbers, dots, dashes or underscores.'],
    ['has space', 'Start with a letter or number; then letters, numbers, dots, dashes or underscores.'],
    ['x'.repeat(65), 'Use at most 64 characters.'],
  ])('rejects %j', (name, message) => {
    expect(validateServerName(name)).toBe(message);
  });
});

describe('updateBody', () => {
  const server = { name: 'db-primary', tags: ['prod', 'db'] };

  it('is null when nothing changed, including tag order and surrounding spaces', () => {
    expect(updateBody(server, { name: ' db-primary ', tags: ['db', 'prod'] })).toBeNull();
    expect(updateBody(server, draftFrom(server))).toBeNull();
  });

  it('sends only the changed fields', () => {
    expect(updateBody(server, { name: 'db-main', tags: ['prod', 'db'] })).toEqual({ name: 'db-main' });
    expect(updateBody(server, { name: 'db-primary', tags: ['prod'] })).toEqual({ tags: ['prod'] });
    expect(updateBody(server, { name: 'db-main', tags: [] })).toEqual({ name: 'db-main', tags: [] });
  });
});
