import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { SUPABASE_POSTGRES_URL } from "../config.js"


if (!SUPABASE_POSTGRES_URL) {
  throw new Error("Missing required env: SUPABASE_POSTGRES_URL (Postgres checkpointer for agent threads)")
}

const checkpointer = PostgresSaver.fromConnString(SUPABASE_POSTGRES_URL, {
  schema: "public"
})

await checkpointer.setup()

export const resetAgentThread = (threadId) => checkpointer.deleteThread(threadId)

export default checkpointer
