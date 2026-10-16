export * as SessionStep from "./step.js"

import {
  AIError,
  InvalidProviderOutputError,
  LLMClient,
  LLMEvent,
  isContextOverflowFailure,
  type ProviderErrorEvent,
  type ToolCall,
} from "@opencode/ai"
import type { Agent } from "@opencode/schema/agent"
import { Cause, Clock, Data, Effect, Exit, Fiber, Option, Stream } from "effect"
import { SessionError } from "@opencode/schema/session-error"
import { Bus } from "../../bus.js"
import { Permission } from "../../permission.js"
import { Snapshot } from "../../snapshot.js"
import { Tool } from "../../tool.js"
import { ToolOutput } from "../../tool-output.js"
import { QuestionTool } from "../../tool/plugin/question.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"
import { SessionUsage } from "../usage.js"
import { SessionTokenizer } from "../tokenizer.js"
import { SessionRunnerModel } from "./model.js"
import { createLLMEventPublisher } from "./publish-llm-event.js"
import { SessionRunnerRetry } from "./retry.js"

export type Outcome = Data.TaggedEnum<{
  Completed: { readonly needsContinuation: boolean; readonly needsNudge?: boolean; readonly isEmptyResponse?: boolean }
  Retry: { readonly error: SessionError.Error; readonly decision: SessionRunnerRetry.Decision }
  Continue: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
  }
  RecoverFull: {}
  Compacted: {}
}>
export const Outcome = Data.taggedEnum<Outcome>()

interface Input {
  readonly isLocationClosed: () => boolean
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly prepared: Omit<SessionModelRequest.Prepared, "event">
  readonly retry: (
    cause: AIError,
    error: SessionError.Error,
    retry: boolean,
  ) => Effect.Effect<{ readonly retry: false } | SessionRunnerRetry.Decision>
  readonly recoverContinuation: boolean
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  readonly recoverOverflow: Effect.Effect<boolean>
  readonly hadExplorationTools?: boolean
  readonly consecutiveNudges?: number
}

