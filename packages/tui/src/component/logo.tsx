import { RGBA, TextAttributes } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { tint } from "../theme/color"
import { go, logo } from "../logo"

export function Logo() {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()

  const deepFg = () => tint(theme.background.base, RGBA.fromHex("#3b82f6"), 0.65)
  const deepShadow = () => tint(theme.background.base, deepFg(), 0.35)
  const codeFg = () => tint(theme.background.base, theme.text.base, 0.55)
  const codeShadow = () => tint(theme.background.base, codeFg(), 0.35)

  const renderLine = (line: string, fg: RGBA, shadow: RGBA, bold: boolean): JSX.Element[] => {
    const attrs = bold ? TextAttributes.BOLD : undefined
    return Array.from(line).map((char) => {
      if (char === "_") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            {" "}
          </text>
        )
      }
      if (char === "^") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === "~") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === ",") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▄
          </text>
        )
      }
      return (
        <text fg={fg} attributes={attrs} selectable={false}>
          {char}
        </text>
      )
    })
  }

  return (
    <box>
      {dimensions().height < 12 ? null : dimensions().width < 22 ? (
        <For each={go.right.slice(1)}>
          {(line) => <box flexDirection="row">{renderLine(line, codeFg(), codeShadow(), false)}</box>}
        </For>
      ) : dimensions().width < 44 ? (
        <>
          <For each={logo.left}>
            {(line) => <box flexDirection="row">{renderLine(line, deepFg(), deepShadow(), false)}</box>}
          </For>
          <For each={logo.right}>
            {(line) => <box flexDirection="row">{renderLine(line, codeFg(), codeShadow(), false)}</box>}
          </For>
        </>
      ) : (
        <For each={logo.left}>
          {(line, index) => (
            <box flexDirection="row" gap={1}>
              <box flexDirection="row">{renderLine(line, deepFg(), deepShadow(), false)}</box>
              <box flexDirection="row">{renderLine(logo.right[index()], codeFg(), codeShadow(), false)}</box>
            </box>
          )}
        </For>
      )}
    </box>
  )
}
