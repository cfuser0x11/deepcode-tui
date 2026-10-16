import {
  Media,
  Message,
  ReasoningEfforts,
  ToolCallPart,
  ToolResultPart,
  type ContentPart,
  type ProviderMetadata,
} from "@opencode/ai"
import type { Model } from "@opencode/schema/model"
import { Option, Schema } from "effect"
import { fileURLToPath } from "url"
import { SessionMessage } from "../message.js"
import { SessionProviderContext } from "../provider-context.js"
import type { FileAttachment } from "@opencode/schema/prompt"

const imageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const media = (file: FileAttachment): ContentPart => ({
  type: "media",
  media: Media.base64(file.data, file.mime),
  filename: file.name,
  metadata: file.description === undefined ? undefined : { description: file.description },
})

const attachmentLocation = (file: FileAttachment) => {
  if (file.source.type !== "uri") return undefined
  const url = URL.parse(file.source.uri)
  if (url?.protocol !== "file:") return undefined
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

const textAttachment = (file: FileAttachment): ContentPart => ({
  type: "text",
  text: `\n\n${[
    `Attached file: ${file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")}`,
    file.description === undefined ? undefined : `Description: ${file.description}`,
    "",
    Buffer.from(file.data, "base64").toString("utf8"),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")}`,
  metadata: {
    attachment: {
      source: file.source,
      name: file.name,
      description: file.description,
    },
  },
})

const directoryAttachment = (file: FileAttachment): ContentPart => ({
  type: "text",
  text: `\n\n${[
    `Attached directory: ${attachmentLocation(file) ?? file.name ?? (file.source.type === "uri" ? file.source.uri : "directory")}`,
    file.description === undefined ? undefined : `Description: ${file.description}`,
    file.data.length === 0 ? undefined : "",
    file.data.length === 0 ? undefined : Buffer.from(file.data, "base64").toString("utf8"),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")}`,
  metadata: {
    attachment: {
      source: file.source,
      name: file.name,
      description: file.description,
    },
  },
})

const attachmentContent = (file: FileAttachment): ContentPart[] => {
  if (file.mime === "text/plain") return [textAttachment(file)]
  if (file.mime === "application/x-directory") return [directoryAttachment(file)]
  if (imageMimes.has(file.mime) || file.mime === "application/pdf") {
    const location = attachmentLocation(file)
    return [...(location === undefined ? [] : [Message.text(`Attached file: ${location}`)]), media(file)]
  }
  return []
}

const userAttachmentContent = (files: readonly FileAttachment[]) => {
  const eligible = files.filter(
    (file) => imageMimes.has(file.mime) && file.source.type === "inline" && file.mention?.text,
  )
  if (eligible.length < 2) return files.flatMap(attachmentContent)

  const seen = new Map<string, Set<string>>()
  return files.flatMap((file) => {
    if (!imageMimes.has(file.mime) || file.source.type !== "inline" || !file.mention?.text)
      return attachmentContent(file)
    const metadata = JSON.stringify([file.mime, file.name ?? null, file.description ?? null, file.mention.text])
    const payloads = seen.get(metadata) ?? new Set<string>()
    if (payloads.has(file.data)) return []
    payloads.add(file.data)
    seen.set(metadata, payloads)
    return attachmentContent(file)
  })
}

const decodeToolInput = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const providerMetadata = (
  provider: string,
  state: Record<string, unknown> | undefined,
): ProviderMetadata | undefined => (state === undefined ? undefined : { [provider]: state })

const toolInput = (tool: SessionMessage.AssistantTool) =>
  tool.state.status === "streaming"
    ? Option.getOrElse(decodeToolInput(tool.state.input), () => tool.state.input)
    : tool.state.input

const toolCall = (tool: SessionMessage.AssistantTool, providerMetadata: ProviderMetadata | undefined): ContentPart =>
  ToolCallPart.make({
    id: tool.id,
    name: tool.name,
    input: toolInput(tool),
    providerExecuted: tool.executed,
    providerMetadata,
  })

const toolResult = (tool: SessionMessage.AssistantTool, providerMetadata: ProviderMetadata | undefined) => {
  if (tool.state.status === "completed") {
    // TODO: Materialize remote and managed URIs before provider-history lowering.
    const content = tool.state.content
    const single = content.length === 1 ? content[0] : undefined
    return ToolResultPart.make({
      id: tool.id,
      name: tool.name,
      result:
        single?.type === "text"
          ? { type: "text" as const, value: single.text }
          : { type: "content" as const, value: content },
      providerExecuted: tool.executed,
      providerMetadata,
    })
  }
  if (tool.state.status === "error") {
    return ToolResultPart.make({
      id: tool.id,
      name: tool.name,
      result: { error: tool.state.error, content: tool.state.content ?? [] },
      resultType: "error",
      providerExecuted: tool.executed,
      providerMetadata,
    })
  }
}

const assistant = (message: SessionMessage.Assistant, model: Model.Ref, providerMetadataKey: string) => {
  const sameProvider = String(message.model.providerID) === String(model.providerID)
  const sameModel = sameProvider && String(message.model.id) === String(model.id)
  const reuseProviderMetadata = sameModel && message.error === undefined
  const reasoningInterrupted = message.content.some(
    (item) => item.type === "reasoning" && item.time !== undefined && item.time.completed === undefined,
  )
  const content = message.content.flatMap((item): ContentPart[] => {
    if (item.type === "text")
      return [
        {
          type: "text",
          text: item.text,
          // Text can carry provider-bound state (e.g. Gemini thought signatures),
          // which is only replayable against the model that produced it.
          providerMetadata: reuseProviderMetadata ? providerMetadata(providerMetadataKey, item.state) : undefined,
        },
      ]
    // Let the destination adapter handle readable reasoning after a model/provider switch.
    if (item.type === "reasoning")
      return reuseProviderMetadata && !reasoningInterrupted
        ? [
            {
              type: "reasoning",
              text: item.text,
              providerMetadata: providerMetadata(providerMetadataKey, item.state),
            },
          ]
        : item.text.length > 0
          ? [{ type: message.error === undefined && !reasoningInterrupted ? "reasoning" : "text", text: item.text }]
          : []
    // Call-side metadata is model-scoped proof of generation (Gemini thought
    // signatures, OpenAI encrypted reasoning): only the producing model may
    // replay it.
    const reuseToolProviderMetadata =
      reuseProviderMetadata ||
      (sameModel && item.executed === true && (item.state.status === "completed" || item.state.status === "error"))
    const call = toolCall(
      item,
      reuseToolProviderMetadata ? providerMetadata(providerMetadataKey, item.providerState) : undefined,
    )
    if (item.executed !== true) return [call]
    // Hosted tools (e.g. google_search) run inside the provider, so their
    // result payload (`providerResultState`) is provider-format data rather
    // than model-scoped proof: it stays replayable across models of the same
    // provider. After a model switch, echo only that payload — never fall
    // back to `providerState`, whose call-side values are bound to the old
    // model.
    const result = toolResult(
      item,
      reuseToolProviderMetadata
        ? providerMetadata(providerMetadataKey, item.providerResultState ?? item.providerState)
        : sameProvider && item.providerResultState !== undefined
          ? providerMetadata(providerMetadataKey, item.providerResultState)
          : undefined,
    )
    return result ? [call, result] : [call]
  })
  const meaningful = content.filter((part) => {
    if (part.type === "text") return part.text !== ""
    if (part.type !== "reasoning") return true
    return part.text !== "" || (part.providerMetadata !== undefined && Object.keys(part.providerMetadata).length > 0)
  })
  const results = message.content
    .filter((item): item is SessionMessage.AssistantTool => item.type === "tool" && item.executed !== true)
    .map((item) =>
      toolResult(
        item,
        reuseProviderMetadata
          ? providerMetadata(providerMetadataKey, item.providerResultState ?? item.providerState)
          : undefined,
      ),
    )
    .filter((message) => message !== undefined)
    .map(Message.tool)
  if (meaningful.length === 0) return results
  return [
    Message.make({ id: message.id, role: "assistant", content: meaningful, metadata: message.metadata }),
    ...results,
  ]
}

const EFFORT_VARIANTS = new Set<string>(ReasoningEfforts)

const variantEffort = (variant: Model.VariantID | undefined) => {
  if (variant === undefined || variant === "default") return { effort: undefined }
  return EFFORT_VARIANTS.has(variant) ? { effort: variant } : undefined
}

const modelSwitched = (message: SessionMessage.ModelSelected, model: Model.Ref): Message[] => {
  const previous = message.previous
  if (previous === undefined) return []
  const same = (ref: Model.Ref) => ref.providerID === model.providerID && ref.id === model.id
  if (!same(message.model) || !same(previous)) return []
  const to = variantEffort(message.model.variant)
  const from = variantEffort(previous.variant)
  if (to === undefined || from === undefined) return []
  return [Message.effort({ effort: to.effort, previous: from.effort })]
}

function toLLMMessage(message: SessionMessage.Info, model: Model.Ref, providerMetadataKey: string): Message[] {
  switch (message.type) {
    case "agent-switched":
    case "idle":
      return []
    case "model-switched":
      return modelSwitched(message, model)
    case "location-switched":
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: `The working directory has been changed to ${message.location.directory}.`,
          metadata: message.metadata,
        }),
      ]
    case "user":
      const content = [
        ...(message.skills ?? []).flatMap((skill) => (skill.text === undefined ? [] : [Message.text(skill.text)])),
        ...(message.text === "" ? [] : [Message.text(message.text)]),
        ...userAttachmentContent(message.files ?? []),
      ]
      if (content.length === 0) return []
      return [
        Message.make({
          id: message.id,
          role: "user",
          content,
          metadata: {
            ...message.metadata,
            ...(message.agents?.length ? { agents: message.agents } : {}),
          },
        }),
      ]
    case "synthetic":
      return [Message.make({ id: message.id, role: "user", content: message.text })]
    case "skill":
      return [Message.make({ id: message.id, role: "user", content: message.text, metadata: message.metadata })]
    case "system":
      return [Message.system(message.text)]
    case "shell":
      // Background shell results enter context once, through their completion inbox item.
      if (message.metadata?.background === true) return []
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: `The following shell command was executed by the user:\n\nCommand:\n${message.command}\n\nOutput:\n${message.output?.output ?? ""}`,
          metadata: message.metadata,
        }),
      ]
    case "assistant":
      return assistant(message, model, providerMetadataKey)
    case "compaction": {
      if (message.status !== "completed") return []
      // History selection only keeps native windows the target model can replay.
      if (SessionProviderContext.isCheckpoint(message))
        return [...SessionProviderContext.decode(message.providerContext)]

      const isCompactContextFormat =
        message.summary.includes("COMPACTED AGENT CONTEXT") || message.summary.includes("PRIMARY OBJECTIVE")

      if (isCompactContextFormat) {
        let recent = message.recent
        const MAX_CHECKPOINT_CHARS = 120_000
        const header = `[COMPACTED AGENT CONTEXT]\n${message.summary}`
        if (recent && header.length + recent.length > MAX_CHECKPOINT_CHARS) {
          const allowedRecent = Math.max(0, MAX_CHECKPOINT_CHARS - header.length - 100)
          recent = recent.slice(-allowedRecent)
        }
        const userContent = recent?.trim()
          ? `${header}\n\n[RECENT CONTEXT]\n${recent}`
          : header

        return [
          Message.make({
            id: message.id,
            role: "user",
            content: userContent,
            metadata: message.metadata,
          }),
          Message.make({
            id: `${message.id}_ack`,
            role: "assistant",
            content: "Context briefing recognized. Ready to proceed with the next task step.",
          }),
        ]
      }

      let recent = message.recent
      const MAX_CHECKPOINT_CHARS = 120_000
      const summaryBlock = `<summary>\n${message.summary}\n</summary>`
      const overhead = 250 + summaryBlock.length
      if (recent && overhead + recent.length > MAX_CHECKPOINT_CHARS) {
        const allowedRecent = Math.max(0, MAX_CHECKPOINT_CHARS - overhead)
        recent = recent.slice(-allowedRecent)
      }
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: [
            "<conversation-checkpoint>",
            "The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.",
            "IMPORTANT: Historical records in recent context are for your reference only. NEVER output pseudo-tool calls, '[Assistant tool call]:', or '[Tool result]:' as text. All tool interactions must strictly use native API function calling.",
            "",
            summaryBlock,
            ...(recent ? ["", `<recent-context>\n${recent}\n</recent-context>`] : []),
            "</conversation-checkpoint>",
          ].join("\n"),
          metadata: message.metadata,
        }),
      ]
    }
  }
}

