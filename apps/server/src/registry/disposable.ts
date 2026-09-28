// Disposables (PLUGINS.md 9 "Disposable"): every registration returns one, and a plugin's `DisposableStore` removes
// everything the plugin registered through `ctx` on disable / reload / uninstall.
import type { Disposable } from '@harness-forge/plugin-sdk'

/** A `Disposable` that runs `fn` on its first `dispose()` only. */
export function toDisposable(fn: () => void): Disposable {
  let disposed = false
  return {
    dispose: () => {
      if (disposed)
        return
      disposed = true
      fn()
    },
  }
}

/** Receives an error thrown by a tracked disposable (the store never rethrows). */
export type DisposeErrorHandler = (error: unknown) => void

/**
 * Tracks disposables and disposes them together in reverse registration order. Each item is disposed at most once; a
 * throwing item is reported to `onError` and never stops the others.
 */
export class DisposableStore implements Disposable {
  readonly #items = new Set<Disposable>()
  readonly #onError: DisposeErrorHandler
  #disposed = false

  constructor(onError: DisposeErrorHandler = () => {}) {
    this.#onError = onError
  }

  get isDisposed(): boolean {
    return this.#disposed
  }

  /** Number of live items. */
  get size(): number {
    return this.#items.size
  }

  /**
   * Tracks `item` and returns a handle: disposing the handle disposes the item and forgets it. Adding to a disposed
   * store disposes the item right away and throws.
   */
  add(item: Disposable): Disposable {
    if (this.#disposed) {
      this.#disposeItem(item)
      throw new Error('The store is already disposed.')
    }
    this.#items.add(item)
    return toDisposable(() => {
      if (this.#items.delete(item))
        this.#disposeItem(item)
    })
  }

  /** Disposes every tracked item (newest first). Idempotent. */
  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    const items = [...this.#items].reverse()
    this.#items.clear()
    for (const item of items)
      this.#disposeItem(item)
  }

  #disposeItem(item: Disposable): void {
    try {
      item.dispose()
    }
    catch (error) {
      this.#onError(error)
    }
  }
}
