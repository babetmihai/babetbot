import { tool } from "@langchain/core/tools"
import { z } from "zod"
import rag from "../rag.ts"
import type { TToolConfig } from "../agent.ts"


export default tool(async ({ query, k = 6 }, config: TToolConfig) => {
  try {
    const userId = config.context.userId
    const knownGoals = (config.context.goalContext || "").trim()
    const searchQuery = knownGoals ? `${query.trim()} [${knownGoals}]` : query.trim()
    console.log("rag_user_tool", userId, searchQuery, k)

    const results = await rag.listForIntake(userId, searchQuery, k)

    if (!results.length) {
      return "NO_RELEVANT_RESULTS: No relevant information found in the knowledge base."
    }

    return results.map((doc) => doc.pageContent.trim()).join("\n\n")
  } catch (error) {
    console.error("rag_user_tool error", error)
    return `User information retrieval error: ${error.message}`
  }
}, {
  name: "user_information_retrieval",
  description: "Retrieve information from the knowledge base (FAQ PDFs) and client intake notes. Use for questions about the provider during intake.",
  schema: z.object({
    query: z.string().describe("Short, specific query. Do not repeat intake fields already in goalContext."),
    k: z.number().optional().default(6).describe("Number of results to return (4–8 is usually best)")
  })
})