const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const
const INPUT_INCOMPLETE = {
  type: "tool.input-incomplete",
  message:
    "Tool call arguments were not completed and were not executed. Re-issue the tool call with complete arguments.",
} as const

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const llm = yield* LLMClient.Service
  const snapshots = yield* Snapshot.Service
  const toolOutput = yield* ToolOutput.Service

  const attempt = Effect.fn("SessionStep.attempt")(function* (input: Input) {
    // The start snapshot only has to exist before local tools run, which cannot happen before Step.Started,
    // so it is captured while the provider request is in flight instead of delaying it.
    const pendingStartSnapshot = yield* snapshots.capture().pipe(Effect.forkScoped)
    const publisher = createLLMEventPublisher(bus, {
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      agent: input.agent,
      model: input.model.ref,
      providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
      pendingSnapshot: Fiber.join(pendingStartSnapshot),
      started: yield* Clock.currentTimeMillis,
    })
    const toolRuns: Array<{
      readonly call: ToolCall
      readonly fiber: Fiber.Fiber<void, Permission.DeclinedError | QuestionTool.CancelledError>
    }> = []
    const interruptTools = Effect.suspend(() => Fiber.interruptAll(toolRuns.map((run) => run.fiber)))
    const executeTool = (call: ToolCall) => {
      if (input.prepared.request.toolChoice?.type === "none")
        return new Tool.Error({ message: "Tools are disabled after the maximum agent steps" })
      return input.prepared.executeTool({
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.assistantMessageID,
        call,
        progress: (update) => publisher.progress(call.id, update),
      })
    }

    // Provider and tool fibers retain per-source order without a shared writer queue.
    // A local execution starts only after its Tool.Called publication completes.
    let overflowFailure: ProviderErrorEvent | undefined
    // Read to the end, not just the finish event, so the next request can reuse this response.
    const providerStream = llm.stream(input.prepared.request, input.prepared.options).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (overflowFailure || publisher.hasProviderError()) return
          // Wait here, where cancellation still works, rather than inside the uninterruptible publish.
          if (!publisher.hasStarted()) yield* Fiber.join(pendingStartSnapshot)
          if (
            LLMEvent.is.providerError(event) &&
            isContextOverflowFailure(event) &&
            !publisher.record().outputStarted
          ) {
            overflowFailure = event
            return
          }
          yield* publisher.publish(event)
          if (event.type !== "tool-call" || event.providerExecuted) return
          toolRuns.push({
            call: event,
            fiber: yield* Effect.uninterruptibleMask((restore) =>
              restore(executeTool(event)).pipe(
                Effect.flatMap(toolOutput.truncate),
                Effect.flatMap((outcome) => publisher.toolExecution(event.id, event.name, outcome)),
                Effect.catchTag("Tool.Error", (error) =>
                  publisher.failTool(event.id, toSessionError(error), error.metadata).pipe(Effect.asVoid),
                ),
              ),
            ).pipe(Effect.forkScoped),
          })
        }),
      ),
      Effect.ensuring(publisher.flush()),
    )

    // Keep the final tool and Step events uninterruptible, even when the work itself is cancelled.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const stream = yield* restore(providerStream).pipe(Effect.exit)
        const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
        const streamInterrupted = Exit.hasInterrupts(stream)
        // Cancelled before the start snapshot existed: record nothing, as when the capture preceded the request.
        if (streamInterrupted && !publisher.hasStarted() && !pendingStartSnapshot.pollUnsafe())
          return yield* Effect.failCause(stream.cause)
        if (!overflowFailure && publisher.hasStarted()) yield* publisher.streamed()
        if (streamInterrupted) yield* interruptTools
        const joined = yield* restore(Fiber.awaitAll(toolRuns.map((run) => run.fiber))).pipe(Effect.exit)
        if (Exit.isFailure(joined)) yield* interruptTools
        const tools = classifyToolExits(joined, toolRuns)

        const overflow = overflowFailure ?? streamFailure
        if (
          !publisher.record().outputStarted &&
          isContextOverflowFailure(overflow) &&
          (yield* restore(input.recoverOverflow))
        ) {
          yield* Effect.logWarning("provider rejected the request as too long; compacting", {
            sessionID: input.sessionID,
            model: input.model.ref,
            message: overflow?.message,
          })
          return Outcome.Compacted()
        }

        if (overflowFailure) yield* publisher.publish(overflowFailure)
        const recorded = publisher.record()
        const unknownFinish =
          Exit.isSuccess(stream) && recorded.finish?.finish === "unknown"
            ? new AIError({
                reason: new InvalidProviderOutputError({
                  message: "The provider response ended with an unknown finish reason.",
                  classification: "incomplete-stream",
                }),
              })
            : undefined
        const llmFailure = streamFailure instanceof AIError ? streamFailure : unknownFinish
        const llmError = llmFailure && !recorded.providerFailed ? toSessionError(llmFailure) : undefined
        if (
          input.recoverContinuation &&
          llmFailure?.reason._tag === "Transport" &&
          (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
          !recorded.outputStarted
        )
          return Outcome.RecoverFull()
        const retry =
          llmFailure && llmError && !isContextOverflowFailure(llmFailure)
            ? yield* restore(
                input.retry(
                  llmFailure,
                  llmError,
                  SessionRunnerRetry.isRetryable(llmFailure) ||
                    (recorded.outputStarted && isInterruptedStream(llmFailure)),
                ),
              )
            : undefined
        if (llmFailure && llmError && retry?.retry && !recorded.outputStarted) {
          // Retry state projects onto the existing assistant, even before it has produced output.
          yield* publisher.startAssistant()
          return Outcome.Retry({ error: llmError, decision: retry })
        }
        if (llmError) yield* publisher.failAssistant(llmError)

        for (const decline of tools.declines)
          yield* publisher.failTool(decline.call.id, {
            type: "aborted",
            message: input.isLocationClosed()
              ? "Interaction cancelled because the location shut down"
              : decline.reason._tag === "QuestionTool.CancelledError"
                ? decline.reason.message
                : "The user declined this tool call",
          })
        const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
        const toolFailure = interrupted
          ? TOOLS_INTERRUPTED
          : tools.failure !== undefined
            ? toSessionError(Cause.squash(tools.failure))
            : recorded.providerFailed
              ? TOOLS_INTERRUPTED
              : undefined
        if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
        if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)

        // Parsers may leave unfinished calls without an execution event.
        if (llmError || (Exit.isSuccess(stream) && !recorded.providerFailed)) {
          const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
          if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
          yield* publisher.failUnsettledTools(INPUT_INCOMPLETE, "uncalled")
        }

        const record = publisher.record()
        if (record.finish || record.failure) {
          const startSnapshot = yield* Fiber.join(pendingStartSnapshot)
          const snapshot = yield* snapshots.capture()
          const files =
            startSnapshot && snapshot
              ? startSnapshot === snapshot
                ? []
                : yield* snapshots
                    .files({ from: startSnapshot, to: snapshot })
                    .pipe(Effect.orElseSucceed(() => undefined))
              : undefined
          const rawTokens = record.finish?.tokens
          const hasProviderTokens =
            rawTokens && (rawTokens.input > 0 || rawTokens.output > 0 || rawTokens.reasoning > 0)
          const finishTokens = hasProviderTokens
            ? rawTokens
            : record.finish
              ? SessionTokenizer.estimateStepTokens({
                  request: input.prepared.request,
                  assistantText: record.assistantText,
                  reasoningText: record.reasoningText,
                  toolCalls: record.toolCalls,
                })
              : undefined
          const usage = finishTokens
            ? { cost: SessionUsage.calculateCost(input.model.cost, finishTokens), tokens: finishTokens }
            : undefined
          if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
          if (record.finish && usage && !record.failure)
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: input.sessionID,
              assistantMessageID: yield* publisher.startAssistant(),
              finish: record.finish.finish,
              rawFinish: record.finish.rawFinish,
              providerState: record.finish.providerState,
              ...usage,
              snapshot,
              files,
            })
        }

        if (
          llmFailure &&
          llmError &&
          retry?.retry &&
          record.outputStarted &&
          tools.declines.length === 0 &&
          !tools.interrupted
        )
          return Outcome.Continue({ error: llmError, decision: retry })

        if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
        if (tools.declines.length > 0) {
          if (input.isLocationClosed()) return Outcome.Completed({ needsContinuation: true })
          return yield* Effect.interrupt
        }
        if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
        if (tools.interrupted && Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
        if (record.failure) return yield* new StepFailedError({ error: record.failure })

        const hasTools = record.hasTools
        const hasEndWorking = record.hasEndWorking
        const cleanAssistantText = record.assistantText.replace(/<\/?(?:working|end_working)\b[^>]*>/gi, "").trim()
        const hasVisibleText = cleanAssistantText.length > 0
        const provider = String(input.model.ref.providerID ?? input.model.model.provider ?? "").toLowerCase()
        const isDeepSeek = provider.includes("deepseek")
        const isStuckResponse = !hasTools && !hasVisibleText && (isDeepSeek || hasEndWorking)
        const isWaiting = isAssistantWaitingForUser(cleanAssistantText)
        const isConcluding = isConcludingAssistantSummary(cleanAssistantText)
        const isShortMonologue = cleanAssistantText.length > 0 && cleanAssistantText.length < 500
        const hasActionPromise =
          /(?:^(?:я\s+)?(?:сейчас\s+)?(?:создам|отредактирую|изменю|запущу|прочитаю|посмотрю|изучу|напишу|добавлю|проверю)|сейчас\s+(?:я\s+)?(?:создам|отредактирую|изменю|запущу|прочитаю|посмотрю|изучу|напишу|добавлю|проверю)|следующий\s+шаг[:\s]+(?:я\s+)?(?:создам|отредактирую|изменю|запущу|прочитаю|посмотрю|изучу|напишу|добавлю|проверю)|приступаю\s+к|начинаю\s+(?:создавать|писать|править|читать)|перехожу\s+к|let me\s+(?:create|edit|run|read|check|write|modify|inspect|execute)|i will\s+(?:now\s+)?(?:create|edit|run|read|check|write|modify|inspect|execute)|i'll\s+(?:now\s+)?(?:create|edit|run|read|check|write|modify|inspect|execute)|i am going to\s+(?:create|edit|run|read|check|write|modify|inspect|execute)|start server|run implant)/i.test(
            cleanAssistantText,
          )
        const hasRawCodeBlock =
          /```(?:javascript|js|node|typescript|ts|python|py|bash|sh|powershell|ps1)?[\s\S]*?(?:await\s+import|require\(|fs\.|path\.|console\.log|process\.|subprocess\.|os\.)[\s\S]*?```/i.test(
            cleanAssistantText,
          )
        const isMonologueWithoutTools =
          !isConcluding &&
          !isWaiting &&
          ((isShortMonologue && hasActionPromise) || hasRawCodeBlock)
        const consecutiveNudges = input.consecutiveNudges ?? 0

        let needsContinuation = false
        let needsNudge = false

        if (input.prepared.request.toolChoice?.type !== "none") {
          if (hasTools) {
            needsContinuation = true
          } else if (!isWaiting) {
            if (isStuckResponse) {
              if (consecutiveNudges < 3) {
                needsContinuation = true
                needsNudge = true
              }
            } else if (isMonologueWithoutTools && !hasEndWorking && consecutiveNudges < 3) {
              needsContinuation = true
              needsNudge = true
            }
          }
        }

        return Outcome.Completed({
          needsContinuation,
          ...(needsNudge ? { needsNudge: true } : {}),
          ...(isStuckResponse ? { isEmptyResponse: true } : {}),
        })
      }),
    )
  }, Effect.scoped)

  return { attempt }
})

