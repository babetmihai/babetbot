import { HumanMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import { OPENAI_API_KEY, PROMPT_TYPES } from "../config.ts"
import { fetchProvider } from "./providers.ts"
import rag from "./rag.ts"
import { renderTemplate, loadTemplate } from "./templates.ts"


const ANALYZE_MODEL = process.env.AGENT_MODEL ?? "gpt-4o-mini"
const MAX_CONTEXT_CHARS = 4000

const llm = new ChatOpenAI({
  apiKey: OPENAI_API_KEY,
  model: ANALYZE_MODEL,
  temperature: 0.5
})

export const formatConversationAnalysis = (analysis) => {
  return analysis.trim()
}

export const generateConversationAnalysis = async (caseRecord) => {
  const { background, thread } = await buildCaseContext(caseRecord)

  const prompt = renderTemplate("llm/analyze-conversation", {
    background,
    thread
  })

  const response = await llm.invoke([new HumanMessage(prompt)])

  return getMessageText(response)
}

const buildCaseContext = async (caseRecord) => {
  const assignedRoleLabel = loadTemplate("llm/assigned-role-label").trim()
  const provider = await fetchProvider(caseRecord.providerId)
  const providerPrefix = provider ? `${provider.name}:` : null

  const turns = await rag.listRecent(caseRecord.clientTelegramId, 30, { type: PROMPT_TYPES.conversation })
  const formatted = turns.reverse().map((row) => formatConversationTurn(row, providerPrefix, assignedRoleLabel))

  const firstAssignedIndex = formatted.findIndex((turn) => turn.role === assignedRoleLabel)
  const threadTurns = firstAssignedIndex === -1 ? [] : formatted.slice(firstAssignedIndex)
  const intakeTurns = firstAssignedIndex === -1 ? formatted : formatted.slice(0, firstAssignedIndex)

  const backgroundParts = []
  if (caseRecord.intakeSummary) {
    backgroundParts.push(caseRecord.intakeSummary)
  } else if (intakeTurns.length) {
    backgroundParts.push(formatTurnLines(intakeTurns))
  }
  if (!backgroundParts.length) backgroundParts.push("No prior case background.")

  const threadLines = formatTurnLines(threadTurns)
  const thread = threadLines || loadTemplate("llm/no-prior-assigned-messages").trim()

  return {
    background: trimContext(backgroundParts.join("\n\n")),
    thread: trimContext(thread)
  }
}

const formatConversationTurn = (row, providerPrefix, assignedRoleLabel) => {
  const content = row.pageContent
  const isProvider = row.metadata.role === "assistant" && providerPrefix && content.startsWith(providerPrefix)

  if (isProvider) {
    const body = content.slice(providerPrefix.length).trim()
    return { role: assignedRoleLabel, body }
  }

  if (row.metadata.role === "assistant") {
    return { role: "Intake", body: content }
  }

  return { role: "Client", body: content }
}

const formatTurnLines = (turns) => {
  return turns.map((turn) => `${turn.role}: ${turn.body}`).join("\n")
}

const trimContext = (text) => {
  if (text.length <= MAX_CONTEXT_CHARS) return text
  return `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[Truncated]`
}

const getMessageText = (message) => {
  if (typeof message.content === "string") return message.content.trim()
  if (!Array.isArray(message.content)) throw new Error("Could not analyze the conversation.")

  const text = message.content
    .map((part) => {
      if (typeof part === "string") return part
      return part.text || ""
    })
    .join("")
    .trim()

  if (!text) throw new Error("Could not analyze the conversation.")
  return text
}
