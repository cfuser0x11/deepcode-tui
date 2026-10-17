import type { ProviderPackage } from "../provider-package.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { ProviderID, type ModelID } from "../schema/index.js"
import type { OpenAIProviderOptionsInput } from "./openai-options.js"

export const id = ProviderID.make("deepseek")
const defaultBaseURL = process.env.DEEPSEEK_BASE_URL ?? process.env.DEEPCODE_API_URL ?? "https://api.deepseek.com/v1"

export type LanguageModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput & {
    readonly apiKey?: string
    readonly baseURL?: string
    readonly deadMode?: boolean
  }

export const route = Route.make({
  id: "deepseek-chat",
  provider: id,
  providerMetadataKey: "deepseek",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL: defaultBaseURL }),
  framing: OpenAIChat.framing,
})

export const routes = [route]

export function checkDeadMode(
  modelID: string | ModelID,
  deadMode?: boolean,
  headers?: Record<string, string | undefined>,
): boolean {
  const raw = String(modelID).toLowerCase()
  return Boolean(
    deadMode ||
    process.env.DEEPCODE_DEAD_MODE === "1" ||
    process.env.DEAD_MODE === "1" ||
    headers?.["x-dead-mode"] === "true" ||
    raw.endsWith("-dead"),
  )
}

export function checkThinking(
  modelID: string | ModelID,
  body?: unknown,
  providerOptions?: OpenAIProviderOptionsInput,
): boolean {
  const raw = String(modelID).toLowerCase()
  const thinkingVal = (body as any)?.thinking
  const isExplicitDisabled =
    thinkingVal?.type === "disabled" ||
    thinkingVal === false ||
    providerOptions?.reasoningEffort === "none"

  if (isExplicitDisabled) return false

  const isThinkingVariant =
    thinkingVal?.type === "enabled" ||
    thinkingVal === true ||
    (body as any)?.chat_template_kwargs?.thinking === true
  const isThinkingEffort =
    providerOptions?.reasoningEffort !== undefined &&
    providerOptions.reasoningEffort !== "none"

  // r1, expert, and reasoner are equal (represent the reasoning/thinking model)
  const isExplicitReasoningModel =
    raw.includes("reasoner") ||
    raw.includes("r1") ||
    raw.includes("expert")

  return Boolean(isThinkingVariant || isThinkingEffort || isExplicitReasoningModel)
}

export function resolveTargetModelID(
  modelID: string | ModelID,
  options: {
    isDead: boolean
    isThinking: boolean
  },
): string {
  const raw = String(modelID).toLowerCase()
  const isDead = options.isDead || raw.endsWith("-dead")

  const isDeepSeekFamily =
    raw.includes("deepseek") ||
    raw === "v4" ||
    raw === "chat" ||
    raw === "r1" ||
    raw === "expert" ||
    raw === "reasoner"

  if (!isDeepSeekFamily) {
    return isDead && !raw.endsWith("-dead") ? `${String(modelID)}-dead` : String(modelID)
  }

  // chat is v4; r1, expert, and reasoner are equal
  // Dead mode redirects to dead mode models with thinking or without thinking
  if (isDead) {
    return options.isThinking ? "deepseek-expert-dead" : "deepseek-chat-dead"
  }

  return options.isThinking ? "deepseek-reasoner" : "deepseek-chat"
}

export function normalizeDeepSeekBody(body: unknown, isThinking?: boolean): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined
  const record = body as Record<string, unknown>
  const rawThinking = record.thinking
  if (rawThinking === undefined) return record
  return {
    ...record,
    thinking: typeof rawThinking === "boolean" ? rawThinking : Boolean(isThinking),
  }
}

export const configure = (input: LanguageModelOptions = {}) => {
  const { apiKey: _apiKey, auth: _auth, baseURL: endpoint, ...defaults } = input
  const rawBody = (defaults.http as any)?.body
  const isThinkingDefaults = checkThinking("", rawBody, defaults.providerOptions)
  const normalizedHttp =
    rawBody !== undefined
      ? {
          ...defaults.http,
          body: normalizeDeepSeekBody(rawBody, isThinkingDefaults),
        }
      : defaults.http

  const configured = route.with({
    ...defaults,
    http: normalizedHttp,
    endpoint: { baseURL: endpoint ?? defaultBaseURL },
    auth: AuthOptions.bearer(input, ["DEEPSEEK_API_KEY", "DEEPCODE_API_KEY"]),
  })
  return {
    id,
    model: (modelID: string | ModelID) => {
      const isDead = checkDeadMode(modelID, undefined, defaults.headers as any)
      const isThinking = checkThinking(modelID, (normalizedHttp as any)?.body, defaults.providerOptions)
      const targetModelID = resolveTargetModelID(modelID, { isDead, isThinking })
      return configured.model<OpenAIProviderOptionsInput>({
        id: targetModelID,
        compatibility: { maxTokensField: "max_tokens", supportsStore: false, reasoningField: "reasoning_content" },
        ...(isDead ? { headers: { "x-dead-mode": "true" } } : {}),
      })
    },
    configure,
  }
}

export const provider = configure()

export const model: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (
  modelID,
  { apiKey, baseURL: endpoint, body, headers, deadMode, ...providerOptions },
) => {
  const isDead = checkDeadMode(modelID, deadMode, headers as any)
  const isThinking = checkThinking(modelID, body, providerOptions)
  const targetModelID = resolveTargetModelID(modelID, { isDead, isThinking })

  const normalizedBody = normalizeDeepSeekBody(body, isThinking)
  const mergedHeaders = isDead
    ? { ...headers, "x-dead-mode": "true" }
    : headers
  const mergedBody = isDead
    ? { mode: "dead", dead_mode: true, ...normalizedBody }
    : normalizedBody

  return configure({
    apiKey,
    baseURL: endpoint,
    headers: mergedHeaders,
    http: mergedBody === undefined ? undefined : { body: mergedBody },
    providerOptions,
  }).model(targetModelID)
}

export * as DeepSeek from "./deepseek.js"

