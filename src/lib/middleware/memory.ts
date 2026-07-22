import { createMiddleware } from "langchain"
import { z } from "zod"
import {
  areIntakeGoalsComplete,
  createUpdateUserGoalTool,
  formatGoalContextForTools,
  getMissingGoals,
  getRequiredIntakeGoals,
  mergeUserGoals,
  syncDerivedGoals
} from "../goals.js"
import { type TAgentRuntime } from "../agent.js"
import { INTAKE_FEE_AMOUNT_CENTS, STRIPE_CURRENCY } from "../../config.js"
import { loadTemplate, renderTemplate } from "../templates.js"

const GOAL_COLLECTION_RULES = loadTemplate("agent/goal-collection-rules").trim()

const UserGoalSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  prompt: z.string().nullable().optional(),
  value: z.string().nullable().default(null),
  priority: z.number().optional()
})

const stateSchema = z.object({
  userGoals: z.array(UserGoalSchema).default([])
})

const updateUserGoal = createUpdateUserGoalTool()

const memoryMiddleware = createMiddleware({
  name: "memoryMiddleware",
  stateSchema,
  tools: [updateUserGoal],
  beforeAgent: async (_state, runtime: TAgentRuntime) => {
    const userGoals = await refreshUserGoals(runtime)
    return { userGoals }
  },
  afterAgent: async (_state, runtime: TAgentRuntime) => {
    const userGoals = await refreshUserGoals(runtime)
    return { userGoals }
  },
  wrapModelCall: (request, handler) => {
    const userGoals = request.state.userGoals

    return handler({
      ...request,
      systemMessage: request.systemMessage.concat(
        `\n\n${formatUserGoalsPrompt(userGoals)}`
      )
    })
  }
})

export default memoryMiddleware

const refreshUserGoals = async (runtime: TAgentRuntime) => {
  const userId = runtime.context.userId || runtime.configurable.thread_id
  if (!userId) return []

  let userGoals = await mergeUserGoals(String(userId))
  userGoals = await syncDerivedGoals(String(userId), userGoals)
  return userGoals
}

const formatUserGoalsPrompt = (userGoals) => {
  if (!userGoals.length) return ""

  const missing = getMissingGoals(userGoals)
  const known = formatGoalContextForTools(userGoals)
  const requiredKeys = getRequiredIntakeGoals(userGoals).map((goal) => goal.key)
  const intakeComplete = areIntakeGoalsComplete(userGoals, requiredKeys)

  let guidance = `\n\n## Intake goals\n${GOAL_COLLECTION_RULES}\n`
  guidance += "Practice area is inferred from description — do not ask the client for it.\n"

  if (known) guidance += `Saved: ${known}\n`
  if (missing.length) {
    guidance += "Missing — check the latest client message for each of these:\n"
    for (const goal of missing) {
      guidance += `- ${goal.key} (${goal.label}): ${goal.description}`
      if (goal.prompt) guidance += ` Suggested wording: "${goal.prompt}"`
      guidance += "\n"
    }
    const consentMissing = missing.some((goal) => goal.key === "consent")
    if (consentMissing) {
      const amountLabel = `${(INTAKE_FEE_AMOUNT_CENTS / 100).toFixed(2)} ${STRIPE_CURRENCY.toUpperCase()}`
      guidance += renderTemplate("agent/consent-fee-guidance", { amountLabel })
    }
  }
  if (intakeComplete) {
    guidance += loadTemplate("agent/intake-complete-guidance")
  }

  return guidance
}
