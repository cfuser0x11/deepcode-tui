import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { EffectFlock } from "@opencode/util/effect-flock"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { Context, Duration, Effect, FileSystem, Layer, Option, Ref, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { parse, type ParseError } from "jsonc-parser"
import fsSync from "node:fs"
import path from "node:path"
import { stripVTControlCharacters } from "node:util"
import { RetainedImage } from "./retained-image"
import { action, parseReleaseVersion, type Policy } from "./updater-action"
import { errorMessage } from "../util/error"

export const methods = ["curl", "npm", "pnpm", "bun", "yarn", "vp", "brew"] as const

export type Method = (typeof methods)[number]
export type RunResult = { readonly type: "available" | "installed"; readonly version: string }
export type CheckResult = RunResult | { readonly type: "unavailable"; readonly message: string }

export class UpgradeError extends Error {
  readonly title: string
  readonly detail: string
  readonly command?: string
  readonly retry: string

  constructor(
    input: {
      readonly title: string
      readonly detail: string
      readonly command?: string
      readonly retry: string
    },
    options?: ErrorOptions,
  ) {
    super(input.detail, options)
    this.name = "UpgradeError"
    this.title = input.title
    this.detail = input.detail
    this.command = input.command
    this.retry = input.retry
  }
}

const decodeVpPackages = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String }))),
)

export const GITHUB_RELEASES_LATEST_URL = "https://github.com/cfuser0x11/deepcode-tui/releases/latest"
export const GITHUB_API_LATEST_URL = "https://api.github.com/repos/cfuser0x11/deepcode-tui/releases/latest"

