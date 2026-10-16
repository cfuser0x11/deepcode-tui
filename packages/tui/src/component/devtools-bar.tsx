import { CliRenderEvents, TextAttributes, type Renderable } from "@opentui/core"
import { TimeToFirstDraw, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { useClient } from "../context/client"
import { useConfig } from "../config"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useRoute } from "../context/route"
import { Keymap } from "../context/keymap"
import { useTheme, useThemes } from "../context/theme"
import { DevTools } from "../devtools"
import { useDialog } from "../ui/dialog"
import { DialogExperiments } from "./dialog-experiments"
import { DialogThemeList } from "./dialog-theme-list"
import { usePlugin } from "../plugin/context"
import { errorMessage } from "../util/error"
import { contextUsage, lastAssistantWithUsage } from "../util/session"

const graphWidth = 23
const sampleIntervalMilliseconds = 2_000
const sampleRetentionMilliseconds = 30_000
const statusWindowMilliseconds = 6_000
type Panel = "server" | "theme" | "tools" | "ui" | "tokens"
type ProcessSample = Readonly<{ cpu: number; memory: number; delay: number; time: number }>
export type RuntimeStatus = "normal" | "medium" | "high"

export function DevToolsBar() {
  const client = useClient()
  const config = useConfig()
  const dialog = useDialog()
  const data = useData()
  const location = useLocation()
  const route = useRoute()
  const plugins = usePlugin()
  const themes = useThemes()
  const keymap = Keymap.use()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { current: theme, mode, supports, setMode } = themes
  const elevatedTheme = useTheme()
  const [panel, setPanel] = createSignal<Panel>()
  const [dumping, setDumping] = createSignal(false)
  const [dumpPath, setDumpPath] = createSignal<string>()
  const [dumpError, setDumpError] = createSignal<string>()
  const [frontendSamples, setFrontendSamples] = createSignal<readonly ProcessSample[]>([])
  const [debugOverlay, setDebugOverlay] = createSignal(renderer.debugOverlay.enabled)
  let focus: Renderable | null
  const connected = createMemo(() => client.connection.status() === "connected")
  const serverIndicator = createMemo(() => connectionIndicator(client.connection.status(), client.connection.attempt()))
  const themePerformance = createMemo(
    () => DevTools.data().find((group) => group.id === "theme-performance")?.entries ?? [],
  )
  const groups = createMemo(() => DevTools.data().filter((group) => group.id !== "theme-performance"))
  const [server] = createResource(connected, async () => {
    const info = await client.api.server.info()
    return {
      health: info,
      address: info.urls[0] ? new URL(info.urls[0]).host : "Unknown",
    }
  })
  const close = () => {
    setPanel()
    setTimeout(() => {
      if (panel() || !focus || focus.isDestroyed) return
      focus.focus()
      focus = null
    }, 1)
  }
  const toggle = (next: Panel) => {
    if (panel() === next) return close()
    if (!panel()) {
      focus = renderer.currentFocusedRenderable
      focus?.blur()
    }
    setPanel(next)
  }
  const nextMode = () => (mode() === "dark" ? "light" : "dark")
  const canSwitchMode = () => supports(nextMode())
  const runtime = createMemo(() => runtimeStatus(frontendSamples()))

  const [localTiming, setLocalTiming] = createSignal(config.data.debug?.timing ?? false)
  const [localTurnTokens, setLocalTurnTokens] = createSignal<boolean | "verbose">(config.data.debug?.turn_tokens ?? false)
  const [localTps, setLocalTps] = createSignal(Boolean(config.data.session?.tps))

  createEffect(() => {
    setLocalTiming(config.data.debug?.timing ?? false)
  })
  createEffect(() => {
    setLocalTurnTokens(config.data.debug?.turn_tokens ?? false)
  })
  createEffect(() => {
    setLocalTps(Boolean(config.data.session?.tps))
  })

  const timing = () => localTiming()
  const turnTokens = () => localTurnTokens()
  const verboseTurnTokens = () => localTurnTokens() === "verbose"
  const tps = () => localTps()

  const toggleTiming = () => {
    const next = !localTiming()
    setLocalTiming(next)
    void config.update((draft) => {
      draft.debug = { ...draft.debug, timing: next }
    }).catch(() => {})
  }

  const toggleTurnTokens = () => {
    const next = !Boolean(localTurnTokens())
    setLocalTurnTokens(next)
    void config.update((draft) => {
      draft.debug = { ...draft.debug, turn_tokens: next }
    }).catch(() => {})
  }

  const toggleVerboseTurnTokens = () => {
    const next = localTurnTokens() === "verbose" ? true : "verbose"
    setLocalTurnTokens(next)
    void config.update((draft) => {
      draft.debug = { ...draft.debug, turn_tokens: next }
    }).catch(() => {})
  }

  const toggleTps = () => {
    const next = !localTps()
    setLocalTps(next)
    void config.update((draft) => {
      draft.session = { ...draft.session, tps: next }
    }).catch(() => {})
  }

  const toggleDebugOverlay = () => {
    renderer.toggleDebugOverlay()
    setDebugOverlay(renderer.debugOverlay.enabled)
  }

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const sessionMessages = createMemo(() => (sessionID() ? data.session.message.list(sessionID()!) : []))
  const sessionInfo = createMemo(() => (sessionID() ? data.session.get(sessionID()!) : undefined))
  const models = createMemo(() => data.location.model.list(sessionInfo()?.location))
  const lastAssistant = createMemo(() => lastAssistantWithUsage(sessionMessages(), sessionInfo()?.revert?.messageID))
  const usage = createMemo(() => contextUsage(sessionMessages(), models(), sessionInfo()?.revert?.messageID))

  const latestTokens = createMemo(() => {
    const last = lastAssistant()
    if (!last?.tokens) {
      return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, model: undefined }
    }
    const t = last.tokens
    const total =
      (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    return {
      input: t.input ?? 0,
      output: t.output ?? 0,
      reasoning: t.reasoning ?? 0,
      cacheRead: t.cache?.read ?? 0,
      cacheWrite: t.cache?.write ?? 0,
      total,
      model: last.model ? `${last.model.providerID}/${last.model.id}` : undefined,
    }
  })

  const sessionTotals = createMemo(() => {
    let input = 0
    let output = 0
    let reasoning = 0
    let cacheRead = 0
    let cacheWrite = 0
    for (const msg of sessionMessages()) {
      if (msg.type === "assistant" && msg.tokens) {
        input += msg.tokens.input ?? 0
        output += msg.tokens.output ?? 0
        reasoning += msg.tokens.reasoning ?? 0
        cacheRead += msg.tokens.cache?.read ?? 0
        cacheWrite += msg.tokens.cache?.write ?? 0
      }
    }
    return {
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      total: input + output + reasoning + cacheRead + cacheWrite,
    }
  })

  const contextLimit = createMemo(() => {
    const last = lastAssistant()
    if (last) {
      const m = models()?.find((model) => model.providerID === last.model.providerID && model.id === last.model.id)
      if (m?.limit.context) return m.limit.context
    }
    return 1_000_000
  })

  const contextPercent = createMemo(() => {
    if (usage()?.percent !== undefined) return usage()!.percent!
    const total = latestTokens().total
    if (total <= 0) return 0
    return Math.round((total / contextLimit()) * 100)
  })

  const userTokens = createMemo(() => {
    let total = 0
    for (const msg of sessionMessages()) {
      if (msg.type === "user") {
        if ("text" in msg && typeof (msg as any).text === "string") {
          total += Math.max(1, Math.ceil((msg as any).text.length / 3.5))
        } else if ("content" in msg && Array.isArray((msg as any).content)) {
          for (const c of (msg as any).content) {
            if (c.type === "text" && typeof c.text === "string") {
              total += Math.max(1, Math.ceil(c.text.length / 3.5))
            }
          }
        }
      }
    }
    return total
  })

  const basePromptTokens = 7_908

  const promptTokens = createMemo(() => {
    const input = latestTokens().input
    if (input <= 0) return 0
    return Math.min(basePromptTokens, input)
  })

  const toolsTokens = createMemo(() => {
    const input = latestTokens().input
    if (input <= 0) return 0
    return Math.max(0, input - (promptTokens() + userTokens()))
  })

  const lastCompact = createMemo(() => {
    for (let i = sessionMessages().length - 1; i >= 0; i--) {
      const msg = sessionMessages()[i]
      if (msg.type === "compaction" && msg.status === "completed") {
        const time = (msg as any).time?.completed ?? (msg as any).time?.created
        if (time) return new Date(time).toLocaleTimeString()
        return "completed"
      }
    }
    return "—"
  })

  const offEscape = keymap.intercept(
    "key",
    ({ event }) => {
      if (!panel() || keymap.mode.current() !== "base") return
      if (event.name !== "escape" && !(event.ctrl && event.name === "c")) return
      if (renderer.getSelection()?.getSelectedText()) {
        if ((config.data.terminal?.copy ?? (process.platform === "win32" ? "manual" : "select")) !== "select") return
        renderer.clearSelection()
        event.preventDefault()
        event.stopPropagation()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      close()
    },
    { priority: 10 },
  )
  onCleanup(offEscape)

  const onDebugOverlayToggle = (enabled: boolean) => setDebugOverlay(enabled)
  renderer.on(CliRenderEvents.DEBUG_OVERLAY_TOGGLE, onDebugOverlayToggle)
  onCleanup(() => renderer.off(CliRenderEvents.DEBUG_OVERLAY_TOGGLE, onDebugOverlayToggle))

  onMount(() => {
    const eventLoop = monitorEventLoopDelay({ resolution: 20 })
    let frontendCPU = process.cpuUsage()
    let frontendTime = performance.now()
    let frontendReady = false
    eventLoop.enable()
    const sample = () => {
      const now = performance.now()
      const cpu = process.cpuUsage(frontendCPU)
      frontendCPU = process.cpuUsage()
      setFrontendSamples((samples) =>
        [
          ...samples,
          {
            cpu: frontendReady ? cpuPercent(cpu.user + cpu.system, now - frontendTime) : 0,
            memory: process.memoryUsage().rss,
            delay: eventLoop.percentile(99) / 1_000_000,
            time: now,
          },
        ].filter((sample) => sample.time >= now - sampleRetentionMilliseconds),
      )
      eventLoop.reset()
      frontendReady = true
      frontendTime = now
    }
    sample()
    const timer = setInterval(sample, sampleIntervalMilliseconds)
    onCleanup(() => {
      clearInterval(timer)
      eventLoop.disable()
    })
  })

  async function dump() {
    setDumping(true)
    setDumpPath()
    setDumpError()
    const routeData = route.data
    const sessionID = routeData.type === "session" ? routeData.sessionID : undefined
    const info = sessionID ? data.session.get(sessionID) : undefined
    const sessionLocation =
      info?.location ??
      (location.current
        ? { directory: location.current.directory }
        : undefined)
    const details = server()
    const backend = {
      connected: connected(),
      version: details?.health.version,
      pid: details?.health.pid,
      error: client.connection.error(),
    }
    const events = await (sessionID
      ? (async () => {
          const events: { readonly created: number }[] = []
          for await (const event of client.api.session.log({ sessionID, follow: false })) {
            if (event.type !== "log.synced") events.push(event)
          }
          // Durable events stay in aggregate order even when their wall-clock timestamps differ.
          client.connection.internal.history().forEach((event) => {
            const index = events.findIndex((item) => item.created > event.created)
            if (index === -1) {
              events.push(event)
              return
            }
            events.splice(index, 0, event)
          })
          return events.slice(-100)
        })().catch(() => client.connection.internal.history())
      : Promise.resolve([]))
    const file = path.join(tmpdir(), `opencode-debug-${crypto.randomUUID()}.json`)
    const output =
      JSON.stringify(
        {
          backend,
          session: sessionID
            ? {
                ...info,
                id: sessionID,
                projectID: info?.projectID ?? location.current?.project.id,
                location: sessionLocation,
                status: data.session.status(sessionID),
                pending: data.session.pending.list(sessionID),
                inboxIDs: data.session.input.list(sessionID),
                permissions: data.session.permission.list(sessionID) ?? [],
                forms: data.session.form.list(sessionID) ?? [],
              }
            : undefined,
          events,
          mcp: {
            servers: sessionLocation
              ? (data.location.mcp.server.list(sessionLocation) ?? [])
              : (data.location.mcp.server.list() ?? []),
            resources: sessionLocation
              ? (data.location.mcp.resource.list(sessionLocation) ?? [])
              : (data.location.mcp.resource.list() ?? []),
          },
          plugins: {
            ready: plugins.ready(),
            list: plugins.list().map((plugin) => ({
              name: "id" in plugin ? plugin.id : plugin.target,
              ...plugin,
            })),
          },
          theme: {
            name: themes.selected,
            mode: themes.mode(),
          },
        },
        null,
        2,
      ) + "\n"
    await open(file, "wx", 0o600)
      .then((handle) => handle.writeFile(output).finally(() => handle.close()))
      .then(
        () => setDumpPath(file),
        (error) => setDumpError(errorMessage(error)),
      )
    setDumping(false)
  }

  return (
    <box height={1} flexShrink={0} flexDirection="row" backgroundColor={theme.decrease(theme.background.base)}>
      <Show when={panel()}>
        <box
          position="absolute"
          zIndex={2400}
          left={0}
          bottom={1}
          width={dimensions().width}
          height={Math.max(0, dimensions().height - 1)}
          backgroundColor="transparent"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            close()
          }}
        />
      </Show>
      <BarItem active={panel() === "server"} onClick={() => toggle("server")}>
        <text
          fg={
            panel() === "server"
              ? theme.text.action.primary.focused
              : serverIndicator().state === "connected"
                ? theme.text.feedback.success.base
                : serverIndicator().state === "disconnected"
                  ? theme.text.feedback.error.base
                  : theme.text.base
          }
        >
          {serverIndicator().icon}
        </text>
        <text
          fg={
            panel() === "server"
              ? theme.text.action.primary.focused
              : serverIndicator().state === "disconnected"
                ? theme.text.feedback.error.base
                : theme.text.muted
          }
        >
          {" "}
          Server
        </text>
        <Show when={panel() === "server"}>
          <PanelBox>
            <PanelTitle>Server</PanelTitle>
            <Row label="Status" value={connected() ? "Connected" : client.connection.status()} />
            <Show when={client.connection.attempt() > 0}>
              <Row label="Reconnect" value={String(client.connection.attempt())} />
            </Show>
            <Show when={client.connection.error()}>{(error) => <Row label="Last error" value={error()} />}</Show>
            <Show when={server()}>
              {(value) => (
                <>
                  <Row label="Version" value={value().health.version} />
                  <Row label="PID" value={String(value().health.pid)} />
                  <Row label="Address" value={value().address} />
                </>
              )}
            </Show>
            <Show when={server.error}>
              <text fg={elevatedTheme.text.feedback.error.base}>Server details unavailable</text>
            </Show>
          </PanelBox>
        </Show>
      </BarItem>
      <BarItem active={panel() === "ui"} onClick={() => toggle("ui")}>
        <text
          fg={
            panel() === "ui"
              ? theme.text.action.primary.focused
              : runtime() === "high"
                ? theme.text.feedback.error.base
                : theme.text.muted
          }
        >
          {statusIcon(runtime())}
        </text>
        <text
          fg={
            panel() === "ui"
              ? theme.text.action.primary.focused
              : runtime() === "high"
                ? theme.text.feedback.error.base
                : theme.text.muted
          }
        >
          {" "}
          UI
        </text>
        <Show when={panel() === "ui"}>
          <PanelBox>
            <PanelTitle>UI</PanelTitle>
            <Row label="Status" value={runtime()} />
            <ProcessStat
              label="Loop"
              values={frontendSamples().map((sample) => sample.delay)}
              unit=" ms"
              decimals={1}
            />
            <ProcessStat label="CPU" values={frontendSamples().map((sample) => sample.cpu)} unit="%" />
            <ProcessStat
              label="Memory"
              values={frontendSamples().map((sample) => sample.memory / 1024 / 1024)}
              unit=" MB"
              decimals={0}
            />
            <Show when={themePerformance().length > 0}>
              <box marginTop={1}>
                <text fg={elevatedTheme.text.base} attributes={TextAttributes.BOLD} selectable={false}>
                  Theme Render
                </text>
                <For each={themePerformance()}>{(entry) => <Row label={entry.key} value={String(entry.value)} />}</For>
              </box>
            </Show>
            <Action onClick={toggleDebugOverlay} hoverBackground>
              {debugOverlay() ? "[x]" : "[ ]"} Debug overlay
            </Action>
          </PanelBox>
        </Show>
      </BarItem>
      <BarItem active={panel() === "theme"} onClick={() => toggle("theme")}>
        <text fg={panel() === "theme" ? theme.text.action.primary.focused : theme.text.muted}>Theme</text>
        <Show when={panel() === "theme"}>
          <PanelBox>
            <PanelTitle>Theme</PanelTitle>
            <Row label="Current" value={themes.selected} />
            <Row label="Mode" value={mode()} />
            <box marginTop={1}>
              <Action
                onClick={() => {
                  close()
                  dialog.replace(() => <DialogThemeList />)
                }}
                hoverBackground
              >
                Select theme…
              </Action>
              <Action
                onClick={() => {
                  const all = Object.keys(themes.all()).sort((a, b) => a.localeCompare(b))
                  const idx = all.indexOf(themes.selected)
                  const next = all[(idx + 1) % all.length]
                  if (next) themes.set(next)
                }}
                hoverBackground
              >
                Next theme →
              </Action>
              <Show when={canSwitchMode()}>
                <Action onClick={() => setMode(nextMode())} hoverBackground>
                  Switch to {nextMode()}
                </Action>
              </Show>
            </box>
          </PanelBox>
        </Show>
      </BarItem>
      <BarItem active={panel() === "tools"} onClick={() => toggle("tools")}>
        <text fg={panel() === "tools" ? theme.text.action.primary.focused : theme.text.muted}>Tools</text>
        <Show when={panel() === "tools"}>
          <PanelBox>
            <PanelTitle>Tools</PanelTitle>
            <Action onClick={() => void dump()} disabled={dumping()} hoverBackground>
              {dumping() ? "Writing debug snapshot…" : "Write debug snapshot"}
            </Action>
            <Show when={dumpPath()}>
              {(file) => (
                <text fg={elevatedTheme.text.muted} wrapMode="word">
                  {file()}
                </text>
              )}
            </Show>
            <Show when={dumpError()}>
              {(error) => (
                <text fg={elevatedTheme.text.feedback.error.base} wrapMode="word">
                  {error()}
                </text>
              )}
            </Show>
            <box marginTop={1}>
              <text fg={elevatedTheme.text.base} attributes={TextAttributes.BOLD}>
                Render
              </text>
              <Action onClick={toggleTiming} hoverBackground>
                {timing() ? "[x]" : "[ ]"} Time to first draw
              </Action>
              <Action onClick={toggleTurnTokens} hoverBackground>
                {turnTokens() ? "[x]" : "[ ]"} Turn token usage
              </Action>
              <Show when={Boolean(turnTokens())}>
                <Action onClick={toggleVerboseTurnTokens} hoverBackground>
                  {verboseTurnTokens() ? "[x]" : "[ ]"} Turn token usage (verbose)
                </Action>
              </Show>
            </box>
            <For each={groups()}>
              {(group) => (
                <box marginTop={1}>
                  <text fg={elevatedTheme.text.base} attributes={TextAttributes.BOLD}>
                    {group.title}
                  </text>
                  <For each={group.entries}>{(entry) => <Row label={entry.key} value={String(entry.value)} />}</For>
                </box>
              )}
            </For>
          </PanelBox>
        </Show>
      </BarItem>
      <BarItem
        active={false}
        onClick={() => {
          close()
          dialog.replace(() => <DialogExperiments />)
        }}
      >
        <text fg={theme.text.muted}>Experiments</text>
      </BarItem>
      <box flexGrow={1} minWidth={0} zIndex={0}>
        <TimeToFirstDraw visible={timing()} width="100%" fg={theme.text.muted} label="Time to first draw" />
      </box>
      <BarItem active={panel() === "tokens"} onClick={() => toggle("tokens")}>
        <text
          fg={
            panel() === "tokens"
              ? theme.text.action.primary.focused
              : latestTokens().total > 0
                ? theme.text.base
                : theme.text.muted
          }
        >
          {latestTokens().total > 0
            ? `${formatTokens(latestTokens().total)}${contextPercent() > 0 ? ` (${contextPercent()}%)` : ""}`
            : "--"}
        </text>
        <Show when={panel() === "tokens"}>
          <PanelBox align="right" width={46}>
            <PanelTitle>Tokens & Context</PanelTitle>
            <Show
              when={latestTokens().total > 0 || sessionTotals().total > 0}
              fallback={
                <box>
                  <text fg={elevatedTheme.text.muted}>No tokens used in current session yet.</text>
                  <text fg={elevatedTheme.text.muted} marginTop={1}>
                    Send a prompt to see live stats.
                  </text>
                </box>
              }
            >
              <Row
                label="Context"
                value={`${latestTokens().total.toLocaleString()} / ${contextLimit().toLocaleString()}`}
              />
              <Row label="Usage" value={progressBar(contextPercent())} />
              <Show when={latestTokens().model}>
                {(model) => <Row label="Model" value={model()} />}
              </Show>

              <box marginTop={1}>
                <Row label="User" value={userTokens().toLocaleString()} />
                <Row label="LLM" value={latestTokens().output.toLocaleString()} />
                <Row label="Prompt" value={promptTokens().toLocaleString()} />
                <Row label="Tools" value={toolsTokens().toLocaleString()} />
                <Show when={latestTokens().reasoning > 0}>
                  <Row label="Reasoning (R1)" value={latestTokens().reasoning.toLocaleString()} />
                </Show>
                <Row label="Tokens Spent" value={sessionTotals().total.toLocaleString()} />
                <Row label="Last Compact" value={lastCompact()} />
              </box>
            </Show>

            <box marginTop={1}>
              <text fg={elevatedTheme.text.base} attributes={TextAttributes.BOLD}>
                Display
              </text>
              <Action onClick={toggleTurnTokens} hoverBackground>
                {turnTokens() ? "[x]" : "[ ]"} Show turn tokens in chat
              </Action>
              <Action onClick={toggleTps} hoverBackground>
                {tps() ? "[x]" : "[ ]"} Show tokens/sec (TPS)
              </Action>
            </box>
          </PanelBox>
        </Show>
      </BarItem>
    </box>
  )
}

