import { tool } from "@langchain/core/tools"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import { z } from "zod"
import _ from "lodash"
import db, { deleteQueryDocs } from "./firestore.js"
import rag from "./rag.js"
import { CONSENT_YES_VALUE, KB_SCOPE, OPENAI_API_KEY, PROMPT_TYPES } from "../config.js"
import { type TToolConfig } from "./agent.js"
import { loadJsonTemplate, loadTemplate } from "./templates.js"


export type GoalDefinition = {
  key: string
  label: string
  description: string
  prompt?: string | null
  priority?: number
  goalType?: string
  targetGoalKey?: string | null
}

export type UserGoal = GoalDefinition & {
  value: string | null
}


export const DECLINED_GOAL_VALUE = "declined"

export const isDeclinedGoalValue = (value) => {
  const normalized = (value || "").trim().toLowerCase()
  return normalized === DECLINED_GOAL_VALUE
}

const GOAL_DEFINITIONS: GoalDefinition[] = loadJsonTemplate("goals/definitions")

export const fetchUserGoalValues = async (userId) => {
  const snapshot = await db.collection("user_goal_values")
    .where("userId", "==", userId)
    .get()

  return _.fromPairs(snapshot.docs.map((doc) => {
    const data = doc.data()
    return [data.goalKey, data.value]
  }))
}

export const mergeUserGoals = async (userId) => {
  const values = await fetchUserGoalValues(userId)

  return GOAL_DEFINITIONS.map((definition) => ({
    ...applyGoalTemplatePrompt(definition),
    value: values[definition.key] ?? null
  }))
}

export const getCollectGoals = (userGoals) =>
  _.sortBy(
    userGoals.filter((goal) => (goal.goalType || "collect") === "collect"),
    (goal) => goal.priority ?? 0
  )

export const getRequiredIntakeGoals = (userGoals) =>
  _.sortBy(
    userGoals.filter((goal) => {
      const goalType = goal.goalType || "collect"
      return goalType === "collect" || goalType === "derive"
    }),
    (goal) => goal.priority ?? 0
  )

export const getMissingGoals = (userGoals) =>
  getCollectGoals(userGoals).filter((goal) => !trimmedGoalValue(goal))

export const getNextGoalToCollect = (userGoals) =>
  getMissingGoals(userGoals)[0] ?? null

export const isConsentGiven = (value) => {
  const normalized = (value || "").trim().toLowerCase()
  return normalized === CONSENT_YES_VALUE
}

export const getGoalByKey = (userGoals, key) =>
  userGoals.find((goal) => goal.key === key)

export const getGoalValue = (userGoals, key) => {
  const { value } = getGoalByKey(userGoals, key) || {}
  return (value || "").trim()
}

export const areIntakeGoalsComplete = (userGoals, requiredKeys) =>
  requiredKeys.every((key) => {
    const value = getGoalValue(userGoals, key)
    if (!value) return false
    if (key === "consent") {
      if (isDeclinedGoalValue(value)) return false
      return isConsentGiven(value)
    }
    return true
  })

export const buildIntakeSummary = (userGoals) =>
  getRequiredIntakeGoals(userGoals)
    .filter((goal) => trimmedGoalValue(goal))
    .map((goal) => `${goal.label}: ${trimmedGoalValue(goal)}`)
    .join("\n")

export const validateGoalValue = (goalKey, value) => {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (goalKey === "consent") {
    const lower = trimmed.toLowerCase()
    if (["yes", "y", "agree", "i agree", "accepted", "accept"].includes(lower)) return CONSENT_YES_VALUE
    if (["no", "n", "decline", "declined", "disagree", "i do not agree"].includes(lower)) return DECLINED_GOAL_VALUE
    return null
  }

  if (goalKey === "description") {
    if (!isSubstantiveDescription(trimmed)) return null
  }

  return trimmed
}

export const formatGoalContextForTools = (userGoals) =>
  getRequiredIntakeGoals(userGoals)
    .filter((goal) => trimmedGoalValue(goal) && !isDeclinedGoalValue(goal.value))
    .map((goal) => `${goal.key}=${trimmedGoalValue(goal)}`)
    .join(", ")

export const syncDerivedGoals = async (userId, userGoals) => {
  let nextGoals = userGoals

  for (const goal of userGoals.filter((item) => item.goalType === "derive")) {
    if (trimmedGoalValue(goal)) continue

    const sourceKey = goal.targetGoalKey
    if (!sourceKey) continue

    const sourceValue = getGoalValue(nextGoals, sourceKey)
    if (!sourceValue) continue

    const inferred = await inferDerivedGoalValue(sourceValue)
    if (!inferred) continue

    await setUserGoalValue(userId, goal.key, inferred, goal)
    nextGoals = await mergeUserGoals(userId)
  }

  return nextGoals
}

