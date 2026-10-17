import { describe, expect, test } from "bun:test"
import { LLM, LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/route/client"
import { Agent } from "@opencode/core/agent"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProviderContext } from "@opencode/core/session/provider-context"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect } from "effect"

describe("DeepSeek stateful conversation & compaction lifecycle", () => {
  const deepseekModel = SessionRunnerModel.resolved(
    LanguageModel.make({
      id: "deepseek-chat",
      provider: "deepseek",
      route: OpenAIChat.route.with({ endpoint: { baseURL: "https://api.deepseek.com/v1" } }),
    }),
    {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      cost: [],
      limit: { context: 64000, output: 4000 },
    },
  )

  const agent = Agent.Info.default(Agent.defaultID)
  const tools = { definitions: [], execute: () => {} } as any
  const initialInstructions = "You are a professional software engineer assistant."

  const compileBody = (transcript: ReturnType<typeof SessionModelRequest.baseTranscript>) =>
    Effect.gen(function* () {
      const req = LLM.request({
        model: deepseekModel.model,
        system: transcript.system,
        messages: transcript.messages,
        metadata: transcript.conversationId ? { conversationId: transcript.conversationId } : undefined,
      })
      const prepared = yield* compileRequest(req)
      return prepared.body as Record<string, unknown>
    })

  test("Turn 1 (Task 1): initial prompt sends full instructions without conversation_id", async () => {
    const user1 = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Task 1: Setup database schema",
      time: { created: DateTime.makeUnsafe(100) },
    })

    const transcript = SessionModelRequest.baseTranscript({
      agent,
      model: deepseekModel,
      tools,
      initial: initialInstructions,
      messages: [user1],
    })

    expect(transcript.conversationId).toBeUndefined()
    expect(transcript.system.length).toBeGreaterThan(0)
    expect(transcript.messages).toHaveLength(1)

    const body = await Effect.runPromise(compileBody(transcript))
    expect(body.conversation_id).toBeUndefined()
    const msgs = body.messages as Array<{ role: string; content: string }>
    expect(msgs[0]?.role).toBe("system")
    expect(msgs[1]?.role).toBe("user")
    expect(msgs[1]?.content).toContain("Task 1: Setup database schema")
    expect(msgs[1]?.content).toContain("[SYSTEM REMINDER]")
  })

  test("Turn 2 (Task 2): delta turn sends only new user message with conversation_id:2", async () => {
    const user1 = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Task 1: Setup database schema",
      time: { created: DateTime.makeUnsafe(100) },
    })
    const asst1 = {
      id: SessionMessage.ID.create(),
      type: "assistant",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      providerState: { conversationId: "conv-deepseek-100" },
      content: [{ type: "text", text: "Database schema configured." }],
      time: { created: DateTime.makeUnsafe(200), completed: DateTime.makeUnsafe(250) },
    } as unknown as SessionMessage.Info

    const user2 = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Task 2: Add migration scripts",
      time: { created: DateTime.makeUnsafe(300) },
    })

    const messages = [user1, asst1, user2]
    expect(SessionProviderContext.activeConversationId(messages)).toBe("conv-deepseek-100")

    const transcript = SessionModelRequest.baseTranscript({
      agent,
      model: deepseekModel,
      tools,
      initial: initialInstructions,
      messages,
    })

    // Active conversation ID is passed, system is stripped, messages sliced to delta
    expect(transcript.conversationId).toBe("conv-deepseek-100")
    expect(transcript.system).toEqual([])
    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0]?.role).toBe("user")

    const body = await Effect.runPromise(compileBody(transcript))
    // Lowered body normalizes conv ID to include :2 suffix
    expect(body.conversation_id).toBe("conv-deepseek-100:2")
    const msgs = body.messages as Array<{ role: string; content: string }>
    // Exactly 1 delta message sent to proxy, avoiding history duplication/hallucination
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.role).toBe("user")
    expect(msgs[0]?.content).toContain("Task 2: Add migration scripts")
    expect(msgs[0]?.content).toContain("[SYSTEM REMINDER]")
  })

  test("Turn 3 (Compaction): standalone compaction does not send conversation_id", async () => {
    const user1 = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Task 1: Setup database schema",
      time: { created: DateTime.makeUnsafe(100) },
    })
    const asst1 = {
      id: SessionMessage.ID.create(),
      type: "assistant",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      providerState: { conversationId: "conv-deepseek-100" },
      content: [{ type: "text", text: "Database schema configured." }],
      time: { created: DateTime.makeUnsafe(200), completed: DateTime.makeUnsafe(250) },
    } as unknown as SessionMessage.Info
    const user2 = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Task 2: Add migration scripts",
      time: { created: DateTime.makeUnsafe(300) },
    })
    const asst2 = {
      id: SessionMessage.ID.create(),
      type: "assistant",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      providerState: { conversationId: "conv-deepseek-100:3" },
      content: [{ type: "text", text: "Migrations added." }],
      time: { created: DateTime.makeUnsafe(400), completed: DateTime.makeUnsafe(450) },
    } as unknown as SessionMessage.Info

    const messages = [user1, asst1, user2, asst2]

    // Compaction invokes baseTranscript with standalone: true
    const transcript = SessionModelRequest.baseTranscript({
      agent,
      model: deepseekModel,
      tools,
      initial: initialInstructions,
      messages,
      standalone: true,
    })

    expect(transcript.conversationId).toBeUndefined()
    expect(transcript.system.length).toBeGreaterThan(0)
    // Compaction sees full conversation
    expect(transcript.messages).toHaveLength(4)

    const body = await Effect.runPromise(compileBody(transcript))
    // No conversation_id in compaction payload so it does not pollute proxy thread
    expect(body.conversation_id).toBeUndefined()
  })

  test("Turn 4 (Post-Compaction Task 3): resets conversation_id and sends full briefing in fresh chat", async () => {
    const user1 = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Task 1: Setup database schema",
      time: { created: DateTime.makeUnsafe(100) },
    })
    const asst1 = {
      id: SessionMessage.ID.create(),
      type: "assistant",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      providerState: { conversationId: "conv-deepseek-100" },
      content: [{ type: "text", text: "Database schema configured." }],
      time: { created: DateTime.makeUnsafe(200), completed: DateTime.makeUnsafe(250) },
    } as unknown as SessionMessage.Info
    const user2 = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Task 2: Add migration scripts",
      time: { created: DateTime.makeUnsafe(300) },
    })
    const asst2 = {
      id: SessionMessage.ID.create(),
      type: "assistant",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      providerState: { conversationId: "conv-deepseek-100:3" },
      content: [{ type: "text", text: "Migrations added." }],
      time: { created: DateTime.makeUnsafe(400), completed: DateTime.makeUnsafe(450) },
    } as unknown as SessionMessage.Info

    const compactMsg = SessionMessage.Compaction.make({
      id: SessionMessage.ID.create(),
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "PRIMARY OBJECTIVE: Setup database and migrations\nCOMPACTED AGENT CONTEXT:\n- Schema created\n- Migrations verified",
      recent: "Last migration ran successfully.",
      time: { created: DateTime.makeUnsafe(500) },
    })

    const user3 = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Task 3: Refactor the auth service",
      time: { created: DateTime.makeUnsafe(600) },
    })

    const messages = [user1, asst1, user2, asst2, compactMsg, user3]

    // activeConversationId detects completed compaction and resets to undefined!
    expect(SessionProviderContext.activeConversationId(messages)).toBeUndefined()

    const transcript = SessionModelRequest.baseTranscript({
      agent,
      model: deepseekModel,
      tools,
      initial: initialInstructions,
      messages,
    })

    expect(transcript.conversationId).toBeUndefined()
    expect(transcript.system.length).toBeGreaterThan(0)

    const body = await Effect.runPromise(compileBody(transcript))
    expect(body.conversation_id).toBeUndefined()

    const msgs = body.messages as Array<{ role: string; content: string }>
    expect(msgs[0]?.role).toBe("system")

    // The compacted context is passed cleanly as a briefing followed by assistant acknowledgment
    const compactedUserMsg = msgs.find((m) => m.content.includes("[COMPACTED AGENT CONTEXT]"))
    expect(compactedUserMsg).toBeDefined()
    expect(compactedUserMsg?.content).toContain("PRIMARY OBJECTIVE: Setup database and migrations")
    expect(compactedUserMsg?.content).toContain("[RECENT CONTEXT]\nLast migration ran successfully.")

    const ackMsg = msgs.find((m) => m.content.includes("Context briefing recognized"))
    expect(ackMsg).toBeDefined()
    expect(ackMsg?.role).toBe("assistant")

    // The new task prompt is delivered as the final user message
    const lastUserMsg = msgs.at(-1)
    expect(lastUserMsg?.role).toBe("user")
    expect(lastUserMsg?.content).toContain("Task 3: Refactor the auth service")
    expect(lastUserMsg?.content).toContain("[SYSTEM REMINDER]")
  })

  test("Turn 5 (Task 4 in new thread): subsequent turn in new chat resumes stateful delta slicing", async () => {
    const compactMsg = SessionMessage.Compaction.make({
      id: SessionMessage.ID.create(),
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "PRIMARY OBJECTIVE: Setup database and migrations\nCOMPACTED AGENT CONTEXT:\n- Schema created",
      recent: "",
      time: { created: DateTime.makeUnsafe(500) },
    })

    const user3 = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Task 3: Refactor the auth service",
      time: { created: DateTime.makeUnsafe(600) },
    })

    // Assistant response to Task 3 starts a brand new conversation_id upstream
    const asst3 = {
      id: SessionMessage.ID.create(),
      type: "assistant",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      providerState: { conversationId: "conv-deepseek-200" },
      content: [{ type: "text", text: "Auth service refactored with new tokens." }],
      time: { created: DateTime.makeUnsafe(700), completed: DateTime.makeUnsafe(750) },
    } as unknown as SessionMessage.Info

    const user4 = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Task 4: Add indexing to user lookup",
      time: { created: DateTime.makeUnsafe(800) },
    })

    const messages = [compactMsg, user3, asst3, user4]

    // Newly established conversation ID is active
    expect(SessionProviderContext.activeConversationId(messages)).toBe("conv-deepseek-200")

    const transcript = SessionModelRequest.baseTranscript({
      agent,
      model: deepseekModel,
      tools,
      initial: initialInstructions,
      messages,
    })

    expect(transcript.conversationId).toBe("conv-deepseek-200")
    expect(transcript.system).toEqual([])
    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0]?.role).toBe("user")

    const body = await Effect.runPromise(compileBody(transcript))
    expect(body.conversation_id).toBe("conv-deepseek-200:2")
    const msgs = body.messages as Array<{ role: string; content: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.role).toBe("user")
    expect(msgs[0]?.content).toContain("Task 4: Add indexing to user lookup")
    expect(msgs[0]?.content).toContain("[SYSTEM REMINDER]")
  })

  test("Tool execution turn: stateful turn sends tool result delta message instead of synthetic continue message", async () => {
    const user1 = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "List files in directory",
      time: { created: DateTime.makeUnsafe(100) },
    })

    const asstWithTool = {
      id: SessionMessage.ID.create(),
      type: "assistant",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      providerState: { conversationId: "conv-deepseek-tool-1" },
      content: [
        { type: "reasoning", text: "I need to check the files." },
        {
          type: "tool",
          id: "call_shell_1",
          name: "shell",
          executed: false,
          state: {
            status: "completed",
            input: { command: "ls" },
            content: [{ type: "text", text: "package.json\nsrc\nREADME.md" }],
          },
          time: { created: DateTime.makeUnsafe(200) },
        },
      ],
      time: { created: DateTime.makeUnsafe(200), completed: DateTime.makeUnsafe(250) },
    } as unknown as SessionMessage.Info

    const messages = [user1, asstWithTool]
    expect(SessionProviderContext.activeConversationId(messages)).toBe("conv-deepseek-tool-1")

    const transcript = SessionModelRequest.baseTranscript({
      agent,
      model: deepseekModel,
      tools,
      initial: initialInstructions,
      messages,
    })

    expect(transcript.conversationId).toBe("conv-deepseek-tool-1")
    expect(transcript.system).toEqual([])
    // Must contain the tool result message, NOT a synthetic "Continue your work" user message!
    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0]?.role).toBe("tool")

    const body = await Effect.runPromise(compileBody(transcript))
    expect(body.conversation_id).toBe("conv-deepseek-tool-1:2")
    const msgs = body.messages as Array<{ role: string; content: string; tool_call_id?: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.role).toBe("tool")
    expect(msgs[0]?.content).toContain("package.json\nsrc\nREADME.md")
    expect(msgs[0]?.tool_call_id).toBe("call_shell_1")
  })
})