const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

export function isAssistantWaitingForUser(content: string): boolean {
  if (!content) return false
  const trimmed = content.trim()
  const prose = trimmed
    .replace(/<(?:tool_call|function_call|tool)\b[^>]*>[\s\S]*?(?:<\/(?:tool_call|function_call|call|tool)>|$)/gi, "")
    .replace(/<\s*\/?\s*(?:[|\uFF5C]\s*)*DSML[\s\S]*?(?:<\s*\/\s*(?:[|\uFF5C]\s*)*DSML[^>]*>|$)/gi, "")
    .replace(/<\s*\/?\s*(?:[|\uFF5C]\s*)*DSML[^>]*>/gi, "")
    .trim()
  if (!prose) return false

  const questionPatterns = [
    /ожидаю\s+от\s+вас/i,
    /жду\s+(?:вашего\s+)?(?:ответа|уточнения|решения|указания)/i,
    /пожалуйста[,\s]+(?:подскажите|уточните|сообщите|предоставьте|напишите|ответьте|выберите)/i,
    /нужно\s+(?:уточнение|пояснение|описание)/i,
    /что\s+за\s+проект/i,
    /какова\s+цель/i,
    /какие\s+требования/i,
    /отсутствует\s+описание/i,
    /невозможно\s+определить\s+(?:следующее|дальнейшее)/i,
    /what would you like/i,
    /please (?:choose|confirm|specify|tell me|provide|clarify)/i,
    /waiting for your (?:input|response|clarification|instructions)/i,
    /should i proceed/i,
    /how would you like/i,
    /do you want me to/i,
    /скажи(?:те)?[,\s]+что/i,
    /сообщи(?:те)?[,\s]+что/i,
    /напиши(?:те)?[,\s]+что/i,
    /чем\s+(?:я\s+)?могу\s+(?:вам\s+)?помочь/i,
    /готов(?:а)?\s+(?:помочь|приступить|к\s+работе)/i,
    /ready\s+to\s+(?:act|help|work|assist)/i,
    /how\s+can\s+i\s+help/i,
    /нет\s+(?:конкретной|активной|запланированной|поставленной)?\s*задач[иеу]/i,
    /задач[аи]\s+(?:не\s+поставлена|отсутствует|нет)/i,
    /за\s+этим\s+запросом\s+не\s+стоит\s+задач/i,
    /no\s+(?:actual|planned|active|concrete)?\s*task/i,
    /there\s+is\s+no\s+(?:planned|actual|concrete)?\s*task/i,
    /not?\s+(?:a\s+)?task\s+(?:to\s+execute|here)/i,
    /will\s+not\s+(?:fabricate|simulate)\s+tool/i,
    /не\s+(?:буду|эмулирую|собираюсь)\s+(?:вызывать|фабриковать|эмулировать)\s+инструмент/i,
    /хочешь\s+(?:дописать|продолжить|изменить|уточнить)/i,
    /хотите\s+(?:дописать|продолжить|изменить|уточнить)/i,
  ]

  const hasQuestionWord = questionPatterns.some((p) => p.test(prose))
  const questionWords =
    /(?:подскажите|уточните|как|что|где|какой|какая|какие|какую|почему|хотите|нужно|which|what|how|where)(?:$|[^а-яa-z0-9_])/i
  const endsWithQuestion = /\?\s*$/m.test(prose.slice(-150)) && questionWords.test(prose.slice(-300))

  return Boolean(hasQuestionWord || endsWithQuestion)
}

