import { Composer } from "telegraf"
import { message } from "telegraf/filters"
import {
  formatGoalContextForTools,
  mergeUserGoals,
  syncDerivedGoals
} from "../lib/goals.ts"
import rag from "../lib/rag.ts"
import {
  escalateToProvider,
  fetchActiveCase,
  isReadyForEscalation
} from "../lib/cases.ts"
import { relayClientMessage } from "../lib/relay.ts"
import { renderTemplate } from "../lib/templates.ts"
import {
  AGENT_RECURSION_LIMIT,
  AGENT_TIMEOUT_MS,
  getAgentReply,
  invokeIntakeAgent,
  withTimeout
} from "../lib/agent.ts"
import checkpointer from "../lib/checkpointer.ts"


const bot = new Composer()

bot.on(message("text"), async (ctx) => {
  const userId = ctx.from.id.toString()
  if (ctx.message.text.startsWith("/")) return
  if (ctx.chat.type !== "private") return

  const stopTyping = startTyping(ctx)

  try {
    const textMessage = ctx.message.text

    const activeCase = await fetchActiveCase(userId)
    if (activeCase) {
      await relayClientMessage(activeCase, textMessage)
      await ctx.reply(renderTemplate("client/relay-sent"))
      return
    }

    const userGoals = await mergeUserGoals(userId)
    const syncedGoals = await syncDerivedGoals(userId, userGoals, textMessage)

    if (isReadyForEscalation(syncedGoals)) {
      const handled = await tryConnectClient(ctx, userId, ctx.chat.id, syncedGoals, textMessage)
      if (handled) return
    }

    await runIntakeAgent(ctx, userId, ctx.chat.id, textMessage, syncedGoals)
  } catch (error) {
    console.error("Error processing message:", error)
    await ctx.reply(renderTemplate("bot/error"))
  } finally {
    stopTyping()
  }
})

export default bot

const startTyping = (ctx) => {
  void ctx.sendChatAction("typing")
  const interval = setInterval(() => {
    void ctx.sendChatAction("typing")
  }, 4000)
  return () => clearInterval(interval)
}

const sendReply = async (ctx, userId, userMessage, reply) => {
  const text = reply.trim()
  await ctx.reply(text)
  void rag.saveConversationTurn(userId, "user", userMessage)
  void rag.saveConversationTurn(userId, "assistant", text)
}

const tryConnectClient = async (ctx, userId, chatId, userGoals, userMessage) => {
  if (!isReadyForEscalation(userGoals)) return false

  const clientMessage = await escalateToProvider(userId, chatId, userGoals)
  await sendReply(ctx, userId, userMessage, clientMessage)
  return true
}

const runIntakeAgent = async (ctx, userId, chatId, textMessage, syncedGoals) => {
  const wasReadyForEscalation = isReadyForEscalation(syncedGoals)

  const goalContext = formatGoalContextForTools(syncedGoals)
  const agentConfig = {
    context: { userId, chatId, goalContext, userMessage: textMessage },
    configurable: { thread_id: userId },
    recursionLimit: AGENT_RECURSION_LIMIT
  }

  let result
  try {
    result = await withTimeout(
      invokeIntakeAgent(textMessage, syncedGoals, agentConfig),
      AGENT_TIMEOUT_MS
    )
  } catch (error) {
    const errorCode = error.lc_error_code || error.cause?.lc_error_code
    if (errorCode === "INVALID_TOOL_RESULTS") {
      await checkpointer.deleteThread(userId)
      result = await withTimeout(
        invokeIntakeAgent(textMessage, syncedGoals, agentConfig),
        AGENT_TIMEOUT_MS
      )
    } else if (errorCode === "GRAPH_RECURSION_LIMIT") {
      await checkpointer.deleteThread(userId)
      const recoveredGoalsBase = await mergeUserGoals(userId)
      const recoveredGoals = await syncDerivedGoals(userId, recoveredGoalsBase, textMessage)
      const intakeJustCompleted = !wasReadyForEscalation && isReadyForEscalation(recoveredGoals)
      if (intakeJustCompleted) {
        const handled = await tryConnectClient(ctx, userId, chatId, recoveredGoals, textMessage)
        if (handled) return
      }
      await sendReply(ctx, userId, textMessage, renderTemplate("client/agent-stuck"))
      return
    } else {
      throw error
    }
  }

  let updatedGoals = result.userGoals
  if (!updatedGoals.length) {
    updatedGoals = await mergeUserGoals(userId)
  }
  updatedGoals = await syncDerivedGoals(userId, updatedGoals, textMessage)

  const intakeJustCompleted = !wasReadyForEscalation && isReadyForEscalation(updatedGoals)
  if (intakeJustCompleted) {
    const handled = await tryConnectClient(ctx, userId, chatId, updatedGoals, textMessage)
    if (handled) return
  }

  const reply = getAgentReply(result.messages)
  if (reply) {
    await sendReply(ctx, userId, textMessage, reply)
    return
  }

  await sendReply(ctx, userId, textMessage, renderTemplate("client/agent-no-reply"))
}
