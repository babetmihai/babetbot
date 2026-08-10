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
} from "../goals.ts"
import { UserGoalSchema, type TAgentRuntime } from "../agent.ts"
import { loadTemplate } from "../templates.ts"

const GOAL_COLLECTION_RULES = loadTemplate("agent/goal-collection-rules").trim()

const stateSchema = z.object({
  userGoals: z.array(UserGoalSchema).default([])
})

const updateUserGoal = createUpdateUserGoalTool()

const memoryMiddleware = createMiddleware({
  name: "memoryMiddleware",
  stateSchema,
  tools: [updateUserGoal],
  beforeAgent: async (_state, runtime: TAgentRuntime) => {
    const userGoals = await refreshUserGoals(runtime.context.userId, runtime.context.userMessage)
    return { userGoals }
  },
  afterAgent: async (_state, runtime: TAgentRuntime) => {
    const userGoals = await refreshUserGoals(runtime.context.userId, runtime.context.userMessage)
    return { userGoals }
  },
  wrapModelCall: async (request, handler) => {
    // @ts-expect-error langchain contextSchema is not reflected on runtime.context
    const { userId, userMessage } = request.runtime.context
    const userGoals = await refreshUserGoals(userId, userMessage)

    return handler({
      ...request,
      state: { ...request.state, userGoals },
      systemMessage: request.systemMessage.concat(
        `\n\n${formatUserGoalsPrompt(userGoals)}`
      )
    })
  }
})

export default memoryMiddleware

const refreshUserGoals = async (userId, latestMessage = "") => {
  let userGoals = await mergeUserGoals(String(userId))
  userGoals = await syncDerivedGoals(String(userId), userGoals, latestMessage)
  return userGoals
}

const formatUserGoalsPrompt = (userGoals) => {
  if (!userGoals.length) return ""

  const missing = getMissingGoals(userGoals)
  const nextGoal = missing[0]
  const known = formatGoalContextForTools(userGoals)
  const requiredKeys = getRequiredIntakeGoals(userGoals).map((goal) => goal.key)
  const intakeComplete = areIntakeGoalsComplete(userGoals, requiredKeys)

  let guidance = `\n\n## Intake goals\n${GOAL_COLLECTION_RULES}\n`
  for (const goal of userGoals.filter((item) => item.goalType === "derive")) {
    guidance += `${goal.label} is inferred from the discussion — do not ask the client for it.\n`
  }

  if (known) guidance += `Saved: ${known}\n`
  if (nextGoal) {
    guidance += `Next goal to collect: ${nextGoal.key} (${nextGoal.label}) — ${nextGoal.description}`
    if (nextGoal.prompt) guidance += ` Ask using: "${nextGoal.prompt}"`
    guidance += "\nOnly save this goal if the latest client message clearly provides it; otherwise ask for it now.\n"
    if (missing.length > 1) {
      guidance += `Still waiting after that: ${missing.slice(1).map((goal) => goal.key).join(", ")}\n`
    }
  }
  if (intakeComplete) {
    guidance += loadTemplate("agent/intake-complete-guidance")
  }

  return guidance
}