function BarItem(props: ParentProps<{ active: boolean; onClick: () => void }>) {
  const theme = useTheme()
  const renderer = useRenderer()
  const [hovered, setHovered] = createSignal(false)
  return (
    <box
      position="relative"
      zIndex={props.active ? 2500 : 0}
      height={1}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={
        props.active
          ? theme.background.action.primary.focused
          : hovered()
            ? theme.background.action.primary.hovered
            : undefined
      }
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        renderer.clearSelection?.()
        event.stopPropagation()
      }}
      onMouseUp={(event) => {
        renderer.clearSelection?.()
        event.preventDefault()
        event.stopPropagation()
        props.onClick()
      }}
    >
      <box flexDirection="row">{props.children}</box>
    </box>
  )
}

function PanelBox(props: ParentProps<{ align?: "left" | "right"; width?: number }>) {
  const theme = useTheme()
  const renderer = useRenderer()
  return (
    <box
      position="absolute"
      zIndex={2600}
      bottom={1}
      left={props.align === "right" ? undefined : -1}
      right={props.align === "right" ? 0 : undefined}
      width={props.width ?? 42}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.background.raised.base}
      flexDirection="column"
      onMouseDown={(event) => {
        renderer.clearSelection?.()
        event.stopPropagation()
      }}
      onMouseUp={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {props.children}
    </box>
  )
}

