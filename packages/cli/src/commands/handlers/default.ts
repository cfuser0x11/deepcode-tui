import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
const tuiPromise = import("@opencode/tui")
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Config } from "../../config"
import { Context, Effect, FileSystem, Option, Queue, Schedule, Semaphore } from "effect"
import { ServerConnection } from "../../services/server-connection"
import { Updater } from "../../services/updater"
import { UpdatePreflight } from "../../services/update-preflight"
import { Npm } from "@opencode/util/npm"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_VERSION } from "../../version"
import { Env } from "../../env"
import { Service } from "@opencode/client/effect/service"
import { ServiceConfig } from "../../services/service-config"
import { OpenCode } from "@opencode/client/promise"
import { findSession } from "../../session-target"
import { errorMessage } from "../../util/error"
import { hasDeepSeekConfig, runDeepSeekSetup } from "../../setup"
import { startSpinner } from "../../util/spinner"

export type DefaultInput = {
  readonly standalone?: boolean
  readonly background?: boolean
  readonly server?: Option.Option<string>
  readonly auto?: boolean
  readonly yolo?: boolean
  readonly dangerouslySkipPermissions?: boolean
  readonly dead?: boolean
  readonly setup?: boolean
  readonly directory?: Option.Option<string>
  readonly continue?: boolean
  readonly session?: Option.Option<string>
  readonly prompt?: Option.Option<string>
}

