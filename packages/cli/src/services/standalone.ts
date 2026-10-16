import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Deferred, Effect, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { randomBytes } from "node:crypto"
import { selfCommand } from "../util/process"
import { ServerProcess } from "../server-process"
import { ServerInfo } from "@opencode/server/server-info"

const Ready = Schema.Struct({ url: Schema.String })
const decodeReady = Schema.decodeUnknownPromise(Schema.fromJsonString(Ready))

type Options = {
  readonly command?: ReadonlyArray<string>
}

const startupDirectory = process.cwd()

function command(password: string, options: Options) {
  const [executable, ...args] = options.command ?? [...selfCommand(), "serve"]
  if (!executable) throw new Error("Failed to resolve standalone server command")
  const host = process.env.DEEPCODE_HOSTNAME || process.env.OPENCODE_HOSTNAME
  const hostArgs = host ? ["--hostname", host] : []
  return ChildProcess.make(executable, [...args, ...hostArgs, "--stdio", "--port", "0"], {
    cwd: startupDirectory,
    // Explicit entry wins over anything inherited, so a user-exported
    // OPENCODE_PASSWORD cannot shadow the child's lease credential.
    env: { OPENCODE_PASSWORD: password, OPENCODE_PARENT_PID: String(process.pid) },
    extendEnv: true,
    // The server treats EOF on this pipe as the end of its ownership lease.
    // The OS closes it even when the TUI is killed before Effect finalizers run.
    stdin: "pipe",
    stderr: process.env.OPENCODE_PRINT_LOGS === "1" ? "inherit" : "ignore",
    killSignal: "SIGTERM",
    forceKillAfter: "3 seconds",
  })
}

const makeEndpoint = Effect.fn("cli.standalone.endpoint")(
  function* (options: Options) {
    const password = randomBytes(32).toString("base64url")
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const proc = yield* spawner.spawn(command(password, options))
    const readyLine = yield* Deferred.make<string, Error>()
    // Keep draining stdout after readiness so later server writes cannot hit EPIPE.
    yield* proc.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Deferred.succeed(readyLine, line)),
      Effect.ensuring(Deferred.fail(readyLine, new Error("Standalone server exited before reporting readiness"))),
      Effect.forkScoped,
    )
    const output = yield* Deferred.await(readyLine)
    const ready = yield* Effect.tryPromise(() => decodeReady(output))
    return {
      url: ready.url,
      auth: { type: "basic" as const, username: "opencode", password },
      pid: proc.pid,
      exited: proc.exitCode,
    }
  },
  Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
)

const makeInProcessEndpoint = Effect.fn("cli.standalone.in-process")(function* () {
  process.stderr.write("[*] Starting in-process server...\n")
  const ready = yield* Deferred.make<{ url: string; password: string }>()
  const hostname = process.env.DEEPCODE_HOSTNAME || process.env.OPENCODE_HOSTNAME
  yield* ServerProcess.run({
    mode: "in-process",
    port: 0,
    hostname,
    onReady: (endpoint) => Deferred.succeed(ready, endpoint),
  }).pipe(Effect.forkScoped)

  const endpoint = yield* Deferred.await(ready)
  process.stderr.write(`[+] Server ready (${endpoint.url})\n`)
  if (hostname === "0.0.0.0" || hostname === "::") {
    const lanUrls = ServerInfo.connectionURLs(endpoint.url, hostname)
    const remote = lanUrls.filter((u) => {
      try {
        const h = new URL(u).hostname
        return h !== "localhost" && h !== "127.0.0.1" && h !== "[::1]"
      } catch {
        return false
      }
    })
    if (remote.length > 0) {
      process.stderr.write(`[+] LAN URLs for remote connection:\n`)
      for (const u of remote) {
        process.stderr.write(`    ${u}\n`)
      }
      process.stderr.write(`[+] Server password: ${endpoint.password}\n`)
      const authHeader = `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}`
      const pairRes = yield* Effect.tryPromise(() =>
        fetch(`${endpoint.url}/api/server/pair`, {
          method: "POST",
          headers: { authorization: authHeader },
        }).then((r) => r.json() as Promise<{ code?: string }>),
      ).pipe(Effect.option)
      if (Option.isSome(pairRes) && pairRes.value?.code) {
        process.stderr.write(`[+] Direct Pair Link (auto-login):\n`)
        for (const u of remote) {
          process.stderr.write(`    ${u}/auth/connect/${pairRes.value.code}\n`)
        }
      }
    }
  }
  return {
    url: endpoint.url,
    auth: { type: "basic" as const, username: "opencode", password: endpoint.password },
    pid: process.pid,
  }
})

export function start(options: Options = {}) {
  if (options.command !== undefined) {
    return makeEndpoint(options)
  }
  return makeInProcessEndpoint()
}

export * as Standalone from "./standalone"
