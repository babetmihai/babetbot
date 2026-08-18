import fs from "fs"
import { Composer } from "telegraf"
import { fetchActiveCase } from "../lib/cases.ts"
import { downloadTelegramFile } from "../lib/files.ts"
import rag, { KB_SCOPE, PROMPT_TYPES } from "../lib/rag.ts"
import {
  getFileRelayLabel,
  isRelayableFileMessage,
  relayClientFile
} from "../lib/relay.ts"
import { renderTemplate } from "../lib/templates.ts"
import { adminTelegramId, isAdmin } from "../lib/telegram.ts"


const bot = new Composer()

bot.on("message", async (ctx, next) => {
  if (ctx.chat.type !== "private") return next()
  if (ctx.message.message_thread_id) return next()
  if (!isRelayableFileMessage(ctx.message)) return next()

  try {
    const userId = ctx.from.id.toString()
    if (isAdmin(userId)) {
      await confirmKnowledgeBaseUpload(ctx)
      return
    }

    await relayClientUpload(ctx)
  } catch (error) {
    console.error("Error handling file:", error)
    await ctx.reply(renderTemplate("bot/error"))
  }
})

bot.on("callback_query", async (ctx, next) => {
  if (!("data" in ctx.callbackQuery)) return next()

  const data = ctx.callbackQuery.data
  if (!data.startsWith("kb:")) return next()

  if (!isAdmin(ctx.from.id.toString())) {
    await ctx.answerCbQuery(renderTemplate("bot/error"))
    return
  }

  const action = data.split(":")[1]
  const callbackMessage = ctx.callbackQuery.message
  const { reply_to_message: original } = callbackMessage || {}
  const { document: doc } = original || {}

  try {
    if (action === "cancel") {
      await ctx.answerCbQuery()
      await ctx.editMessageText(renderTemplate("admin/kb-cancelled"), {
        reply_markup: { inline_keyboard: [] }
      })
      return
    }

    if (action !== "confirm") {
      await ctx.answerCbQuery()
      return
    }

    if (!doc) {
      await ctx.answerCbQuery(renderTemplate("admin/kb-missing-file"))
      return
    }

    const fileName = doc.file_name || `file_${Date.now()}_${doc.file_id.slice(0, 8)}`
    await ctx.answerCbQuery()
    await ctx.editMessageText(renderTemplate("admin/kb-ingesting", { fileName }), {
      reply_markup: { inline_keyboard: [] }
    })

    const savePath = await downloadTelegramFile(doc.file_id, fileName)
    try {
      await rag.ingestPdf(adminTelegramId, "provider", savePath, {
        scope: KB_SCOPE.provider,
        type: PROMPT_TYPES.note
      })
    } finally {
      fs.unlinkSync(savePath)
    }

    await ctx.editMessageText(renderTemplate("admin/kb-added", { fileName }), {
      reply_markup: { inline_keyboard: [] }
    })
  } catch (error) {
    console.error("Error handling knowledge base upload:", error)
    await ctx.editMessageText(renderTemplate("bot/error"), {
      reply_markup: { inline_keyboard: [] }
    })
  }
})

export default bot

const confirmKnowledgeBaseUpload = async (ctx) => {
  const { document: doc } = ctx.message
  if (!doc) return

  if (doc.mime_type !== "application/pdf") {
    await ctx.reply(renderTemplate("admin/kb-pdf-only"))
    return
  }

  const fileName = doc.file_name || `file_${Date.now()}_${doc.file_id.slice(0, 8)}`
  await ctx.reply(renderTemplate("admin/kb-confirm", { fileName }), {
    reply_parameters: { message_id: ctx.message.message_id },
    reply_markup: {
      inline_keyboard: [[
        { text: "Add", callback_data: "kb:confirm" },
        { text: "Cancel", callback_data: "kb:cancel" }
      ]]
    }
  })
}

const relayClientUpload = async (ctx) => {
  const userId = ctx.from.id.toString()
  const activeCase = await fetchActiveCase(userId)
  if (!activeCase) {
    await ctx.reply(renderTemplate("client/file-before-connected"))
    return
  }

  const label = getFileRelayLabel(ctx.message)
  const { document, photo } = ctx.message || {}
  const isPdf = document && document.mime_type === "application/pdf"
  const withAnalyze = Boolean(photo) || Boolean(isPdf)
  await relayClientFile(activeCase, ctx.chat.id, ctx.message.message_id, label, withAnalyze)
  await ctx.reply(renderTemplate("client/file-sent"))
}
