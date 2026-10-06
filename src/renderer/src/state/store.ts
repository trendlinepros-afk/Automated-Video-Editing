/**
 * A tiny external store: components subscribe with a selector and only re-render when
 * the selected value changes. Selectors must return existing values (no new objects).
 */
import { useSyncExternalStore } from 'react'

export interface Store<T> {
  get(): T
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void
  subscribe(cb: () => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch
      state = { ...state, ...p }
      for (const l of [...listeners]) l()
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}

export function useStore<T extends object, U>(store: Store<T>, selector: (s: T) => U): U {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()))
}
