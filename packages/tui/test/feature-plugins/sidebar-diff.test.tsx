/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarDiff } from "../../src/feature-plugins/sidebar/diff"

function mockContext(options?: {
  vcsWorking?: Array<{ file: string; additions: number; deletions: number; status: "added" | "deleted" | "modified"; patch?: string }>
}) {
  const color = RGBA.fromInts(200, 200, 200)
  const green = RGBA.fromInts(0, 255, 0)
  const red = RGBA.fromInts(255, 0, 0)
  return {
    theme: {
      text: {
        base: color,
        muted: color,
        action: { secondary: { base: color } },
        feedback: { warning: { base: color } },
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
        raised: { high: color },
      },
    },
    data: {
      session: {
        get: () => ({ location: { directory: "/workspace" } }),
        status: () => "idle",
        message: { list: () => [] },
      },
      location: {
        default: () => ({ directory: "/workspace" }),
      },
    },
    client: {
      vcs: {
        diff: async (params: any) => {
          if (params.mode === "working") {
            return { data: options?.vcsWorking ?? [] }
          }
          return { data: [] }
        },
      },
      session: {
        diff: async () => [],
      },
    },
    ui: {
      router: {
        navigate: () => {},
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
