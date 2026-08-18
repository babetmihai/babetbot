import { tool } from "@langchain/core/tools"
import { z } from "zod"
import rag, { KB_SCOPE, PROMPT_TYPES } from "../rag.ts"
import { getMissingGoals, mergeUserGoals } from "../goals.ts"
import type { TToolConfig } from "../agent.ts"


export default tool(async ({ content, topic }, config: TToolConfig) => {
  try {
    const userId = config.context.userId
    console.log("save_user_information", userId, topic, content)

    const userGoals = await mergeUserGoals(userId)
    const missing = getMissingGoals(userGoals)
    if (missing.length) {
      return `Not saved. Missing intake goals: ${missing.map((goal) => goal.key).join(", ")}. Call update_user_goal for those instead. Only use save_user_information after intake goals are saved.`
    }

    await rag.add(userId, content, "user", {
      type: PROMPT_TYPES.note,
      scope: KB_SCOPE.client,
      topic: topic ?? null,
      source: "conversation"
    })

    return `Saved intake note: "${content}"`
  } catch (error) {
    console.error("save_user_information error", error)
    return `Failed to save intake note: ${error.message}`
  }
}, {
  name: "save_user_information",
  description: `Save extra intake notes about the client for future recall.
Use for details that are not tracked intake goals (those use update_user_goal).
Keep content concise — do not repeat fields already in goalContext.
Never use this for intake goals — those must use update_user_goal.`,
  schema: z.object({
    content: z.string().describe(
      "A concise, factual statement about the client, written so it can be retrieved later."
    ),
    topic: z.string().optional().describe(
      "Optional short label, e.g. 'deadline', 'documents'."
    )
  })
})
