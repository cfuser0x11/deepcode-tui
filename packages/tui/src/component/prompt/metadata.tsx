import { RGBA, TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useDeadMode } from "../../context/dead-mode"
import { useDialog } from "../../ui/dialog"
import { DialogModel } from "../dialog-model"
import { DialogVariant } from "../dialog-variant"
import { DialogAgent } from "../dialog-agent"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"

export function PromptMetadataRow(props: {
  mode: "normal" | "shell"
  agent?: string
  auto: boolean
  model: string
  provider: string
  variant?: string
  muted: boolean
  highlight: RGBA
  agentAlpha: number
  modelAlpha: number
  variantAlpha: number
}) {
  const theme = useTheme()
  const deadMode = useDeadMode()
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()
  const renderer = useRenderer()

  const [agentHovered, setAgentHovered] = createSignal(false)
  const [modelHovered, setModelHovered] = createSignal(false)
  const [variantHovered, setVariantHovered] = createSignal(false)

  function openAgent() {
    if (renderer.getSelection()?.getSelectedText()) return
    dialog.replace(() => <DialogAgent />)
  }

  function openModel() {
    if (renderer.getSelection()?.getSelectedText()) return
    dialog.replace(() => <DialogModel />)
  }

  function openVariant() {
    if (renderer.getSelection()?.getSelectedText()) return
    dialog.replace(() => <DialogVariant />)
  }

  const layout = createMemo(() => {
    if (props.mode === "shell") return { agent: props.agent ?? "Shell", model: "" }
    return promptMetadataLayout({
      width: Math.max(0, dimensions().width - (dimensions().width < 44 ? 9 : 13)),
      terminalWidth: dimensions().width,
      agent: props.agent ?? "",
      auto: props.auto,
      model: props.model,
      provider: props.provider,
      variant: props.variant,
    })
  })

  return (
    <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
      <Show
        when={(props.mode === "shell" || props.agent) && (layout().agent || layout().model)}
        fallback={<box height={1} />}
      >
        <Show when={layout().agent}>
          {(agent) => (
            <text
              fg={fade(agentHovered() ? theme.text.base : props.highlight, props.agentAlpha)}
              attributes={agentHovered() ? TextAttributes.UNDERLINE : undefined}
              onMouseOver={() => setAgentHovered(true)}
              onMouseOut={() => setAgentHovered(false)}
              onMouseUp={openAgent}
            >
              {agent()}
            </text>
          )}
        </Show>
        <Show when={props.mode === "normal" && layout().auto}>
          <text fg={fade(theme.text.muted, props.agentAlpha)}>auto</text>
        </Show>
        <Show when={props.mode === "normal" && layout().model}>
          <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
            <Show when={layout().agent}>
              <text fg={fade(theme.text.muted, props.modelAlpha)}>·</text>
            </Show>
            <box
              flexDirection="row"
              gap={1}
              flexShrink={1}
              minWidth={0}
              onMouseOver={() => setModelHovered(true)}
              onMouseOut={() => setModelHovered(false)}
              onMouseUp={openModel}
            >
              <text
                flexShrink={1}
                minWidth={0}
                wrapMode="none"
                truncate
                fg={fade(modelHovered() ? theme.text.base : props.muted ? theme.text.muted : theme.text.base, props.modelAlpha)}
                attributes={modelHovered() ? TextAttributes.UNDERLINE : undefined}
              >
                {layout().model}
              </text>
              <Show when={layout().provider}>
                {(provider) => (
                  <text
                    flexShrink={0}
                    fg={fade(modelHovered() ? theme.text.base : theme.text.muted, props.modelAlpha)}
                    attributes={modelHovered() ? TextAttributes.UNDERLINE : undefined}
                  >
                    {provider()}
                  </text>
                )}
              </Show>
            </box>
            <Show when={layout().variant}>
              {(variant) => (
                <>
                  <text fg={fade(theme.text.muted, props.variantAlpha)}>·</text>
                  <text
                    fg={fade(theme.text.feedback.warning.base, props.variantAlpha)}
                    attributes={TextAttributes.BOLD | (variantHovered() ? TextAttributes.UNDERLINE : 0)}
                    onMouseOver={() => setVariantHovered(true)}
                    onMouseOut={() => setVariantHovered(false)}
                    onMouseUp={openVariant}
                  >
                    {variant()}
                  </text>
                </>
              )}
            </Show>
            <Show when={deadMode.get()}>
              <text fg={fade(theme.text.muted, props.modelAlpha)}>·</text>
              <text
                fg={fade(theme.text.feedback.warning.base, props.modelAlpha)}
                attributes={TextAttributes.BOLD}
              >
                dead mode
              </text>
            </Show>
          </box>
        </Show>
      </Show>
    </box>
  )
}

function fade(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

type Layout = {
  agent?: string
  auto?: boolean
  model: string
  provider?: string
  variant?: string
}

function promptMetadataLayout(input: {
  width: number
  terminalWidth: number
  agent: string
  auto?: boolean
  model: string
  provider: string
  variant?: string
}) {
  const agent = input.terminalWidth < 44 ? undefined : input.agent
  const provider = input.terminalWidth < 44 ? "" : input.provider
  const variant =
    input.variant && input.variant !== "none" && input.variant !== "default"
      ? input.variant
      : undefined
  const candidates: Layout[] = [
    { agent, auto: input.auto, model: input.model, provider, variant },
    { agent, model: input.model, provider, variant },
    {
      agent,
      model: input.model,
      provider: provider.split(" / ").at(-1) ?? provider,
      variant,
    },
    { agent, model: input.model, variant },
  ]
  const fit = candidates.find((candidate) => stringWidth(text(candidate)) <= input.width)
  if (fit) return fit

  const prefix = agent ? `${agent} · ` : ""
  const suffix = variant ? ` · ${variant}` : ""
  return {
    agent,
    model: Locale.truncateWidth(
      input.model,
      Math.max(9, input.width - stringWidth(prefix) - stringWidth(suffix)),
    ).replace(/\s+…$/, "…"),
    variant,
  }
}

function text(input: Layout) {
  return [
    ...(input.agent ? [input.agent] : []),
    ...(input.auto ? ["auto"] : []),
    ...(input.model ? [...(input.agent ? ["·"] : []), input.model] : []),
    ...(input.provider ? [input.provider] : []),
    ...(input.variant ? ["·", input.variant] : []),
  ].join(" ")
}
