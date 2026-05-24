import { Context, Deferred, Duration, Effect, Layer, Scope, SynchronizedRef } from "effect"

/**
 * Warehouse — Deferred-based shared state registry for cross-session coordination.
 *
 * Keys follow the convention `domain:id:action` (e.g. `session:<id>:idle`).
 * Use the `Keys` helpers to construct keys for common coordination patterns.
 *
 * Two publish modes:
 * - `publish(key, value)` — wakes current waiters, value is NOT stored for future callers.
 * - `settle(key, value)` — wakes current waiters AND stores the value so
 *   future `wait` or `get` calls resolve immediately.
 */

export const Keys = {
  /** Signal when a session transitions to idle. */
  sessionIdle: (sessionID: string): string => `session:${sessionID}:idle`,
  /** Signal when a background task result is available. */
  sessionBackgroundResult: (sessionID: string): string => `session:${sessionID}:bg-result`,
  /** Signal when compaction completes. */
  compactionComplete: (sessionID: string): string => `session:${sessionID}:compacted`,
  /** Signal a tool call result (cross-session). */
  toolResult: (callID: string): string => `tool:${callID}:result`,
  /** Global resource lock key (acquire / release pattern). */
  resourceLock: (name: string): string => `lock:${name}`,
  /** Runner completion result for a session. */
  sessionResult: (sessionID: string): string => `session:${sessionID}:result`,
}

export interface WaitOptions {
  readonly timeout?: Duration.Input
}

