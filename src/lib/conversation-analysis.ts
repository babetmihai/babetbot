import { HumanMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import { getLlmMessageText } from "./agent.ts"
import rag, { PROMPT_TYPES } from "./rag.ts"
import { fetchAdmin } from "./telegram.ts"
import { renderTemplate, loadTemplate } from "./templates.ts"


const {
  OPENAI_API_KEY,
  AGENT_MODEL
} = process.env
const MAX_CONTEXT_CHARS = 4000

const llm = new ChatOpenAI({
  apiKey: OPENAI_API_KEY,
  model: AGENT_MODEL,
  temperature: 0.5
})


export const generateConversationAnalysis = async (caseRecord) => {
  const { background, thread } = await buildCaseContext(caseRecord)

  const prompt = renderTemplate("llm/analyze-conversation", {
    background,
    thread
  })

  const response = await llm.invoke([new HumanMessage(prompt)])
  const text = getLlmMessageText(response)
  if (!text) throw new Error("Could not analyze the conversation.")
  return text
}

const buildCaseContext = async (caseRecord) => {
  const assignedRoleLabel = loadTemplate("llm/assigned-role-label").trim()
  const admin = await fetchAdmin()
  const providerPrefix = `${admin.name}:`

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
  const isProvider = row.metadata.role === "assistant" && content.startsWith(providerPrefix)

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

