import { define } from "@opencode/plugin/effect/plugin"
import { Integration } from "@opencode/schema/integration"
import { Provider } from "@opencode/schema/provider"
import { Model } from "@opencode/schema/model"
import { Effect } from "effect"

export const DeepSeekPlugin = define({
  id: "deepcode.provider.deepseek",
  effect: Effect.fn(function* (ctx) {
    const providerID = Provider.ID.make("deepseek")
    const integrationID = Integration.ID.make("deepseek")

    yield* ctx.integration.transform((integrations) => {
      integrations.update(integrationID, (integration) => (integration.name = "DeepSeek"))
      integrations.method.update({
        integrationID,
        method: { type: "key" },
      })
      integrations.method.update({
        integrationID,
        method: {
          type: "env",
          names: ["DEEPSEEK_API_KEY", "DEEPCODE_API_KEY"],
        },
      })
    })

    const createModel = (
      id: string,
      name: string,
      isReasoner: boolean,
      isDead: boolean,
      enabled = true,
    ): Model.Info => ({
      id: Model.ID.make(id),
      modelID: Model.ID.make(id),
      providerID,
      name,
      capabilities: {
        tools: true,
        input: ["text"],
        output: ["text"],
      },
      compatibility: {
        reasoningField: "reasoning_content",
      },
      package: Provider.Package.make("@opencode/ai/providers/deepseek"),
      body: isDead ? { mode: "dead", dead_mode: true } : undefined,
      headers: isDead ? { "x-dead-mode": "true" } : undefined,
      variants: [
        {
          id: Model.VariantID.make("none"),
          settings: { thinking: false },
          body: { thinking: false },
        },
        {
          id: Model.VariantID.make("thinking"),
          settings: { thinking: true },
          body: { thinking: true },
        },
      ],
      time: { released: Date.now() },
      cost: [
        {
          input: 0.14 as any,
          output: 0.28 as any,
          cache: { read: 0.014 as any, write: 0 as any },
        },
      ],
      status: "active",
      enabled,
      settings: {
        threshold: 80_000,
        compactThreshold: 80_000,
      },
      limit: {
        context: 1_000_000,
        output: 8_192,
      },
    })

    const models: Model.Info[] = [
      createModel("deepseek-v4", "V4", false, false, true),
      // Backward-compatibility aliases (hidden from active picker, resolvable if referenced)
      createModel("deepseek-chat", "DeepSeek Chat (V4)", false, false, false),
      createModel("deepseek-chat-dead", "DeepSeek Chat (Dead Mode)", false, true, false),
      createModel("deepseek-reasoner", "DeepSeek Reasoner", true, false, false),
      createModel("deepseek-r1", "DeepSeek R1", true, false, false),
      createModel("deepseek-expert", "DeepSeek Expert", true, false, false),
      createModel("deepseek-expert-dead", "DeepSeek Expert (Dead Mode)", true, true, false),
    ]

    yield* ctx.provider.transform((providers) => {
      providers.add({
        info: {
          id: providerID,
          name: "DeepSeek",
          activation: "auto",
          package: Provider.Package.make("@opencode/ai/providers/deepseek"),
          integrationID,
          canonical: providerID,
        },
        models,
      })
    })
  }),
})
