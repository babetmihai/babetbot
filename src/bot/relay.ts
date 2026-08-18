import { Composer } from "telegraf"
import { message } from "telegraf/filters"
import {
  acceptCaseOffer,
  closeCase,
  declineCaseOffer,
  fetchActiveCaseInTopic,
  fetchClosedCaseInTopic
} from "../lib/cases.ts"
import { createProviderPaymentRequest, formatPaymentAmount, refundPaymentAsProvider } from "../lib/payments.ts"
import { analyzeTelegramFileMessage } from "../lib/files.ts"
import { relayProviderMessage } from "../lib/relay.ts"
import {
  generateConversationAnalysis
} from "../lib/conversation-analysis.ts"
import { renderTemplate } from "../lib/templates.ts"
import { deleteForumTopic, fetchBotId, isAdmin } from "../lib/telegram.ts"


const bot = new Composer()

bot.command("close", async (ctx, next) => {
  if (!isProviderCaseTopicMessage(ctx)) return next()

  const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, ctx.message.message_thread_id)
  if (!caseRecord) {
    await ctx.reply("No active case for this topic.")
    return
  }

  const allowed = await requireAdmin(ctx, "bot/not-assigned-close")
  if (!allowed) return

  await closeCase(caseRecord.id)
})

bot.command("delete", async (ctx, next) => {
  if (!isProviderCaseTopicMessage(ctx)) return next()

  const caseRecord = await fetchClosedCaseInTopic(ctx.chat.id, ctx.message.message_thread_id)
  if (!caseRecord) {
    await ctx.reply("No closed case for this topic.")
    return
  }

  const allowed = await requireAdmin(ctx, "bot/not-assigned-delete")
  if (!allowed) return

  await deleteForumTopic(caseRecord.groupChatId, caseRecord.topicId)
})

bot.command("pay", async (ctx, next) => {
  if (!isProviderCaseTopicMessage(ctx)) return next()

  const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, ctx.message.message_thread_id)
  if (!caseRecord) {
    await ctx.reply("No active case for this topic.")
    return
  }

  const allowed = await requireAdmin(ctx, "bot/not-assigned-pay")
  if (!allowed) return

  if (!("text" in ctx.message)) return

  const parsed = parsePayArgs(ctx.message.text)
  if (!parsed) {
    await ctx.reply("Usage: /pay 150 Payment description")
    return
  }

  const payment = await createProviderPaymentRequest(
    caseRecord,
    parsed.amountCents,
    parsed.description
  )

  const amountLabel = formatPaymentAmount(payment.amountCents, payment.currency)
  await ctx.reply(`Payment link sent to client (${amountLabel}).`)
})

bot.command("analyze", async (ctx, next) => {
  if (!isProviderCaseTopicMessage(ctx)) return next()

  const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, ctx.message.message_thread_id)
  if (!caseRecord) {
    await ctx.reply("No active case for this topic.")
    return
  }

  const allowed = await requireAdmin(ctx, "bot/not-assigned-analyze")
  if (!allowed) return

  const topicExtra = { message_thread_id: ctx.message.message_thread_id }
  let pendingMessageId = null

  try {
    void ctx.sendChatAction("typing")
    const pending = await ctx.reply("Analyzing conversation…", topicExtra)
    pendingMessageId = pending.message_id

    const analysis = await generateConversationAnalysis(caseRecord)
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      pendingMessageId,
      undefined,
      analysis.trim()
    )
  } catch (error) {
    console.error("Error analyzing conversation:", error)
    const errorText = renderTemplate("bot/error")
    if (pendingMessageId) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        pendingMessageId,
        undefined,
        errorText
      ).catch(() => {})
    } else {
      await ctx.reply(errorText, topicExtra)
    }
  }
})

bot.on(message("text"), async (ctx, next) => {
  if (!isProviderCaseTopicMessage(ctx)) return next()
  if (ctx.message.text.startsWith("/")) return next()

  const botId = await fetchBotId()
  if (ctx.from.id === botId) return

  const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, ctx.message.message_thread_id)
  if (!caseRecord) return next()

  if (!isAdmin(ctx.from.id.toString())) return next()

  await relayProviderMessage(caseRecord, ctx.message.text)
})

