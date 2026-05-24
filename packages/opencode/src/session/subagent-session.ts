import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Cause, Context, Effect, Layer, Schema, Scope } from "effect"
import { Runner } from "@/effect/runner"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"

export const Event = {
  Completed: BusEvent.define(
    "subagent.completed",
    Schema.Struct({
      sessionID: SessionID,
      parentSessionID: SessionID,
      description: Schema.String,
      text: Schema.String,
      state: Schema.Literals(["completed", "error"]),
    }),
  ),
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export interface Interface {
  readonly start: (input: {
    sessionID: SessionID
    parentSessionID: SessionID
    description: string
    run: Effect.Effect<string>
  }) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancelByParent: (parentSessionID: SessionID) => Effect.Effect<void>
  readonly list: () => Effect.Effect<SessionID[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentSession") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SubagentSession.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<string, Runner.Runner<string>>()
        // Track parent→children session ID relationships for cascading cancellation
        const parentChildren = new Map<string, Set<string>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (r) => r.cancel, { concurrency: 5, discard: true })
            runners.clear()
            parentChildren.clear()
          }),
        )
        return { runners, scope, parentChildren }
      }),
    )

    const start = Effect.fn("SubagentSession.start")(function* (input: {
      sessionID: SessionID
      parentSessionID: SessionID
      description: string
      run: Effect.Effect<string>
    }) {
      const data = yield* InstanceState.get(state)

      // Track parent→child relationship for cascading cancellation
      const children = data.parentChildren.get(input.parentSessionID) ?? new Set()
      children.add(input.sessionID)
      data.parentChildren.set(input.parentSessionID, children)

      const cleanup = () => {
        data.runners.delete(input.sessionID)
        const c = data.parentChildren.get(input.parentSessionID)
        if (c) {
          c.delete(input.sessionID)
          if (c.size === 0) data.parentChildren.delete(input.parentSessionID)
        }
      }

      const runner = Runner.make<string>(data.scope, {
        onIdle: Effect.sync(cleanup),
        onInterrupt: Effect.gen(function* () {
          cleanup()
          return ""
        }),
      })
      data.runners.set(input.sessionID, runner)

      // Compose the run effect with bus event publishing.
      // On success: publish completed event, return the text.
      // On error: publish error event, return empty string (error is communicated via bus).
      // On interrupt: re-interrupt (Runner handles cleanup via onInterrupt).
      const wrapped: Effect.Effect<string> = input.run.pipe(
        Effect.flatMap((text) =>
          bus
            .publish(Event.Completed, {
              sessionID: input.sessionID,
              parentSessionID: input.parentSessionID,
              description: input.description,
              text,
              state: "completed",
            })
            .pipe(Effect.as(text)),
        ),
        Effect.catchCause((cause: Cause.Cause<unknown>): Effect.Effect<string> => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
          return bus
            .publish(Event.Completed, {
              sessionID: input.sessionID,
              parentSessionID: input.parentSessionID,
              description: input.description,
              text: errorText(Cause.squash(cause)),
              state: "error",
            })
            .pipe(Effect.as(""))
        }),
      )

      yield* runner.ensureRunning(wrapped).pipe(
        Effect.forkIn(data.scope, { startImmediately: true }),
        Effect.asVoid,
      )
    })

    const cancel = Effect.fn("SubagentSession.cancel")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) return
      yield* existing.cancel
    })

    const cancelByParent = Effect.fn("SubagentSession.cancelByParent")(function* (parentSessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const children = data.parentChildren.get(parentSessionID)
      if (!children || children.size === 0) return
      yield* Effect.forEach(
        children,
        (childID) => cancel(childID as SessionID),
        { concurrency: 5, discard: true },
      )
    })

    const list = Effect.fn("SubagentSession.list")(function* () {
      const data = yield* InstanceState.get(state)
      return Array.from(data.runners.keys()) as SessionID[]
    })

    return Service.of({ start, cancel, cancelByParent, list })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as SubagentSession from "./subagent-session"
