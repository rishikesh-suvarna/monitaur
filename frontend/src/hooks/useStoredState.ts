import { useCallback, useState } from 'react';

import { readStored, writeStored } from '../lib/storage';

/** useState persisted to localStorage under `key`, validated on read. */
export function useStoredState<T>(
  key: string,
  fallback: T,
  isValid: (value: unknown) => value is T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readStored(key, fallback, isValid));
  const update = useCallback(
    (next: T) => {
      setValue(next);
      writeStored(key, next);
    },
    [key],
  );
  return [value, update];
}