export interface Interface {
  /** Resolve all current waiters for `key` with `value`. The value is NOT stored. Returns waiter count. */
  readonly publish: (key: string, value: unknown) => Effect.Effect<number>
  /**
   * Wait for a value published/settled for `key`.
   * If the key is settled, returns immediately. Otherwise creates a Deferred and waits.
   * Never fails (timeout causes the effect to die instead).
   */
  readonly wait: <A>(key: string, options?: WaitOptions) => Effect.Effect<A>
  /** Resolve all current waiters AND store `value` for future calls. Returns waiter count. */
  readonly settle: (key: string, value: unknown) => Effect.Effect<number>
  /** Get the settled value for `key`, or `undefined`. */
  readonly get: (key: string) => Effect.Effect<unknown | undefined>
  /** Remove the entry for `key`, failing any pending deferreds. */
  readonly remove: (key: string) => Effect.Effect<void>
  /** Check if `key` is tracked (has waiters or a settled value). */
  readonly has: (key: string) => Effect.Effect<boolean>
  /** Number of current waiters for `key`. */
  readonly waiterCount: (key: string) => Effect.Effect<number>
  /** Remove all entries, failing all pending deferreds. */
  readonly clear: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Warehouse") {}

type Entry = {
  readonly deferreds: Array<Deferred.Deferred<unknown>>
  readonly settled?: unknown
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const ref = yield* SynchronizedRef.make(new Map<string, Entry>())

    const publish = Effect.fn("Warehouse.publish")(function* (key: string, value: unknown) {
      const result = yield* SynchronizedRef.modify(
        ref,
        (
          map,
        ): readonly [{ deferreds: Array<Deferred.Deferred<unknown>>; count: number }, Map<string, Entry>] => {
          const entry = map.get(key)
          if (!entry || entry.deferreds.length === 0) {
            return [{ deferreds: [], count: 0 }, map]
          }
          const deferreds = [...entry.deferreds]
          const next = new Map(map)
          next.set(key, { deferreds: [] })
          return [{ deferreds, count: deferreds.length }, next]
        },
      )
      for (const d of result.deferreds) {
        yield* Deferred.succeed(d, value).pipe(Effect.ignore)
      }
      return result.count
    })

    const settle = Effect.fn("Warehouse.settle")(function* (key: string, value: unknown) {
      const result = yield* SynchronizedRef.modify(
        ref,
        (
          map,
        ): readonly [{ deferreds: Array<Deferred.Deferred<unknown>>; count: number }, Map<string, Entry>] => {
          const entry = map.get(key)
          const deferreds = entry ? [...entry.deferreds] : []
          const next = new Map(map)
          next.set(key, { deferreds: [], settled: value })
          return [{ deferreds, count: deferreds.length }, next]
        },
      )
      for (const d of result.deferreds) {
        yield* Deferred.succeed(d, value).pipe(Effect.ignore)
      }
      return result.count
    })

    const wait: Interface["wait"] = ((key: string, options?: WaitOptions) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<unknown>()

        const state: { _tag: "immediate"; value: unknown } | { _tag: "pending" } = yield* SynchronizedRef.modify(
          ref,
          (map): readonly [{ _tag: "immediate"; value: unknown } | { _tag: "pending" }, Map<string, Entry>] => {
            const entry = map.get(key)
            if (entry?.settled !== undefined) {
              return [{ _tag: "immediate", value: entry.settled }, map]
            }
            const next = new Map(map)
            next.set(key, { deferreds: [...(entry?.deferreds ?? []), deferred] })
            return [{ _tag: "pending" }, next]
          },
        )

        if (state._tag === "immediate") return state.value

        if (!options?.timeout) {
          const value = yield* Deferred.await(deferred)
          return value
        }

        const opt = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(options.timeout))
        if (opt._tag === "Some") return opt.value

        // Timed out — remove our deferred from the list
        yield* SynchronizedRef.update(ref, (map) => {
          const entry = map.get(key)
          if (!entry) return map
          const filtered = entry.deferreds.filter((d) => d !== deferred)
          if (filtered.length === 0 && entry.settled === undefined) {
            const next = new Map(map)
            next.delete(key)
            return next
          }
          const next = new Map(map)
          next.set(key, { ...entry, deferreds: filtered })
          return next
        })
        return yield* Effect.die(new Error(`Warehouse.wait timed out for key: ${key}`))
      })) as Interface["wait"]

    const get = Effect.fn("Warehouse.get")(function* (key: string) {
      const entry = yield* SynchronizedRef.get(ref).pipe(Effect.map((map) => map.get(key)))
      return entry?.settled
    })

    const has = Effect.fn("Warehouse.has")(function* (key: string) {
      const entry = yield* SynchronizedRef.get(ref).pipe(Effect.map((map) => map.get(key)))
      return entry !== undefined && (entry.settled !== undefined || entry.deferreds.length > 0)
    })

    const waiterCount = Effect.fn("Warehouse.waiterCount")(function* (key: string) {
      const entry = yield* SynchronizedRef.get(ref).pipe(Effect.map((map) => map.get(key)))
      return entry?.deferreds.length ?? 0
    })

    const remove = Effect.fn("Warehouse.remove")(function* (key: string) {
      const entry = yield* SynchronizedRef.modify(
        ref,
        (map): readonly [Entry | undefined, Map<string, Entry>] => {
          const entry = map.get(key)
          if (!entry) return [undefined, map]
          const next = new Map(map)
          next.delete(key)
          return [entry, next]
        },
      )
      if (entry) {
        // Use succeed instead of fail to avoid Deferred type constraints;
        // consumers treat any resolved value as "finished" and check
        // semantics through the returned value.
        for (const d of entry.deferreds) {
          yield* Deferred.succeed(d, undefined).pipe(Effect.ignore)
        }
      }
    })

    const clear = Effect.fn("Warehouse.clear")(function* () {
      const entries = yield* SynchronizedRef.modify(
        ref,
        (map): readonly [Array<[string, Entry]>, Map<string, Entry>] => {
          const all = Array.from(map.entries())
          return [all, new Map()]
        },
      )
      for (const [, entry] of entries) {
        for (const d of entry.deferreds) {
          yield* Deferred.succeed(d, undefined).pipe(Effect.ignore)
        }
      }
    })

    yield* Effect.addFinalizer(() => clear().pipe(Effect.ignore))

    return Service.of({ publish, wait, settle, get, remove, has, waiterCount, clear })
  }),
)

export const defaultLayer = layer

export * as Warehouse from "./warehouse"