export function isConcludingAssistantSummary(content: string): boolean {
  if (!content) return false
  const prose = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<(?:tool_call|function_call|tool)\b[^>]*>[\s\S]*?(?:<\/(?:tool_call|function_call|call|tool)>|$)/gi, "")
    .replace(/<\s*\/?\s*(?:[|\uFF5C]\s*)*DSML[\s\S]*?(?:<\s*\/\s*(?:[|\uFF5C]\s*)*DSML[^>]*>|$)/gi, "")
    .replace(/<\s*\/?\s*(?:[|\uFF5C]\s*)*DSML[^>]*>/gi, "")
    .trim()
    .toLowerCase()

  if (prose.length < 30) return false

  const conclusionMarkers = [
    "все проверки завершены",
    "все задачи выполнены",
    "все изменения внесены",
    "все изменения успешно внесены",
    "все изменения успешно сохранены",
    "код готов к использованию",
    "готово к использованию",
    "готово к тестированию",
    "полностью готов к работе",
    "код полностью готов",
    "все работает корректно",
    "все работает исправно",
    "задача успешно выполнена",
    "исправление завершено",
    "все готово к запуску",
    "все тесты успешно пройдены",
    "тесты успешно пройдены",
    "all tasks completed",
    "all checks completed",
    "all tests passed",
    "ready to use",
    "ready for use",
    "ready for testing",
    "implementation complete",
    "everything is ready",
    "application is ready",
    "tests have passed",
  ]

  return conclusionMarkers.some((marker) => prose.includes(marker))
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
const classifyToolExits = (
  settled: Exit.Exit<Array<Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>>>,
  runs: ReadonlyArray<{ readonly call: ToolCall }>,
) => {
  const exits = Exit.isSuccess(settled) ? settled.value : []
  const declines = exits.flatMap((exit, index) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: runs[index].call, reason: reason.error }] : [],
        )
      : [],
  )
  const causes = Exit.isFailure(settled)
    ? [settled.cause]
    : exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: causes.some(Cause.hasInterrupts), declines, failure }
}
