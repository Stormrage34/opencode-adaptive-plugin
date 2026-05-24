/**
 * Bun Worker dedicated to LLM streaming operations — network I/O and SSE
 * parsing run here instead of the main thread.
 *
 * Protocol:
 *   Main→Worker  { type: "stream", id: string, request: WorkerRequest }
 *   Main→Worker  { type: "abort",  id: string }
 *   Worker→Main  { type: "event", id: string, event: LLMEvent }
 *   Worker→Main  { type: "done",  id: string }
 *   Worker→Main  { type: "error", id: string, error: string }
 *
 * The main thread sends a structured-clone-safe WorkerRequest. The worker
 * reconstructs it into an @opencode-ai/llm LLMRequest using the same provider
 * facades (OpenAI, Anthropic, etc.) available in this package, then executes
 * via LLMClient.
 */

import { LLM, type LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

/** Structured-clone-safe input forwarded from the main thread. */
export interface WorkerRequest {
  readonly provider: {
    readonly npm: string
    readonly modelId: string
    readonly apiKey?: string
    readonly baseURL?: string
    readonly headers?: Record<string, string>
    readonly limits?: { readonly context?: number; readonly output?: number }
  }
  readonly system?: string
  readonly messages: readonly unknown[]
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, Record<string, unknown>>
  readonly headers?: Record<string, string>
}

type WorkerMessage =
  | { readonly type: "stream"; readonly id: string; readonly request: WorkerRequest }
  | { readonly type: "abort"; readonly id: string }

const activeAborts = new Map<string, AbortController>()

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data
  if (msg.type === "stream") {
    void handleStream(msg.id, msg.request)
  } else if (msg.type === "abort") {
    activeAborts.get(msg.id)?.abort()
  }
}

async function handleStream(id: string, req: WorkerRequest): Promise<void> {
  const abortController = new AbortController()
  activeAborts.set(id, abortController)

  try {
    // Build an @opencode-ai/llm Model from the serialised WorkerRequest and
    // construct the LLMRequest.  The messages array was pre-transformed on the
    // main thread so it contains plain JSON compatible with @opencode-ai/llm's
    // `Message` shape (role + content).
    const model = await buildModel(req)
    const llmRequest = LLM.request({
      model,
      system: req.system,
      messages: req.messages as ReadonlyArray<LLM.MessageInput>,
      toolChoice: req.toolChoice,
      generation: {
        temperature: req.temperature,
        topP: req.topP,
        topK: req.topK,
        maxTokens: req.maxOutputTokens,
      },
      providerOptions: req.providerOptions,
    })

    // Wrap globalThis.fetch to pass the per-request abort signal through.
    const customFetch: typeof globalThis.fetch = Object.assign(
      (url: string | URL | Request, init?: RequestInit) =>
        globalThis.fetch(url, { ...init, signal: abortController.signal }),
      globalThis.fetch,
    )

    const stream = LLMClient.stream(llmRequest).pipe(
      Stream.provideService(FetchHttpClient.Fetch, customFetch),
    )

    await Effect.runPromise(
      Stream.runForEach(stream, (event: LLMEvent) =>
        Effect.sync(() => {
          self.postMessage({ type: "event", id, event })
        }),
      ).pipe(
        Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))),
      ),
    )

    if (!abortController.signal.aborted) {
      self.postMessage({ type: "done", id })
    }
  } catch (error: unknown) {
    if (abortController.signal.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    self.postMessage({ type: "error", id, error: message })
  } finally {
    activeAborts.delete(id)
  }
}

/** Build an @opencode-ai/llm Model from the serialisable WorkerRequest. */
async function buildModel(req: WorkerRequest) {
  // Dynamic import returns the provider module; each exports `configure(opts)`
  // which returns an object with route-name methods like `.responses(id)`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pkg: { configure: (opts: Record<string, unknown>) => any } = await importProvider(req.provider.npm)
  const opts: Record<string, unknown> = {}
  if (req.provider.apiKey) opts.apiKey = req.provider.apiKey
  if (req.provider.baseURL) opts.baseURL = req.provider.baseURL
  if (req.provider.headers && Object.keys(req.provider.headers).length > 0) opts.headers = req.provider.headers
  if (req.provider.limits) opts.limits = req.provider.limits

  const instance = pkg.configure(opts)
  // Try common route-method names: responses, model, chat
  const method = typeof instance.responses === "function" ? "responses" : typeof instance.model === "function" ? "model" : "chat"
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
  return instance[method](req.provider.modelId)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importProvider(npm: string): Promise<any> {
  switch (npm) {
    case "@ai-sdk/openai":
      return import("@opencode-ai/llm/providers/openai")
    case "@ai-sdk/anthropic":
      return import("@opencode-ai/llm/providers/anthropic")
    case "@ai-sdk/google":
      return import("@opencode-ai/llm/providers/google")
    case "@ai-sdk/amazon-bedrock":
      return import("@opencode-ai/llm/providers/amazon-bedrock")
    case "@ai-sdk/azure":
      return import("@opencode-ai/llm/providers/azure")
    case "@ai-sdk/openai-compatible":
      return import("@opencode-ai/llm/providers/openai-compatible")
    case "@openrouter/ai-sdk-provider":
      return import("@opencode-ai/llm/providers/openrouter")
    default:
      throw new Error(`Unsupported provider package in LLM worker: ${npm}`)
  }
}