export const runDefault = (input: DefaultInput) =>
  Effect.gen(function* () {
    if (input.dead) {
      process.env.DEEPCODE_DEAD_MODE = "1"
    }
    const setupSuccess = yield* Effect.promise(() => runDeepSeekSetup(Boolean(input.setup)))
    if (!setupSuccess && !hasDeepSeekConfig()) {
      return
    }
    const requestedDirectory = Option.getOrUndefined(input.directory)
    const requestedServer = Option.getOrUndefined(input.server)
    if (requestedDirectory !== undefined) process.chdir(requestedDirectory)
    const preflight = UpdatePreflight.make()
    yield* Effect.addFinalizer(() => Effect.promise(() => preflight.close()))
    const serviceStarts = yield* Queue.unbounded<{
      readonly reason: "missing" | "version-mismatch"
      readonly previousVersion?: string
    }>()
    yield* Queue.take(serviceStarts).pipe(
      Effect.flatMap((event) => Effect.logInfo("background service starting", event)),
      Effect.forever,
      Effect.forkScoped,
    )
    const config = yield* Config.Service
    const cliConfig = yield* config.get()
    const keepBackground = Boolean(input.background) || cliConfig.server?.background === true
    if (!keepBackground && requestedServer === undefined) {
      const serviceOptions = yield* ServiceConfig.options()
      yield* Service.stop(serviceOptions).pipe(Effect.ignore)
    }
    const isStandalone = input.standalone || !keepBackground || process.env.DEEPCODE_STANDALONE === "1"
    const spinner = isStandalone ? undefined : startSpinner("Connecting to background service...")
    const server = yield* ServerConnection.resolve({
      server: requestedServer,
      standalone: isStandalone,
      mismatch: "replace",
      onStart: (reason, previousVersion) => {
        Queue.offerUnsafe(serviceStarts, { reason, previousVersion })
        if (reason === "version-mismatch" && preflight.begin(previousVersion)) return
        spinner?.update(
          reason === "version-mismatch"
            ? "Updating background server..."
            : "Starting background server (compiling engine)...",
        )
      },
    }).pipe(
      Effect.tapError(() => {
        spinner?.stop("Failed to start background server")
        return Effect.promise(() => preflight.fail("DeepCode update could not start the new background service"))
      }),
    )
    if (spinner) {
      spinner.stop(`Connected to background service (${server.endpoint.url})`)
    }
    const session = Option.getOrUndefined(input.session)
    // A missing --session ID becomes the ID of the session the first prompt creates.
    const sessionExists =
      session !== undefined &&
      (yield* Effect.tryPromise({
        try: () =>
          findSession(OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) }), session),
        catch: (cause) => new Error(errorMessage(cause)),
      })) !== undefined
    const updater = yield* Updater.Service
    let installing: string | undefined
    let latest: Updater.RunResult | undefined
    const installListeners = new Set<(version: string) => void>()
    const resultListeners = new Set<(result: Updater.RunResult) => void>()
    // Background checks, `/update` lookups, and manual installs take turns so two installs never overlap.
    const checking = yield* Semaphore.make(1)
    yield* updater
      .run((version) => {
        installing = version
        installListeners.forEach((notify) => notify(version))
      })
      .pipe(
        Effect.ensuring(Effect.sync(() => (installing = undefined))),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (!result || (result.type === latest?.type && result.version === latest.version)) return
            latest = result
            resultListeners.forEach((notify) => notify(result))
          }),
        ),
        checking.withPermits(1),
        Effect.repeat(Schedule.spaced("10 minutes")),
        Effect.forkScoped({ startImmediately: true }),
      )
    preflight.loading()
    const npm = yield* Npm.Service
    const fileSystem = yield* FileSystem.FileSystem
    const runServicePromise = Effect.runPromiseWith(Context.make(FileSystem.FileSystem, fileSystem))
    const context = yield* Effect.context<FileSystem.FileSystem>()
    const runFork = Effect.runForkWith(context)
    const runPromise = Effect.runPromiseWith(context)
    const service = server.service
    if (service) {
      const serviceOptions = yield* ServiceConfig.options()
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const currentConfig = yield* config.get()
          if (!input.background && currentConfig.server?.background !== true) {
            yield* ServerConnection.shutdownPersistentPty(serviceOptions).pipe(Effect.ignore)
            yield* Service.stop(serviceOptions).pipe(Effect.ignore)
          }
        }),
      )
    }
    process.stderr.write("[*] Launching workspace...\n")
    const { run } = yield* Effect.promise(() => tuiPromise)
    yield* run({
      app: {
        name: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT,
        version: OPENCODE_VERSION,
        channel: process.env.OPENCODE_TUI_CHANNEL ?? OPENCODE_CHANNEL,
      },
      server: {
        endpoint: server.endpoint,
        service: service
          ? {
              reconnect: (signal) => runServicePromise(service.reconnect(), { signal }),
              restart: () => runServicePromise(service.restart()),
            }
          : undefined,
      },
      args: {
        continue: input.continue,
        sessionID: sessionExists ? session : undefined,
        newSessionID: sessionExists ? undefined : session,
        prompt: Option.getOrUndefined(input.prompt),
        auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
      },
      config: {
        path: config.path,
        get: () => runPromise(config.get()),
        update: (update) => runPromise(config.update(update)),
      },
      updater: {
        remote: requestedServer !== undefined,
        subscribe: (notify) => {
          if (latest) notify(latest)
          resultListeners.add(notify)
          return () => resultListeners.delete(notify)
        },
        check: (signal, notify) => {
          if (installing) notify(installing)
          installListeners.add(notify)
          return runPromise(checking.withPermits(1)(updater.check()), { signal }).finally(() =>
            installListeners.delete(notify),
          )
        },
        apply: (version) => runPromise(checking.withPermits(1)(updater.apply(version))),
      },
      packages: {
        prepare: (spec, install = true) => runPromise(install ? npm.add(spec) : npm.resolve(spec)),
      },
      environment: requestedServer === undefined ? Env.session() : undefined,
      terminalHandoff: () => preflight.finish(),
      log: (level, message, tags) => {
        const effect =
          level === "debug"
            ? Effect.logDebug(message, tags)
            : level === "warn"
              ? Effect.logWarning(message, tags)
              : level === "error"
                ? Effect.logError(message, tags)
                : Effect.logInfo(message, tags)
        runFork(effect)
      },
    }).pipe(Effect.provide(LayerNode.compile(Global.node)))
  })

export default Runtime.handler(Commands, runDefault)
