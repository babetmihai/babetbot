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
import {
  getFileRelayLabel,
  isRelayableFileMessage,
  relayProviderFile,
  relayProviderMessage
} from "../lib/relay.ts"
import {
  generateConversationAnalysis
} from "../lib/conversation-analysis.ts"
import { renderTemplate } from "../lib/templates.ts"
import { deleteForumTopic, isAdmin } from "../lib/telegram.ts"


const bot = new Composer()

bot.command("close", async (ctx, next) => {
  if (!isProviderCaseTopicMessage(ctx)) return next()

  const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, ctx.message.message_thread_id)
  if (!caseRecord) {
    const closedCase = await fetchClosedCaseInTopic(ctx.chat.id, ctx.message.message_thread_id)
    if (closedCase) return
    await replyInTopic(ctx, "No active case for this topic.")
    return
  }

  const allowed = await requireAdmin(ctx, "bot/not-assigned-close")
  if (!allowed) return

  await closeCase(caseRecord.id)
  await replyInTopic(ctx, renderTemplate("provider/case-closed-topic"))
})

bot.command("delete", async (ctx, next) => {
  if (!isProviderCaseTopicMessage(ctx)) return next()

  const caseRecord = await fetchClosedCaseInTopic(ctx.chat.id, ctx.message.message_thread_id)
  if (!caseRecord) {
    await replyInTopic(ctx, "No closed case for this topic.")
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
    await replyInTopic(ctx, "No active case for this topic.")
    return
  }

  const allowed = await requireAdmin(ctx, "bot/not-assigned-pay")
  if (!allowed) return

  if (!("text" in ctx.message)) return

  const parsed = parsePayArgs(ctx.message.text)
  if (!parsed) {
    await replyInTopic(ctx, "Usage: /pay 150 Payment description")
    return
  }

  const payment = await createProviderPaymentRequest(
    caseRecord,
    parsed.amountCents,
    parsed.description
  )

  const amountLabel = formatPaymentAmount(payment.amountCents, payment.currency)
  await replyInTopic(ctx, `Payment link sent to client (${amountLabel}).`)
})

bot.command("analyze", async (ctx, next) => {
  if (!isProviderCaseTopicMessage(ctx)) return next()

  const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, ctx.message.message_thread_id)
  if (!caseRecord) {
    await replyInTopic(ctx, "No active case for this topic.")
    return
  }

  const allowed = await requireAdmin(ctx, "bot/not-assigned-analyze")
  if (!allowed) return

  let pendingMessageId = null

  try {
    void ctx.sendChatAction("typing")
    const pending = await replyInTopic(ctx, "Analyzing conversation…")
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
    if (!pendingMessageId) {
      await replyInTopic(ctx, errorText)
      return
    }

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        pendingMessageId,
        undefined,
        errorText
      )
    } catch (error) {
      console.error("Error editing analyze failure message:", error.message)
      await replyInTopic(ctx, errorText)
    }
  }
})

bot.on(message("text"), async (ctx, next) => {
  if (!isProviderCaseTopicMessage(ctx)) return next()
  if (ctx.message.text.startsWith("/")) return

  if (ctx.from.id === ctx.botInfo.id) return

  const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, ctx.message.message_thread_id)
  if (!caseRecord) return

  if (!isAdmin(ctx.from.id.toString())) return

  await relayProviderMessage(caseRecord, ctx.message.text)
})

bot.on("message", async (ctx, next) => {
  if (!isProviderCaseTopicMessage(ctx)) return next()
  if (!isRelayableFileMessage(ctx.message)) return next()
  if (ctx.from.id === ctx.botInfo.id) return

  const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, ctx.message.message_thread_id)
  if (!caseRecord) return

  if (!isAdmin(ctx.from.id.toString())) return

  try {
    const label = getFileRelayLabel(ctx.message)
    await relayProviderFile(caseRecord, ctx.chat.id, ctx.message.message_id, label)
  } catch (error) {
    console.error("Error relaying provider file:", error)
    await ctx.reply(renderTemplate("bot/error"), {
      message_thread_id: ctx.message.message_thread_id
    })
  }
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
    const threadId = privateTopicId(ctx.chat, message)
    if (!threadId) {
      await ctx.answerCbQuery("Invalid analyze action.")
      return
    }

    const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, threadId)
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
      await ctx.reply(`Summary:\n\n${summary}`, { message_thread_id: threadId })
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
    const threadId = privateTopicId(ctx.chat, message)
    if (!threadId) {
      await ctx.answerCbQuery("Invalid refund action.")
      return
    }

    const caseRecord = await fetchActiveCaseInTopic(ctx.chat.id, threadId)
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
  await replyInTopic(ctx, renderTemplate(notAssignedTemplate))
  return false
}

const replyInTopic = (ctx, text) =>
  ctx.reply(text, { message_thread_id: ctx.message.message_thread_id })

const privateTopicId = (chat, message) => {
  if (chat.type !== "private") return null
  if (!message) return null
  if (!("message_thread_id" in message)) return null
  const threadId = message.message_thread_id
  if (!threadId) return null
  return threadId
}

const isProviderCaseTopicMessage = (ctx) =>
  Boolean(privateTopicId(ctx.chat, ctx.message))

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
