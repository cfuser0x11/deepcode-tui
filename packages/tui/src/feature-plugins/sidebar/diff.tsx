import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { MouseButton, TextAttributes } from "@opentui/core"
import { truncateFilePath } from "../../ui/file-path"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type DiffFile = {
  readonly file: string
  readonly patch?: string
  readonly additions: number
  readonly deletions: number
  readonly status: "added" | "deleted" | "modified"
}

export function resolveDirectory(dir: string): string {
  if (!dir) return ""
  if (dir.startsWith("~/") || dir.startsWith("~\\")) {
    return path.join(os.homedir(), dir.slice(2))
  }
  if (dir === "~") return os.homedir()
  return path.resolve(dir)
}

export function isExcludedDirectory(directory: string): boolean {
  if (!directory) return true
  const resolved = resolveDirectory(directory)
  const normalized = resolved.toLowerCase()
  const home = os.homedir().toLowerCase()
  if (normalized === home) return true

  const root = path.parse(normalized).root.toLowerCase()
  if (normalized === root) return true

  const excludedSubdirs = ["desktop", "downloads", "temp", "tmp", "documents"]
  for (const name of excludedSubdirs) {
    if (normalized === path.join(home, name).toLowerCase()) return true
  }

  const tempDir = os.tmpdir().toLowerCase()
  if (normalized === tempDir) return true

  return false
}

