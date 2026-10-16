/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { PluginContext } from "../src/plugin/context"
import { useThemes } from "../src/context/theme"
import { renderLocal } from "./fixture/local"
import { DevToolsBar } from "../src/component/devtools-bar"

test("DevToolsBar theme panel allows multiple clicks", async () => {
  const pluginValue = {
    ready: () => true,
    list: () => [],
    server: () => [],
    registered: () => [],
    route: () => undefined,
    slots: {
      register: () => () => {},
      resolved: () => ({ slots: new Map(), claim: () => undefined } as any),
    },
    markdown: () => undefined,
    activate: async () => true,
    deactivate: async () => true,
  }

  let themesRef: ReturnType<typeof useThemes> | undefined

  function Inspector() {
    themesRef = useThemes()
    return null
  }

  const app = await renderLocal({
    children: () => (
      <PluginContext.Provider value={pluginValue}>
        <box width={80} height={20} flexDirection="column">
          <box flexGrow={1} />
          <Inspector />
          <DevToolsBar />
        </box>
      </PluginContext.Provider>
    ),
  })

  try {
    app.renderer.start()
    await app.renderOnce()

    const lines = app.captureSpans().lines
    let themeX = -1
    let themeY = -1
    for (let y = 0; y < lines.length; y++) {
      const text = lines[y]?.spans.map((s) => s.text).join("") ?? ""
      const idx = text.indexOf("Theme")
      if (idx !== -1) {
        themeX = idx + 1
        themeY = y
        break
      }
    }

    // Click "Theme"
    await app.mockMouse.click(themeX, themeY)
    await app.renderOnce()

    // Find "Next theme →" and "Select theme…" positions
    const panelLines = app.captureSpans().lines
    let nextThemeX = -1
    let nextThemeY = -1
    let selectThemeX = -1
    let selectThemeY = -1
    for (let y = 0; y < panelLines.length; y++) {
      const text = panelLines[y]?.spans.map((s) => s.text).join("") ?? ""
      const idx = text.indexOf("Next theme →")
      if (idx !== -1) {
        nextThemeX = idx + 2
        nextThemeY = y
      }
      const sIdx = text.indexOf("Select theme…")
      if (sIdx !== -1) {
        selectThemeX = sIdx + 2
        selectThemeY = y
      }
    }

    console.log("Positions:", { nextThemeX, nextThemeY, selectThemeX, selectThemeY })

    // Move to "Next theme →"
    await app.mockMouse.moveTo(nextThemeX, nextThemeY)
    await app.renderOnce()

    // Click "Next theme →"
    console.log("Click 1...")
    await app.mockMouse.click(nextThemeX, nextThemeY)
    await app.renderOnce()
    console.log("Theme after click 1:", themesRef?.selected)

    // Move to "Select theme…"
    console.log("Moving to Select theme...")
    await app.mockMouse.moveTo(selectThemeX, selectThemeY)
    await app.renderOnce()

    // Move back to "Next theme →"
    console.log("Moving back to Next theme...")
    await app.mockMouse.moveTo(nextThemeX, nextThemeY)
    await app.renderOnce()

    // Click "Next theme →" again
    console.log("Click 2...")
    await app.mockMouse.click(nextThemeX, nextThemeY)
    await app.renderOnce()
    expect(themesRef?.selected).toBeDefined()
  } finally {
    app.renderer.destroy()
  }
})
