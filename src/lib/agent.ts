import z from "zod"
import { createAgent, toolCallLimitMiddleware, modelCallLimitMiddleware } from "langchain"
import { ChatOpenAI } from "@langchain/openai"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import checkpointer from "./checkpointer.ts"
import handleToolErrors from "./middleware/handleToolErrors.ts"
import memoryMiddleware from "./middleware/memory.ts"
import user_information_retrieval from "./tools/user_information_retrieval.ts"
import save_user_information from "./tools/save_user_information.ts"
import { LEGAL_DISCLAIMER, renderTemplate } from "./templates.ts"
import { UserGoalSchema, type UserGoal } from "./goals.ts"


const {
  OPENAI_API_KEY,
  AGENT_MODEL
} = process.env

export type TAgentContext = {
  userId: string
  chatId: number
  goalContext?: string
  userMessage?: string
}

export type TAgentRuntime = {
  context: TAgentContext
  configurable: {
    thread_id: string
  }
}

export type TToolConfig = {
  context: TAgentContext
  toolCall: {
    id: string
  }
}


export const AGENT_TIMEOUT_MS = 45_000
export const AGENT_TOOL_CALL_LIMIT = 4
export const AGENT_MODEL_CALL_LIMIT = 5
export const AGENT_RECURSION_LIMIT = AGENT_MODEL_CALL_LIMIT * 4 + AGENT_TOOL_CALL_LIMIT * 3

const TOOL_LIST = [
  user_information_retrieval,
  save_user_information
]

const llm = new ChatOpenAI({
  apiKey: OPENAI_API_KEY,
  model: AGENT_MODEL,
  temperature: 0.4
})

const systemPrompt = renderTemplate("agent/intake-system", { legalDisclaimer: LEGAL_DISCLAIMER })

export const agent = createAgent({
  systemPrompt,
  model: llm,
  tools: TOOL_LIST,
  checkpointer,
  stateSchema: z.object({
    userGoals: z.array(UserGoalSchema).default([])
  }),
  contextSchema: z.object({
    userId: z.string().describe("The client's Telegram user id."),
    chatId: z.number().describe("The Telegram chat id."),
    goalContext: z.string().optional().describe("Completed intake goals as key=value pairs."),
    userMessage: z.string().optional().describe("The client's latest Telegram message.")
  }),
  middleware: [
    memoryMiddleware,
    handleToolErrors,
    toolCallLimitMiddleware({ runLimit: AGENT_TOOL_CALL_LIMIT }),
    modelCallLimitMiddleware({ runLimit: AGENT_MODEL_CALL_LIMIT })
  ]
})

export const getLlmMessageText = (message) => {
  if (typeof message.content === "string") return message.content.trim()
  if (!Array.isArray(message.content)) return null

  const text = message.content
    .map((part) => {
      if (typeof part === "string") return part
      return part.text || ""
    })
    .join("")
    .trim()

  return text || null
}

export const getAgentReply = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!AIMessage.isInstance(message)) continue

    const text = getLlmMessageText(message)
    if (text) return text
  }
  return null
}

export const invokeIntakeAgent = async (
  userContent,
  userGoals: UserGoal[],
  config: {
    context: TAgentContext
    configurable: { thread_id: string }
    recursionLimit: number
  }
) => {
  // @ts-expect-error langchain invoke input typing
  return agent.invoke({
    messages: [new HumanMessage(userContent)],
    userGoals
  }, config)
}

export const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("agent timeout")), ms))
  ])