export function SidebarDiff(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const location = createMemo(
    () => session()?.location ?? props.context.location ?? props.context.data.location.default(),
    undefined,
    { equals: (a, b) => a?.directory === b?.directory },
  )

  const hasVcs = createMemo(() => {
    const loc = location()
    if (!loc) return false
    const vcsInfo = props.context.data.location.vcs?.info(loc)
    if (vcsInfo?.branch?.current) return true
    try {
      const dir = resolveDirectory(loc.directory)
      if (fs.existsSync(path.join(dir, ".git"))) return true
    } catch {
      return false
    }
    return false
  })

  const isExcluded = createMemo(() => {
    const loc = location()
    if (!loc) return true
    return isExcludedDirectory(loc.directory)
  })

  const canInitGit = createMemo(() => {
    return !hasVcs() && !isExcluded()
  })

  const [initializing, setInitializing] = createSignal(false)
  const [initHovered, setInitHovered] = createSignal(false)

  const handleInitGit = async () => {
    if (initializing()) return
    const loc = location()
    if (!loc) return
    const confirmed = props.context.ui.dialog
      ? await props.context.ui.dialog.confirm({
          title: "Initialize Git",
          message: `Initialize Git repository in ${loc.directory}?`,
          label: { confirm: "Initialize" },
        })
      : true
    if (!confirmed) return

    setInitializing(true)
    try {
      await props.context.client.vcs.init({
        location: { directory: loc.directory },
        provider: "git",
      })
      props.context.ui.toast.show({
        title: "Git initialized",
        message: `Initialized Git repository in ${loc.directory}`,
        variant: "success",
      })
      await props.context.data.location.vcs?.sync?.(loc)
      void refetch()
    } catch (err: unknown) {
      props.context.ui.toast.show({
        title: "Git initialization failed",
        message: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    } finally {
      setInitializing(false)
    }
  }

  const [expandedFiles, setExpandedFiles] = createSignal<Set<string>>(new Set())
  const [hoveredFile, setHoveredFile] = createSignal<string>()
  const [headerHovered, setHeaderHovered] = createSignal(false)

  const diffInput = createMemo(() => {
    const loc = location()
    const id = props.sessionID
    const status = props.context.data.session.status(id)
    const msgCount = props.context.data.session.message.list(id).length
    return {
      sessionID: id,
      location: loc,
      status,
      msgCount,
    }
  })

  const [diff, { refetch }] = createResource(diffInput, async (input) => {
    // 1. Try VCS working (uncommitted local changes)
    try {
      const working = await props.context.client.vcs.diff({
        location: input.location,
        mode: "working",
        context: 3,
      })
      if (working.data && working.data.length > 0) {
        return working.data.map((item) => ({
          file: item.file,
          patch: item.patch,
          additions: item.additions,
          deletions: item.deletions,
          status: item.status,
        }))
      }
    } catch {}

    // 2. Try VCS branch (branch changes against base)
    try {
      const branch = await props.context.client.vcs.diff({
        location: input.location,
        mode: "branch",
        context: 3,
      })
      if (branch.data && branch.data.length > 0) {
        return branch.data.map((item) => ({
          file: item.file,
          patch: item.patch,
          additions: item.additions,
          deletions: item.deletions,
          status: item.status,
        }))
      }
    } catch {}

    // 3. Fallback to session turn snapshot diff
    try {
      const sessionDiff = await props.context.client.session.diff({
        sessionID: input.sessionID,
        context: 3,
      })
      if (sessionDiff && sessionDiff.length > 0) {
        return sessionDiff.map((item) => ({
          file: item.file,
          patch: item.patch,
          additions: item.additions,
          deletions: item.deletions,
          status: item.status,
        }))
      }
    } catch {}

    return []
  })

  // Refetch when session finishes running a turn
  createEffect((previous) => {
    const status = props.context.data.session.status(props.sessionID)
    if (previous === "running" && status === "idle") {
      void refetch()
    }
    return status
  })

  const MAX_SIDEBAR_FILES = 20

  const files = createMemo(() => (diff.error || diff.loading ? [] : (diff() ?? [])))
  const visibleFiles = createMemo(() => files().slice(0, MAX_SIDEBAR_FILES))
  const remainingCount = createMemo(() => Math.max(0, files().length - MAX_SIDEBAR_FILES))
  const totalAdditions = createMemo(() => files().reduce((sum, f) => sum + f.additions, 0))
  const totalDeletions = createMemo(() => files().reduce((sum, f) => sum + f.deletions, 0))

  const openDiffViewer = () => {
    const returnRoute = { type: "session" as const, sessionID: props.sessionID }
    props.context.ui.router.navigate({
      type: "plugin",
      name: "diff",
      data: {
        sessionID: props.sessionID,
        returnRoute,
      },
    })
  }

  const toggleFile = (file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  return (
    <box flexDirection="column" gap={0} marginBottom={1}>
      {/* Header */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        onMouseOver={() => setHeaderHovered(true)}
        onMouseOut={() => setHeaderHovered(false)}
        onMouseUp={(e) => {
          if (e.button === MouseButton.LEFT) openDiffViewer()
        }}
      >
        <box flexDirection="row" gap={1}>
          <text
            fg={headerHovered() ? theme.text.action.secondary.base : theme.text.base}
            attributes={TextAttributes.BOLD}
          >
            Diff
          </text>
          <Show when={files().length > 0}>
            <text fg={theme.text.muted}>
              · {files().length} file{files().length !== 1 ? "s" : ""}
            </text>
          </Show>
        </box>
        <Show
          when={files().length > 0}
          fallback={
            <text
              fg={!hasVcs() ? (theme.text.feedback?.info?.base ?? theme.text.muted) : theme.text.muted}
              attributes={TextAttributes.DIM}
            >
              {!hasVcs() ? "no git" : "clean"}
            </text>
          }
        >
          <box flexDirection="row" gap={1}>
            <Show when={totalAdditions() > 0}>
              <text fg={theme.diff.text.added}>+{totalAdditions()}</text>
            </Show>
            <Show when={totalDeletions() > 0}>
              <text fg={theme.diff.text.removed}>-{totalDeletions()}</text>
            </Show>
            <text fg={headerHovered() ? theme.text.base : theme.text.muted}>↗</text>
          </box>
        </Show>
      </box>

      {/* File List */}
      <Switch>
        <Match when={diff.error}>
          <text fg={theme.text.feedback.error.base ?? theme.text.muted} attributes={TextAttributes.DIM}>
            Diff unavailable
          </text>
        </Match>
        <Match when={diff.loading && files().length === 0}>
          <text fg={theme.text.muted}>Loading diff…</text>
        </Match>
        <Match when={!diff.loading && files().length === 0 && canInitGit()}>
          <box flexDirection="column" gap={0} marginTop={0}>
            <text fg={theme.text.muted} attributes={TextAttributes.DIM}>
              No Git repository
            </text>
            <box
              marginTop={0}
              flexDirection="row"
              backgroundColor={initHovered() ? theme.background.raised.high : undefined}
              onMouseOver={() => setInitHovered(true)}
              onMouseOut={() => setInitHovered(false)}
              onMouseUp={(e) => {
                if (e.button === MouseButton.LEFT) void handleInitGit()
              }}
            >
              <text
                fg={initHovered() ? (theme.text.action.primary?.hovered ?? theme.text.base) : (theme.text.action.primary?.base ?? theme.text.base)}
                attributes={TextAttributes.UNDERLINE}
              >
                {initializing() ? "Initializing Git…" : "Initialize Git repository"}
              </text>
            </box>
          </box>
        </Match>
        <Match when={!diff.loading && files().length === 0 && !hasVcs()}>
          <text fg={theme.text.muted} attributes={TextAttributes.DIM}>
            No Git repository
          </text>
        </Match>
        <Match when={!diff.loading && files().length === 0}>
          <text fg={theme.text.muted} attributes={TextAttributes.DIM}>
            No changes
          </text>
        </Match>
        <Match when={files().length > 0}>
          <box flexDirection="column" marginTop={0}>
            <For each={visibleFiles()}>
              {(file) => {
                const isExpanded = () => expandedFiles().has(file.file)
                const isHovered = () => hoveredFile() === file.file
                const statusColor = () => {
                  if (file.status === "added") return theme.diff.text.added
                  if (file.status === "deleted") return theme.diff.text.removed
                  return theme.text.feedback.warning.base ?? theme.text.muted
                }
                const statusChar = () => {
                  if (file.status === "added") return "A"
                  if (file.status === "deleted") return "D"
                  return "M"
                }

                const patchLines = createMemo(() => {
                  if (!isExpanded() || !file.patch) return []
                  return file.patch
                    .split(/\r?\n/)
                    .slice(0, 15)
                    .map((line) => (line.length > 300 ? line.slice(0, 300) : line))
                })

                return (
                  <box flexDirection="column">
                    <box
                      flexDirection="row"
                      justifyContent="space-between"
                      backgroundColor={isHovered() ? theme.background.raised.high : undefined}
                      onMouseOver={() => setHoveredFile(file.file)}
                      onMouseOut={() => setHoveredFile(undefined)}
                      onMouseUp={(e) => {
                        if (e.button === MouseButton.LEFT) toggleFile(file.file)
                      }}
                    >
                      <box flexDirection="row" flexGrow={1} minWidth={0} marginRight={1}>
                        <text fg={statusColor()} flexShrink={0} marginRight={1}>
                          {statusChar()}
                        </text>
                        <text fg={isHovered() ? theme.text.base : theme.text.muted} wrapMode="none" truncate>
                          {truncateFilePath(file.file, 26)}
                        </text>
                      </box>
                      <box flexDirection="row" flexShrink={0} gap={1}>
                        <Show when={file.additions > 0}>
                          <text fg={theme.diff.text.added}>+{file.additions}</text>
                        </Show>
                        <Show when={file.deletions > 0}>
                          <text fg={theme.diff.text.removed}>-{file.deletions}</text>
                        </Show>
                      </box>
                    </box>

                    {/* Inline patch lines if expanded */}
                    <Show when={isExpanded() && patchLines().length > 0}>
                      <box
                        flexDirection="column"
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={theme.background.base}
                      >
                        <For each={patchLines()}>
                          {(line) => {
                            if (line.startsWith("@@")) {
                              return (
                                <text fg={theme.diff.text.hunkHeader} wrapMode="none" truncate>
                                  {line}
                                </text>
                              )
                            }
                            if (line.startsWith("+") && !line.startsWith("+++")) {
                              return (
                                <text fg={theme.diff.text.added} wrapMode="none" truncate>
                                  {line}
                                </text>
                              )
                            }
                            if (line.startsWith("-") && !line.startsWith("---")) {
                              return (
                                <text fg={theme.diff.text.removed} wrapMode="none" truncate>
                                  {line}
                                </text>
                              )
                            }
                            return (
                              <text fg={theme.text.muted} wrapMode="none" truncate>
                                {line}
                              </text>
                            )
                          }}
                        </For>
                        <Show when={file.patch && file.patch.split(/\r?\n/).length > 15}>
                          <box
                            onMouseUp={(e) => {
                              if (e.button === MouseButton.LEFT) openDiffViewer()
                            }}
                          >
                            <text fg={theme.text.action.secondary.base} wrapMode="none">
                              … view more in full diff
                            </text>
                          </box>
                        </Show>
                      </box>
                    </Show>
                  </box>
                )
              }}
            </For>
            <Show when={remainingCount() > 0}>
              <box
                flexDirection="row"
                paddingTop={0}
                onMouseUp={(e) => {
                  if (e.button === MouseButton.LEFT) openDiffViewer()
                }}
              >
                <text fg={theme.text.action.secondary.base} wrapMode="none">
                  … and {remainingCount()} more {remainingCount() === 1 ? "file" : "files"}
                </text>
              </box>
            </Show>
          </box>
        </Match>
      </Switch>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.diff",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarDiff context={context} sessionID={props.sessionID} />,
    })
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "vcs.init",
          title: "Initialize Git repository",
          group: "VCS",
          palette: true,
          async run() {
            const loc = context.location
            if (!loc) return
            const confirmed = context.ui.dialog
              ? await context.ui.dialog.confirm({
                  title: "Initialize Git",
                  message: `Initialize Git repository in ${loc.directory}?`,
                  label: { confirm: "Initialize" },
                })
              : true
            if (!confirmed) return
            try {
              await context.client.vcs.init({
                location: { directory: loc.directory },
                provider: "git",
              })
              context.ui.toast?.show({
                title: "Git initialized",
                message: `Initialized Git repository in ${loc.directory}`,
                variant: "success",
              })
              await context.data.location.vcs?.sync?.(loc)
            } catch (err: unknown) {
              context.ui.toast?.show({
                title: "Git initialization failed",
                message: err instanceof Error ? err.message : String(err),
                variant: "error",
              })
            }
          },
        },
      ],
    }))
  },
})