/** Translate projected Session history into canonical @opencode/ai context. */
export const toLLMMessages = (
  messages: readonly SessionMessage.Info[],
  model: Model.Ref,
  providerMetadataKey: string = model.providerID,
) => {
  const result = messages.flatMap((message) => toLLMMessage(message, model, providerMetadataKey))
  const isDead = Boolean(
    model.id.endsWith("-dead") ||
    process.env.DEEPCODE_DEAD_MODE === "1" ||
    process.env.DEAD_MODE === "1",
  )
  if (!isDead && model.providerID === "deepseek") {
    const lastUserIdx = result.map((m) => m.role).lastIndexOf("user")
    if (lastUserIdx !== -1) {
      const targetUser = result[lastUserIdx]
      const reminder = `\n\n[SYSTEM REMINDER]
- Identity: DeepCode agent, autonomous software engineering AI.
- Directive: When user requests actions or when working on tasks, immediately invoke the appropriate tool call (e.g. 'shell' or 'write'). Do NOT output executable code, scripts, or terminal commands in conversational markdown blocks. Always execute via tools directly.
- Native Tool Calling: Never emit pseudo-tool calls, "Assistant tool call:", "[Assistant tool call]:", or "Tool result:" in text. Always use native function calling schema.`
      const contentParts = [...targetUser.content]
      const alreadyHasReminder = contentParts.some(
        (part) => part.type === "text" && part.text.includes("[SYSTEM REMINDER]"),
      )
      if (!alreadyHasReminder) {
        contentParts.push(Message.text(reminder))
        result[lastUserIdx] = new Message({
          id: targetUser.id,
          role: "user",
          content: contentParts,
          metadata: targetUser.metadata,
        })
      }
    }
  }

  return result
}