function PanelTitle(props: ParentProps) {
  const theme = useTheme()
  return (
    <text fg={theme.text.base} attributes={TextAttributes.BOLD} marginBottom={1} selectable={false}>
      {props.children}
    </text>
  )
}

function Row(props: { label: string; value: string }) {
  const theme = useTheme()
  return (
    <box flexDirection="row">
      <text fg={theme.text.muted} selectable={false}>{props.label}</text>
      <box flexGrow={1} />
      <text fg={theme.text.base} selectable={false}>{props.value}</text>
    </box>
  )
}

function Action(props: ParentProps<{ onClick: () => void; disabled?: boolean; hoverBackground?: boolean }>) {
  const theme = useTheme()
  const renderer = useRenderer()
  const [hovered, setHovered] = createSignal(false)
  const trigger = (event?: any) => {
    if (event) {
      event.preventDefault?.()
      event.stopPropagation?.()
    }
    renderer.clearSelection?.()
    if (!props.disabled) props.onClick()
  }
  return (
    <box
      backgroundColor={
        props.hoverBackground && hovered() && !props.disabled ? theme.background.raised.high : undefined
      }
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        renderer.clearSelection?.()
        event.stopPropagation?.()
      }}
      onMouseUp={trigger}
    >
      <text
        fg={props.disabled ? theme.text.muted : theme.text.action.primary.base}
        selectable={false}
      >
        {props.children}
      </text>
    </box>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function progressBar(percent: number, width: number = 14) {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * width)
  const empty = width - filled
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${clamped}%`
}

function cpuPercent(microseconds: number, milliseconds: number) {
  if (milliseconds <= 0) return 0
  return Math.max(0, microseconds / (milliseconds * 10))
}

function ProcessStat(props: { label: string; values: readonly number[]; unit: string; decimals?: number }) {
  const theme = useTheme()
  const value = () => {
    const value = props.values.at(-1)
    if (value === undefined) return "--"
    return `${value.toFixed(props.decimals ?? 1)}${props.unit}`
  }
  return (
    <box flexDirection="row">
      <box width={7}>
        <text fg={theme.text.muted}>{props.label}</text>
      </box>
      <box flexGrow={1}>
        <text fg={props.values.length ? theme.text.base : theme.text.muted}>{brailleGraph(props.values)}</text>
      </box>
      <box width={8} alignItems="flex-end">
        <text fg={props.values.length ? theme.text.base : theme.text.muted}>{value()}</text>
      </box>
    </box>
  )
}

export function runtimeStatus(samples: readonly Readonly<{ delay: number; time: number }>[]): RuntimeStatus {
  const latest = samples.at(-1)?.time
  if (latest === undefined) return "normal"
  const delay = Math.max(
    0,
    ...samples.filter((sample) => sample.time > latest - statusWindowMilliseconds).map((sample) => sample.delay),
  )
  if (delay >= 100) return "high"
  if (delay >= 20) return "medium"
  return "normal"
}

export function statusIcon(status: RuntimeStatus) {
  if (status === "high") return "●"
  if (status === "medium") return "⦿"
  return "○"
}

export function connectionIndicator(status: "connected" | "connecting" | "reconnecting", attempt: number) {
  if (status === "connected") return { state: "connected" as const, icon: "✓" }
  if (status === "reconnecting" && attempt >= 3) return { state: "disconnected" as const, icon: "×" }
  return { state: "reconnecting" as const, icon: "↻" }
}

export function brailleGraph(values: readonly number[], width = graphWidth) {
  const min = Math.min(...values)
  const range = Math.max(...values) - min
  const points = [...Array<number | undefined>(width * 2 - values.length).fill(values.at(0)), ...values].slice(
    -width * 2,
  )
  const dots = [
    [6, 2, 1, 0],
    [7, 5, 4, 3],
  ]
  return Array.from({ length: width }, (_, index) => {
    const bits = [points[index * 2], points[index * 2 + 1]].reduce<number>((result, value, column) => {
      if (value === undefined) return result
      const height = 1 + Math.round((range === 0 ? 0 : (value - min) / range) * 3)
      return dots[column].slice(0, height).reduce<number>((bits, dot) => bits | (1 << dot), result)
    }, 0)
    return String.fromCodePoint(0x2800 + bits)
  }).join("")
}