bot.on("callback_query", async (ctx, next) => {
  if (!("data" in ctx.callbackQuery)) return next()

  const data = ctx.callbackQuery.data

  if (data.startsWith("offer:")) {
    const parts = data.split(":")
    const offerId = parts[1]
    const action = parts[2]

    if (!offerId || !action) {
      await ctx.answerCbQuery("Invalid offer action.")
      return
    }

    try {
      let result
      if (action === "accept") {
        result = await acceptCaseOffer(offerId, ctx.from.id.toString())
      } else if (action === "decline") {
        result = await declineCaseOffer(offerId, ctx.from.id.toString())
      } else {
        result = { toast: "Unknown action." }
      }
      await ctx.answerCbQuery(result.toast)
      try {
        await ctx.deleteMessage()
      } catch (error) {
        console.error("delete offer message error", error.message)
      }
    } catch (error) {
      console.error("Error handling case offer:", error)
      await ctx.answerCbQuery(renderTemplate("bot/error"))
    }
    return
  }

  if (data.startsWith("analyze:")) {
    const caseId = data.split(":")[1]
    if (!caseId) {
      await ctx.answerCbQuery("Invalid analyze action.")
      return
    }

    const message = ctx.callbackQuery.message
    const hasTopic = message && "message_thread_id" in message && message.message_thread_id
    const isPrivateTopic = ctx.chat.type === "private" && hasTopic
    if (!isPrivateTopic) {
      await ctx.answerCbQuery("Invalid analyze action.")
      return
    }

    const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, message.message_thread_id)
    if (!caseRecord || caseRecord.id !== caseId) {
      await ctx.answerCbQuery("No active case for this file.")
      return
    }

    if (!isAdmin(ctx.from.id.toString())) {
      await ctx.answerCbQuery(renderTemplate("bot/not-assigned-analyze-file"))
      return
    }

    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: "Analyzing…", callback_data: data }]]
      })
      const summary = await analyzeTelegramFileMessage(message, caseRecord)
      await answerCbQuerySafe(ctx)
      await ctx.reply(`Summary:\n\n${summary}`, { message_thread_id: message.message_thread_id })
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
    } catch (error) {
      console.error("Error analyzing file:", error)
      await answerCbQuerySafe(ctx, renderTemplate("bot/error"))
    }
    return
  }

  if (data.startsWith("refund:")) {
    const paymentId = data.split(":")[1]
    if (!paymentId) {
      await ctx.answerCbQuery("Invalid refund action.")
      return
    }

    const message = ctx.callbackQuery.message
    const hasTopic = message && "message_thread_id" in message && message.message_thread_id
    const isPrivateTopic = ctx.chat.type === "private" && hasTopic
    if (!isPrivateTopic) {
      await ctx.answerCbQuery("Invalid refund action.")
      return
    }

    const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, message.message_thread_id)
    if (!caseRecord) {
      await ctx.answerCbQuery("No active case for this topic.")
      return
    }

    try {
      const result = await refundPaymentAsProvider(paymentId, ctx.from.id.toString(), caseRecord)
      await ctx.answerCbQuery(result.toast)

      if (result.editText && "message" in ctx.callbackQuery) {
        await ctx.editMessageText(result.editText, {
          reply_markup: { inline_keyboard: [] }
        })
      }
    } catch (error) {
      console.error("Error refunding payment:", error)
      await ctx.answerCbQuery(renderTemplate("bot/error"))
    }
    return
  }

  return next()
})

export default bot

const requireAdmin = async (ctx, notAssignedTemplate) => {
  if (isAdmin(ctx.from.id.toString())) return true
  await ctx.reply(renderTemplate(notAssignedTemplate))
  return false
}

const isProviderCaseTopicMessage = (ctx) => {
  const isPrivate = ctx.chat.type === "private"
  const message = ctx.message
  const hasTopic = message && "message_thread_id" in message && message.message_thread_id
  return isPrivate && hasTopic
}

const parsePayArgs = (text) => {
  const body = text.replace(/^\/pay(@\w+)?\s*/i, "").trim()
  if (!body) return null

  const spaceIndex = body.indexOf(" ")
  const amountText = spaceIndex === -1 ? body : body.slice(0, spaceIndex)
  const description = spaceIndex === -1 ? "Payment request" : body.slice(spaceIndex + 1).trim()

  const amount = Number(amountText.replace(",", "."))
  if (!amount || amount <= 0) return null

  const amountCents = Math.round(amount * 100)
  if (amountCents <= 0) return null

  return { amountCents, description: description || "Payment request" }
}

const answerCbQuerySafe = async (ctx, text = null) => {
  try {
    if (text) {
      await ctx.answerCbQuery(text)
    } else {
      await ctx.answerCbQuery()
    }
    return
  } catch {
    if (!text) return

    const message = ctx.callbackQuery.message
    const threadId = message && "message_thread_id" in message && message.message_thread_id
    if (threadId) {
      await ctx.reply(text, { message_thread_id: threadId })
    }
  }
}