export async function fetchLatestReleaseTag(signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(10_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

  const response = await fetch(GITHUB_RELEASES_LATEST_URL, {
    method: "HEAD",
    redirect: "manual",
    headers: { "User-Agent": "deepcode-tui" },
    signal: combined,
  }).catch(() => undefined)

  if (response && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location")
    if (location) {
      const tag = location.split("/").pop()?.trim()
      if (tag) return tag.replace(/^v/, "")
    }
  }

  const apiResponse = await fetch(GITHUB_API_LATEST_URL, {
    headers: {
      "User-Agent": "deepcode-tui",
      Accept: "application/vnd.github.v3+json",
    },
    signal: combined,
  })

  if (!apiResponse.ok) throw new Error(`GitHub release check failed (${apiResponse.status})`)
  const data = (await apiResponse.json()) as { tag_name?: string }
  if (typeof data?.tag_name === "string" && data.tag_name.trim().length > 0) {
    return data.tag_name.trim().replace(/^v/, "")
  }
  throw new Error("Could not find release tag from GitHub")
}

export function isNewer(current: string, latest: string): boolean {
  if (current === latest) return false
  const l = parseReleaseVersion(latest)
  if (!l) return false
  if (current === "local" || current.startsWith("0.0.0-")) return true
  const c = parseReleaseVersion(current)
  if (!c) return true
  const [cMaj, cMin, cPatch] = c.core.split(".").map(Number)
  const [lMaj, lMin, lPatch] = l.core.split(".").map(Number)
  if (lMaj !== cMaj) return lMaj > cMaj
  if (lMin !== cMin) return lMin > cMin
  if (lPatch !== cPatch) return lPatch > cPatch
  if (c.prerelease.length > 0 && l.prerelease.length === 0) return true
  return false
}

function isMusl(): boolean {
  if (process.platform !== "linux") return false
  try {
    if (fsSync.existsSync("/etc/alpine-release")) return true
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined
    if (report?.header && !report.header.glibcVersionRuntime) return true
  } catch {}
  return false
}

function getPlatformAssetName(): string | undefined {
  const platform = process.platform
  const arch = process.arch
  const muslSuffix = isMusl() ? "-musl" : ""

  if (platform === "win32") {
    if (arch === "x64") return "deepcode-windows-x64.exe"
    if (arch === "arm64") return "deepcode-windows-arm64.exe"
  } else if (platform === "darwin") {
    if (arch === "arm64") return "deepcode-darwin-arm64"
    if (arch === "x64") return "deepcode-darwin-x64"
  } else if (platform === "linux") {
    if (arch === "arm64") return `deepcode-linux-arm64${muslSuffix}`
    if (arch === "x64") return `deepcode-linux-x64${muslSuffix}`
  }
  return undefined
}


const installNames: Record<Method, string> = {
  curl: "The DeepCode installer",
  npm: "npm",
  pnpm: "pnpm",
  bun: "Bun",
  yarn: "Yarn",
  vp: "Vite+",
  brew: "Homebrew",
}

function conciseDetail(input: string) {
  const lines = stripVTControlCharacters(input)
    .trim()
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  const tail = lines.slice(-12).join("\n")
  const clipped = tail.length > 2_000
  const detail = clipped ? `…${tail.slice(-1_999)}` : tail
  if (!detail) return
  if (lines.length <= 12 && !clipped) return detail
  return `${detail}\n\nOutput shortened to the last 12 lines.`
}

function errorDetail(cause: unknown): string {
  if (cause instanceof AppProcess.AppProcessError) {
    const stderr = conciseDetail(cause.stderr ?? "")
    if (stderr) return stderr
    if (cause.cause !== undefined) return errorDetail(cause.cause)
    return cause.message
  }
  if (cause instanceof Error) {
    const detail = cause.cause === undefined ? undefined : errorDetail(cause.cause)
    if (!detail || detail === cause.message) return cause.message
    return `${cause.message}: ${detail}`
  }
  return errorMessage(cause)
}

function resultDetail(result: { code: number; stdout: string; stderr: string }) {
  return (
    conciseDetail(result.stderr) ??
    conciseDetail(result.stdout) ??
    `The command exited with code ${result.code} without any error output.`
  )
}

export interface Interface {
  readonly run: (onInstall?: (version: string) => void) => Effect.Effect<RunResult | undefined>
  readonly check: () => Effect.Effect<CheckResult | undefined, Error>
  readonly apply: (version: string) => Effect.Effect<void, Error>
  readonly method: () => Effect.Effect<Method | undefined>
  readonly latest: (method?: Method) => Effect.Effect<string, Error>
  readonly upgrade: (method: Method, version: string) => Effect.Effect<void, Error>
  readonly removal: (
    method: Method,
  ) => { readonly command: ReadonlyArray<string>; readonly run: Effect.Effect<void, Error> } | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Updater") {}

export function decodePolicy(text: string): Policy | undefined {
  // The CLI only projects this host-level preference instead of initializing
  // the location-scoped server configuration graph.
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof input !== "object" || input === null) return
  if ("update" in input) {
    const value = input.update
    if (value === "disable" || value === "notify" || value === "auto") return value
    return
  }
  if (!("autoupdate" in input)) return
  if (input.autoupdate === false) return "disable"
  if (input.autoupdate === "notify") return "notify"
  if (input.autoupdate === true) return "auto"
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const appProcess = yield* AppProcess.Service
  const flock = yield* EffectFlock.Service
  const installedVersion = yield* Ref.make(OPENCODE_VERSION)
  const channel = OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")
  const executable = yield* fs.realPath(process.execPath).pipe(Effect.orElseSucceed(() => process.execPath))
  const installedPackage = yield* Effect.gen(function* () {
    const directory = path.dirname(path.dirname(executable))
    const manifest: { name: string; bin?: Record<string, string> } = yield* fs
      .readFileString(path.join(directory, "package.json"))
      .pipe(Effect.flatMap((text) => Effect.try(() => JSON.parse(text))))
    // Source invocations run inside Bun or Node, which may themselves be npm packages.
    if (!/^@opencode(?:-ai)?\/cli(?:-node)?$/.test(manifest.name)) return
    if (Object.values(manifest.bin ?? {}).some((bin) => path.resolve(directory, bin) === executable))
      return manifest.name
  }).pipe(Effect.orElseSucceed(() => undefined))
  // "opencode" is Homebrew Core's formula; the others are published to anomalyco/tap.
  const installedFormula = ["opencode", "opencode-beta", "opencode-v2"].find((name) =>
    executable.includes(`${path.sep}Cellar${path.sep}${name}${path.sep}`),
  )

  const readPolicy = Effect.fnUntraced(function* () {
    const values = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
      fs.readFileString(path.join(global.config, name)).pipe(
        Effect.map(decodePolicy),
        Effect.orElseSucceed(() => undefined),
      ),
    )
    return values.findLast((value) => value !== undefined) ?? "notify"
  })

  const exec = Effect.fnUntraced(function* (command: string[], timeout: Duration.Input = "10 seconds") {
    return yield* appProcess
      .run(ChildProcess.make(command[0], command.slice(1)), {
        timeout,
        maxOutputBytes: 100_000,
        maxErrorBytes: 100_000,
      })
      .pipe(
        Effect.map((result) => ({
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        })),
      )
  })

  const curlBinary = path.resolve(
    global.home,
    ".opencode",
    "bin",
    process.platform === "win32" ? "opencode.exe" : "opencode",
  )

  // On Windows a bare `bash` may be the WSL launcher, which cannot run the installer against Windows paths.
  const installerBash = Effect.fnUntraced(function* () {
    if (process.platform !== "win32") return "bash"
    if (process.env.OPENCODE_GIT_BASH_PATH) return process.env.OPENCODE_GIT_BASH_PATH
    const git = yield* exec(["git", "--exec-path"]).pipe(Effect.orElseSucceed(() => undefined))
    const bash = git?.code === 0 ? path.resolve(git.stdout.trim(), "..", "..", "..", "bin", "bash.exe") : undefined
    if (bash && (yield* fs.exists(bash).pipe(Effect.orElseSucceed(() => false)))) return bash
    return yield* Effect.fail(
      new UpgradeError({
        title: "Git Bash is required to update DeepCode",
        detail: "The DeepCode installer runs with Git Bash on Windows, and it was not found.",
        retry: "Install Git for Windows or set OPENCODE_GIT_BASH_PATH, then run deepcode upgrade again.",
      }),
    )
  })

  const method = Effect.fnUntraced(function* () {
    if (path.resolve(process.execPath) === curlBinary) return "curl"
    if (installedFormula) return "brew"
    if (!installedPackage) return

    const checks: ReadonlyArray<{ method: Method; command: string[] }> = [
      { method: "npm", command: ["npm", "list", "-g", "--depth=0", installedPackage] },
      { method: "pnpm", command: ["pnpm", "list", "-g", "--depth=0", installedPackage] },
      { method: "bun", command: ["bun", "pm", "ls", "-g"] },
      { method: "yarn", command: ["yarn", "global", "list"] },
      { method: "vp", command: ["vp", "list", "-g", "--json", installedPackage] },
    ]
    const results = yield* Effect.forEach(
      checks,
      (check) =>
        exec(check.command).pipe(
          Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })),
          Effect.map((result) => ({ check, result })),
        ),
      { concurrency: "unbounded" },
    )
    return results.find((result) => {
      if (result.check.method !== "vp") return result.result.stdout.includes(installedPackage)
      // Vite+ repeats the filter in its successful no-match message, so substring detection would be a false positive.
      return Option.exists(decodeVpPackages(result.result.stdout), (packages) =>
        packages.some((item) => item.name === installedPackage),
      )
    })?.check.method
  })

  const removal = (method: Method) => {
    if (method === "curl" || method === "brew" || !installedPackage) return undefined
    const commands = {
      npm: ["npm", "uninstall", "--global", installedPackage],
      pnpm: ["pnpm", "remove", "--global", installedPackage],
      bun: ["bun", "remove", "--global", installedPackage],
      yarn: ["yarn", "global", "remove", installedPackage],
      vp: ["vp", "uninstall", "-g", installedPackage],
    }
    const command = commands[method]
    return {
      command,
      run: retaining(
        method,
        exec(command, "5 minutes").pipe(
          Effect.flatMap((result) => (result.code === 0 ? Effect.void : Effect.fail(new Error(resultDetail(result))))),
        ),
        global.tmp,
      ),
    }
  }

  const latest = (_selected?: Method) =>
    Effect.tryPromise({
      try: (signal) => fetchLatestReleaseTag(signal),
      catch: (cause) =>
        new UpgradeError(
          {
            title: "Could not check for DeepCode updates",
            detail: errorDetail(cause),
            retry: "Check your network or visit https://github.com/cfuser0x11/deepcode-tui/releases/latest",
          },
          { cause },
        ),
    })

  const release = Effect.fnUntraced(function* (_method?: Method) {
    const version = yield* latest()
    return { package: "deepcode", version }
  })

  const temporaryDirectory = (prefix: string) =>
    Effect.acquireRelease(fs.makeTempDirectory({ directory: global.cache, prefix }), (directory) =>
      fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
    )

  // On Windows the installer must delete or replace the running binary, which only works
  // while another link to it exists (see RetainedImage). Upgrades keep that link in the
  // cache; uninstall has already removed the cache, so it uses the temporary directory.
  const retaining = <A, E, R>(method: Method, effect: Effect.Effect<A, E, R>, directory = global.cache) => {
    if (process.platform !== "win32" || method === "brew") return effect
    // Only the installed binary is at stake; source checkouts run inside bun or node.
    const owned = method === "curl" ? path.resolve(process.execPath) === curlBinary : installedPackage !== undefined
    if (!owned) return effect
    return Effect.scoped(RetainedImage.retain(directory, "upgrade").pipe(Effect.andThen(effect))).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    )
  }

  const runUpgrade = (input: {
    readonly method: Method
    readonly command: string[]
    readonly displayCommand?: string[]
    readonly title?: string
    readonly retry?: string
  }) => {
    const failure = (detail: string, cause?: unknown) =>
      new UpgradeError(
        {
          title: input.title ?? `${installNames[input.method]} could not install DeepCode`,
          detail,
          command: (input.displayCommand ?? input.command).join(" "),
          retry: input.retry ?? "Fix the issue above, then run deepcode upgrade again.",
        },
        cause === undefined ? undefined : { cause },
      )
    return exec(input.command, "5 minutes").pipe(
      Effect.flatMap((result) =>
        result.code === 0 ? Effect.succeed(result) : Effect.fail(failure(resultDetail(result))),
      ),
      Effect.mapError((cause) =>
        cause instanceof UpgradeError
          ? cause
          : failure(
              cause instanceof AppProcess.AppProcessError && cause.stderr === undefined && cause.cause === undefined
                ? `Failed to update with ${input.method}`
                : errorDetail(cause),
              cause,
            ),
      ),
    )
  }

  const upgrade = Effect.fnUntraced(function* (method: Method, input: string) {
    if (!parseReleaseVersion(input)) return yield* Effect.fail(new Error(`Invalid version: ${input}`))
    const version = input.trim().replace(/^v/, "")
    const packageName =
      method === "brew" && installedFormula === "opencode" ? "opencode" : (yield* release(method)).package
    const target = `${packageName}@${version}`
    if (installedPackage && packageName !== installedPackage && (method === "pnpm" || method === "yarn")) {
      return yield* Effect.fail(new Error(`Reinstall ${target} with ${method} to migrate from ${installedPackage}.`))
    }
    const commands: Record<Exclude<Method, "bun" | "curl" | "brew">, string[]> = {
      // Keep the old package: uninstalling it can unlink the replacement command.
      npm: [
        "npm",
        "install",
        "--global",
        ...((OPENCODE_ARTIFACT === "cli" && !installedPackage?.endsWith("/cli-node")) ||
        (installedPackage && packageName !== installedPackage)
          ? ["--force"]
          : []),
        target,
      ],
      pnpm: ["pnpm", "add", "--global", `--allow-build=${packageName}`, target],
      yarn: ["yarn", "global", "add", target],
      vp:
        installedPackage && packageName !== installedPackage
          ? ["vp", "install", "-g", "--force", target]
          : ["vp", "update", "-g", target],
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Other OpenCode processes may be installing at the same time. Wait longer than the
        // slowest install (curl runs two 5-minute commands).
        yield* flock.acquire("cli-upgrade", undefined, { timeoutMs: Duration.toMillis("15 minutes") })
        if (method === "bun") {
          // Bun does not prune old versions from its shared package cache.
          yield* fs.makeDirectory(global.cache, { recursive: true })
          const cache = yield* temporaryDirectory("update-")
          return yield* retaining(
            method,
            runUpgrade({
              method,
              command: ["bun", "install", "--global", "--trust", "--cache-dir", cache, target],
              displayCommand: ["bun", "install", "--global", "--trust", target],
            }),
          )
        }
        if (method === "curl") {
          const bash = yield* installerBash()
          yield* fs.makeDirectory(global.cache, { recursive: true })
          const directory = yield* temporaryDirectory("update-")
          const installer = path.join(directory, "install")
          yield* runUpgrade({
            method,
            command: ["curl", "-fsSL", "-o", installer, "https://opencode.ai/v2/install"],
            displayCommand: ["curl", "-fsSL", "https://opencode.ai/v2/install"],
            title: "Could not download the DeepCode installer",
            retry: "Check your network, then run deepcode upgrade again.",
          })
          return yield* retaining(
            method,
            runUpgrade({
              method,
              command: [bash, installer, "--version", version, "--no-modify-path"],
              displayCommand: ["deepcode", "upgrade", version, "--method", "curl"],
              title: "The DeepCode installer failed",
            }),
          )
        }
        if (method === "brew") return yield* runUpgrade({ method, command: ["brew", "upgrade", packageName] })
        return yield* retaining(method, runUpgrade({ method, command: commands[method] }))
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof UpgradeError
          ? cause
          : new UpgradeError(
              {
                title: "Could not prepare the DeepCode upgrade",
                detail: errorDetail(cause),
                retry: "Fix the issue above, then run deepcode upgrade again.",
              },
              { cause },
            ),
      ),
      Effect.asVoid,
    )
  })

  const inspect = Effect.fnUntraced(function* () {
    if (["1", "true"].includes(process.env.OPENCODE_DISABLE_AUTOUPDATE?.toLowerCase() ?? "")) {
      return undefined
    }
    const policy = yield* readPolicy()
    if (policy === "disable") return undefined
    const latestVersion = yield* latest().pipe(Effect.orElseSucceed(() => undefined))
    if (!latestVersion) return undefined
    const current = yield* Ref.get(installedVersion)
    if (!isNewer(current, latestVersion)) return undefined
    const displayVersion = latestVersion.startsWith("v") ? latestVersion : `v${latestVersion}`
    yield* Effect.logInfo("DeepCode update available on GitHub", { current, latest: displayVersion })
    return { policy, version: displayVersion }
  })

  const install = Effect.fnUntraced(function* (inputVersion: string) {
    const version = inputVersion.trim().replace(/^v/, "")
    const detected = yield* method()
    if (detected) {
      yield* upgrade(detected, version)
      yield* Ref.set(installedVersion, version)
      yield* Effect.logInfo("updated DeepCode", { from: yield* Ref.get(installedVersion), to: version, method: detected })
      return true
    }
    const assetName = getPlatformAssetName()
    const runtime = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase()
    const isStandaloneBinary = runtime !== "bun" && runtime !== "node" && runtime !== "nodejs"
    if (assetName && isStandaloneBinary) {
      const url = `https://github.com/cfuser0x11/deepcode-tui/releases/download/v${version}/${assetName}`
      yield* fs.makeDirectory(global.cache, { recursive: true })
      const cacheDir = yield* temporaryDirectory("update-")
      const downloadPath = path.join(cacheDir, assetName)
      const res = yield* Effect.tryPromise({
        try: () => fetch(url, { headers: { "User-Agent": "deepcode-tui" } }),
        catch: (cause) => new Error(`Failed to download ${url}: ${errorMessage(cause)}`),
      })
      if (!res.ok) {
        return yield* Effect.fail(new Error(`Failed to download binary from GitHub (HTTP ${res.status})`))
      }
      const buffer = yield* Effect.tryPromise({
        try: () => res.arrayBuffer(),
        catch: (cause) => new Error(`Failed to read download stream: ${errorMessage(cause)}`),
      })
      yield* fs.writeFile(downloadPath, new Uint8Array(buffer))

      if (process.platform === "win32") {
        const oldExecutable = `${executable}.${Date.now()}.old`
        yield* fs.rename(executable, oldExecutable).pipe(Effect.ignore)
        yield* fs.copyFile(downloadPath, executable).pipe(
          Effect.catch(() => fs.rename(downloadPath, executable)),
        )
        const dir = path.dirname(executable)
        const base = path.basename(executable)
        const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): string[] => []))
        for (const entry of entries) {
          if (entry.startsWith(base) && entry.endsWith(".old") && entry !== path.basename(oldExecutable)) {
            yield* fs.remove(path.join(dir, entry)).pipe(Effect.ignore)
          }
        }
      } else {
        yield* exec(["chmod", "+x", downloadPath]).pipe(Effect.ignore)
        yield* fs.rename(downloadPath, executable).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              yield* fs.remove(executable).pipe(Effect.ignore)
              yield* fs.copyFile(downloadPath, executable)
              yield* exec(["chmod", "+x", executable]).pipe(Effect.ignore)
            }),
          ),
        )
      }

      yield* Ref.set(installedVersion, version)
      yield* Effect.logInfo("updated DeepCode standalone binary", { to: version })
      return true
    }
    return false
  })

  const apply = Effect.fn("cli.updater.apply")(function* (version: string) {
    if (!(yield* install(version)))
      return yield* Effect.fail(
        new Error(
          "Could not auto-install update. Download the latest release from https://github.com/cfuser0x11/deepcode-tui/releases/latest",
        ),
      )
  })

  const check = Effect.fn("cli.updater.check")(function* () {
    const latestVersion = yield* latest()
    const current = yield* Ref.get(installedVersion)
    const displayVersion = latestVersion.startsWith("v") ? latestVersion : `v${latestVersion}`
    if (isNewer(current, latestVersion)) {
      return { type: "available" as const, version: displayVersion }
    }
    if (current === "local" || current.startsWith("0.0.0-")) {
      return {
        type: "unavailable" as const,
        message: `Running local dev build (${current}). Latest release on GitHub is ${displayVersion}: https://github.com/cfuser0x11/deepcode-tui/releases/latest`,
      }
    }
    return undefined
  })

  const run = Effect.fn("cli.updater.run")(
    function* (onInstall: (version: string) => void = () => {}) {
      const result = yield* inspect()
      if (!result) return undefined
      if (result.policy === "notify") return { type: "available" as const, version: result.version }
      onInstall(result.version)
      if (!(yield* install(result.version))) return yield* Effect.fail(new Error("Installation method not found"))
      return { type: "installed" as const, version: result.version }
    },
    Effect.catch((error) => Effect.logWarning("update check failed", { error }).pipe(Effect.as(undefined))),
  )

  return Service.of({ run, check, apply, method, latest, upgrade, removal })
})

export const layer = Layer.effect(Service, make)

export * as Updater from "./updater"
export { action, type Action, type Policy } from "./updater-action"
