/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { isExcludedDirectory, SidebarDiff } from "../../src/feature-plugins/sidebar/diff"
import os from "node:os"
import path from "node:path"

function mockContext(options?: {
  directory?: string
  hasVcs?: boolean
  vcsWorking?: Array<{ file: string; additions: number; deletions: number; status: "added" | "deleted" | "modified"; patch?: string }>
  files?: Array<{ path: string; type: "file" | "directory" }>
}) {
  const color = RGBA.fromInts(200, 200, 200)
  const green = RGBA.fromInts(0, 255, 0)
  const red = RGBA.fromInts(255, 0, 0)
  const dir = options?.directory ?? "/workspace"
  const hasVcs = options?.hasVcs ?? true
  return {
    theme: {
      text: {
        base: color,
        muted: color,
        action: { secondary: { base: color }, primary: { base: color, hovered: color } },
        feedback: { warning: { base: color }, info: { base: color } },
      },
      diff: {
        text: {
          added: green,
          removed: red,
          hunkHeader: color,
        },
      },
      background: {
        base: color,
        raised: { high: color, base: color },
      },
    },
    location: { directory: dir },
    data: {
      session: {
        get: () => ({ location: { directory: dir } }),
        status: () => "idle",
        message: { list: () => [] },
      },
      location: {
        default: () => ({ directory: dir }),
        vcs: {
          info: () => (hasVcs ? { branch: { current: "main" } } : undefined),
          sync: async () => {},
        },
      },
    },
    client: {
      fs: {
        list: async () => ({ location: { directory: dir }, data: options?.files ?? [] }),
      },
      vcs: {
        diff: async (params: any) => {
          if (params.mode === "working") {
            return { data: options?.vcsWorking ?? [] }
          }
          return { data: [] }
        },
        init: async () => {},
      },
      session: {
        diff: async () => [],
      },
    },
    ui: {
      router: {
        navigate: () => {},
      },
      toast: {
        show: () => {},
      },
    },
  } as unknown as Context
}

test("sidebar diff displays 'No changes' when working tree is clean", async () => {
  const app = await testRender(() => <SidebarDiff context={mockContext()} sessionID="session" />, {
    width: 42,
    height: 8,
  })

  try {
    await new Promise((r) => setTimeout(r, 20))
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Diff")
    expect(frame).toContain("No changes")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar diff displays changed files with stats", async () => {
  const app = await testRender(
    () =>
      <SidebarDiff
        context={mockContext({
          vcsWorking: [
            { file: "src/main.asm", additions: 12, deletions: 2, status: "modified" },
            { file: "src/wm.asm", additions: 34, deletions: 0, status: "added" },
          ],
        })}
        sessionID="session"
      />,
    {
      width: 42,
      height: 8,
    },
  )

  try {
    await new Promise((r) => setTimeout(r, 20))
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Diff")
    expect(frame).toContain("2 files")
    expect(frame).toContain("main.asm")
    expect(frame).toContain("wm.asm")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar diff offers Git initialization when candidate project has no VCS", async () => {
  const app = await testRender(
    () =>
      <SidebarDiff
        context={mockContext({
          hasVcs: false,
          directory: "/workspace/ruff",
        })}
        sessionID="session"
      />,
    {
      width: 42,
      height: 8,
    },
  )

  try {
    await new Promise((r) => setTimeout(r, 20))
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Diff")
    expect(frame).toContain("no git")
    expect(frame).toContain("Initialize Git repository")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar diff does not offer Git initialization in excluded home directory", async () => {
  const home = os.homedir()
  const app = await testRender(
    () =>
      <SidebarDiff
        context={mockContext({
          hasVcs: false,
          directory: home,
        })}
        sessionID="session"
      />,
    {
      width: 42,
      height: 8,
    },
  )

  try {
    await new Promise((r) => setTimeout(r, 20))
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Diff")
    expect(frame).toContain("no git")
    expect(frame).toContain("No Git repository")
    expect(frame).not.toContain("Initialize Git repository")
  } finally {
    app.renderer.destroy()
  }
})

test("isExcludedDirectory correctly filters system, root, and home directories", () => {
  const home = os.homedir()
  expect(isExcludedDirectory(home)).toBe(true)
  expect(isExcludedDirectory(path.join(home, "Desktop"))).toBe(true)
  expect(isExcludedDirectory(path.join(home, "Downloads"))).toBe(true)
  expect(isExcludedDirectory(os.tmpdir())).toBe(true)
  expect(isExcludedDirectory(path.parse(home).root)).toBe(true)
  expect(isExcludedDirectory("")).toBe(true)

  // Normal project subdirectories are NOT excluded
  expect(isExcludedDirectory(path.join(home, "Desktop", "my-project"))).toBe(false)
  expect(isExcludedDirectory(path.join(home, "Desktop", "ruff"))).toBe(false)
  expect(isExcludedDirectory(path.join(home, "Projects", "frontend"))).toBe(false)
})
