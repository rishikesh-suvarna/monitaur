import { useSyncExternalStore } from 'react';

/**
 * A one-value store for the shared crosshair. Charts write the hovered row;
 * only the readout subscribes, so moving the pointer never re-renders the
 * charts themselves.
 */
export interface HoverStore<T> {
  get: () => T | null;
  set: (value: T | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createHoverStore<T>(): HoverStore<T> {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useHoverValue<T>(store: HoverStore<T>): T | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
