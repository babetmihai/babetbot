import { Composer } from "telegraf"
import { message } from "telegraf/filters"
import {
  areIntakeGoalsComplete,
  formatGoalContextForTools,
  mergeUserGoals,
  syncDerivedGoals
} from "../lib/goals.ts"
import rag from "../lib/rag.ts"
import {
  escalateToProvider,
  fetchActiveCase
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
  if (ctx.message.message_thread_id) return

  const stopTyping = startTyping(ctx)

  try {
    const textMessage = ctx.message.text

    const activeCase = await fetchActiveCase(userId)
    if (activeCase) {
      await relayClientMessage(activeCase, textMessage)
      return
    }

    const userGoals = await mergeUserGoals(userId)
    const intakeComplete = areIntakeGoalsComplete(userGoals)
    if (intakeComplete) {
      await tryConnectClient(ctx, userId, ctx.chat.id, userGoals, textMessage)
      return
    }

    await runIntakeAgent(ctx, userId, ctx.chat.id, textMessage, userGoals)
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
  const clientMessage = await escalateToProvider(userId, chatId, userGoals)
  await sendReply(ctx, userId, userMessage, clientMessage)
}

const tryConnectIfIntakeJustCompleted = async (ctx, userId, chatId, userMessage, userGoals) => {
  const intakeJustCompleted = areIntakeGoalsComplete(userGoals)
  if (!intakeJustCompleted) return false
  await tryConnectClient(ctx, userId, chatId, userGoals, userMessage)
  return true
}

const loadGoalsForEscalation = async (userId, userMessage) => {
  const userGoals = await mergeUserGoals(userId)
  return syncDerivedGoals(userId, userGoals, userMessage)
}

const runIntakeAgent = async (ctx, userId, chatId, textMessage, userGoals) => {
  const goalContext = formatGoalContextForTools(userGoals)
  const agentConfig = {
    context: { userId, chatId, goalContext, userMessage: textMessage },
    configurable: { thread_id: userId },
    recursionLimit: AGENT_RECURSION_LIMIT
  }

  let result
  try {
    result = await withTimeout(
      invokeIntakeAgent(textMessage, userGoals, agentConfig),
      AGENT_TIMEOUT_MS
    )
  } catch (error) {
    const errorCode = error.lc_error_code || error.cause?.lc_error_code
    if (errorCode === "INVALID_TOOL_RESULTS") {
      await checkpointer.deleteThread(userId)
      result = await withTimeout(
        invokeIntakeAgent(textMessage, userGoals, agentConfig),
        AGENT_TIMEOUT_MS
      )
    } else if (errorCode === "GRAPH_RECURSION_LIMIT") {
      await checkpointer.deleteThread(userId)
      const recoveredGoals = await loadGoalsForEscalation(userId, textMessage)
      const handled = await tryConnectIfIntakeJustCompleted(
        ctx,
        userId,
        chatId,
        textMessage,
        recoveredGoals
      )
      if (handled) return
      await sendReply(ctx, userId, textMessage, renderTemplate("client/agent-stuck"))
      return
    } else {
      throw error
    }
  }

  const latestGoals = await loadGoalsForEscalation(userId, textMessage)
  const handled = await tryConnectIfIntakeJustCompleted(
    ctx,
    userId,
    chatId,
    textMessage,
    latestGoals
  )
  if (handled) return

  const reply = getAgentReply(result.messages)
  if (reply) {
    await sendReply(ctx, userId, textMessage, reply)
    return
  }

  await sendReply(ctx, userId, textMessage, renderTemplate("client/agent-no-reply"))
}