export const resetClientIntake = async (userId) => {
  await deleteQueryDocs(db.collection("user_goal_values").where("userId", "==", userId))
  await rag.deleteByFilter(userId, { scope: KB_SCOPE.client })
}

export const setUserGoalValue = async (userId, goalKey, value, goal) => {
  const docId = `${userId}_${goalKey}`
  await db.collection("user_goal_values").doc(docId).set({
    userId,
    goalKey,
    value,
    updatedAt: new Date().toISOString()
  })

  const ragGoal = goal ?? { key: goalKey, label: goalKey }
  await rag.replaceGoal(userId, goalKey, buildGoalRagContent(ragGoal, value), {
    type: PROMPT_TYPES.goal,
    goal_key: goalKey,
    topic: ragGoal.label,
    scope: KB_SCOPE.client,
    source: "profile_goal"
  })
}

export const createUpdateUserGoalTool = () => tool(async ({ goalKey, value }, config: TToolConfig) => {
  try {
    const userId = config.context.userId

    const userGoals = await mergeUserGoals(userId)
    const definition = userGoals.find((item) => item.key === goalKey)

    if (!definition) {
      return `Unknown goal key "${goalKey}". Valid keys: ${userGoals.map((item) => item.key).join(", ")}`
    }

    const normalized = validateGoalValue(goalKey, value)
    if (!normalized) {
      if (goalKey === "consent") {
        return loadTemplate("agent/consent-validation-hint").trim()
      }
      if (goalKey === "description") {
        return `Could not save "${definition.label}" — the client should describe this in their own words.`
      }
      return `Could not save "${definition.label}" from that value. Ask the client again.`
    }

    await setUserGoalValue(userId, goalKey, normalized, definition)
    const updatedGoals = await mergeUserGoals(userId)
    const isDeriveSource = updatedGoals.some((goal) => goal.goalType === "derive" && goal.targetGoalKey === goalKey)
    if (isDeriveSource) {
      await syncDerivedGoals(userId, updatedGoals)
    }

    return `Saved user goal "${definition.label}": "${value}"`
  } catch (error) {
    console.error("update_user_goal error", error)
    return `Failed to update user goal: ${error.message}`
  }
}, {
  name: "update_user_goal",
  description: "Save or update an intake goal. Call on every client message when their reply completes or declines any missing goal (use value \"declined\" for refusals).",
  schema: z.object({
    goalKey: z.string().describe("The goal key from the user's goal list."),
    value: z.string().describe("The value to store for this user and goal.")
  })
})

const trimmedGoalValue = (goal) => (goal.value || "").trim()

const GENERIC_DESCRIPTION_PATTERNS = [
  /^i am a customer\.?$/i,
  /^i'm a customer\.?$/i,
  /^as a customer\.?$/i,
  /^a customer\.?$/i,
  /^i am a client\.?$/i,
  /^i'm a client\.?$/i,
  /^as a client\.?$/i,
  /^a client\.?$/i,
  /^hello\.?$/i,
  /^hi\.?$/i
]

const isSubstantiveDescription = (value) => {
  if (value.length < 15) return false

  const words = value.split(/\s+/).filter(Boolean)
  if (words.length < 3) return false

  const lower = value.toLowerCase()
  const isGeneric = GENERIC_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(lower))
  return !isGeneric
}

const buildGoalRagContent = (goal, value) =>
  isDeclinedGoalValue(value)
    ? `User declined to share their ${goal.label.toLowerCase()}.`
    : `User's ${goal.label.toLowerCase()}: ${value.trim()}`

const inferDerivedGoalValue = async (sourceValue) => {
  const llm = new ChatOpenAI({
    apiKey: OPENAI_API_KEY,
    model: process.env.AGENT_MODEL ?? "gpt-4o-mini",
    temperature: 0
  })

  const response = await llm.invoke([
    new SystemMessage(loadTemplate("llm/infer-practice-area")),
    new HumanMessage(sourceValue)
  ])

  const picked = typeof response.content === "string" ? response.content.trim() : ""
  if (!picked) return null
  return picked.slice(0, 100)
}

const applyGoalTemplatePrompt = (definition) => {
  try {
    return { ...definition, prompt: loadTemplate(`goals/${definition.key}`).trim() }
  } catch {
    return definition
  }
}
