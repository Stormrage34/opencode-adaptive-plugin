import { Context, Effect, Layer, Stream } from "effect"
import type { LLMEvent } from "@opencode-ai/llm"

export interface WorkerBridge {
  readonly stream: (input: {
    readonly providerNpm: string
    readonly modelId: string
    readonly apiKey?: string
    readonly baseURL?: string
    readonly headers?: Record<string, string>
    readonly limits?: { readonly context?: number; readonly output?: number } | undefined
    readonly system?: string[]
    readonly messages: readonly unknown[]
    readonly toolChoice?: "auto" | "required" | "none"
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly providerOptions?: Record<string, any>
    readonly abort: AbortSignal
   }) => Effect.Effect<Stream.Stream<LLMEvent, unknown, unknown>, never, never>
  readonly shutdown: () => Effect.Effect<void, never, never>
}

export const WorkerBridge = Context.Service<WorkerBridge>("WorkerBridge");

// Entry for a pending request
interface PendingEntry {
  queue: LLMEvent[]
  done: boolean
  error: Error | null
  waiters: (() => void)[]
}

export const layer = Layer.effect(
  WorkerBridge,
  Effect.gen(function* () {
    const workerUrl = new URL("./llm-worker.ts", import.meta.url)
    const worker = new Worker(workerUrl.toString(), { type: "module" })

    const pending = new Map<string, PendingEntry>()

    // Helper to wake up waiters
    const wakeWaiters = (entry: PendingEntry) => {
      while (entry.waiters.length > 0) {
        const waiter = entry.waiters.shift()!
        waiter()
      }
    }

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { readonly type: "event"; readonly id: string; readonly event: LLMEvent }
        | { readonly type: "done"; readonly id: number | string }
        | { readonly type: "error"; readonly id: number | string; readonly error: string }

      const entry = pending.get(String(msg.id))
      if (!entry) return

      if (msg.type === "event") {
        entry.queue.push(msg.event)
        wakeWaiters(entry)
      } else if (msg.type === "done") {
        entry.done = true
        pending.delete(String(msg.id))
        wakeWaiters(entry)
      } else if (msg.type === "error") {
        entry.error = new Error(msg.error)
        pending.delete(String(msg.id))
        wakeWaiters(entry)
      }
    }

    worker.onerror = (err) => {
      console.error("LLM worker error:", err)
      for (const [id, entry] of pending) {
        entry.error = err instanceof Error ? err : new Error(String(err))
        pending.delete(id)
        wakeWaiters(entry)
      }
    }

    const bridge: WorkerBridge = {
      stream: (input) =>
        Effect.gen(function* () {
          const id = Math.random().toString(36).substring(7)

          const entry: PendingEntry = {
            queue: [],
            done: false,
            error: null,
            waiters: [],
          }
          pending.set(id, entry)

          // Send request to worker
          worker.postMessage({
            type: "stream",
            id,
            request: {
              provider: {
                npm: input.providerNpm,
                modelId: input.modelId,
                apiKey: input.apiKey,
                baseURL: input.baseURL,
                headers: input.headers,
                limits: input.limits,
              },
              system: input.system,
              messages: input.messages,
              toolChoice: input.toolChoice,
              temperature: input.temperature,
              topP: input.topP,
              topK: input.topK,
              maxOutputTokens: input.maxOutputTokens,
              providerOptions: input.providerOptions,
              headers: input.headers,
            },
          })

          // Abort handling
          const onAbort = () => {
            worker.postMessage({ type: "abort", id })
          }
          input.abort.addEventListener('abort', onAbort)

          // BuildAsyncIterable
          const asyncIterable: AsyncIterable<LLMEvent> = {
            [Symbol.asyncIterator]: () => ({
              next: async (): Promise<IteratorResult<LLMEvent>> => {
                while (entry.queue.length === 0 && !entry.done && !entry.error) {
                  await new Promise<void>((resolve) => entry.waiters.push(resolve))
                }

                if (entry.error) {
                  return { done: true, value: undefined }
                }

                if (entry.queue.length > 0) {
                  return { done: false, value: entry.queue.shift()! }
                }

                if (entry.done) {
                  return { done: true, value: undefined }
                }

                return { done: true, value: undefined }
              },
            }),
          }

          const stream = Stream.fromAsyncIterable(asyncIterable, (cause) => cause as Error).pipe(
            Stream.takeWhile(() => !entry.done || entry.queue.length > 0),
            Stream.onError(() => Effect.void),
            Stream.ensuring(Effect.sync(() => input.abort.removeEventListener('abort', onAbort))),
          )

          return stream
        }),
      shutdown: () => Effect.sync(() => {
        worker.terminate()
      }),
    }

    // Cleanup on scope disposal
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      worker.terminate()
    }))

    return bridge
  }),
)

export const defaultLayer = Layer.provideMerge(layer)
