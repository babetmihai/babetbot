import fs from "fs"
import { Composer } from "telegraf"
import { message } from "telegraf/filters"
import { fetchActiveCase } from "../lib/cases.ts"
import { downloadTelegramFile } from "../lib/files.ts"
import rag, { KB_SCOPE, PROMPT_TYPES } from "../lib/rag.ts"
import { relayClientFile } from "../lib/relay.ts"
import { renderTemplate } from "../lib/templates.ts"
import { isAdmin } from "../lib/telegram.ts"


const { KB_USER_ID } = process.env

const bot = new Composer()

bot.on(message("document"), async (ctx) => {
  if (ctx.chat.type !== "private") return

  try {
    const userId = ctx.from.id.toString()
    const doc = ctx.message.document

    if (isAdmin(userId)) {
      if (doc.mime_type !== "application/pdf") {
        await ctx.reply("Only PDF files are supported for the firm knowledge base.")
        return
      }

      await ctx.reply(`Ingesting firm document: <b>${doc.file_name}</b>…`, { parse_mode: "HTML" })

      const fileName = doc.file_name || `file_${Date.now()}_${doc.file_id.slice(0, 8)}`
      const savePath = await downloadTelegramFile(doc.file_id, fileName)

      try {
        await rag.ingestPdf(KB_USER_ID, "firm", savePath, {
          scope: KB_SCOPE.firm,
          type: PROMPT_TYPES.note
        })
      } finally {
        fs.unlinkSync(savePath)
      }

      await ctx.reply(`Added to firm knowledge base: ${fileName}`)
      return
    }

    const fileName = doc.file_name ? `: ${doc.file_name}` : ""
    await relayClientUpload(ctx, `sent a file${fileName}`, "document", doc.file_id)
  } catch (error) {
    console.error("Error handling document:", error)
    await ctx.reply(renderTemplate("bot/error"))
  }
})

bot.on(message("photo"), async (ctx) => {
  if (ctx.chat.type !== "private") return

  try {
    const photos = ctx.message.photo
    const fileId = photos[photos.length - 1].file_id
    await relayClientUpload(ctx, "sent a photo", "photo", fileId)
  } catch (error) {
    console.error("Error handling photo:", error)
    await ctx.reply(renderTemplate("bot/error"))
  }
})

export default bot

const relayClientUpload = async (ctx, label, fileType, fileId) => {
  const userId = ctx.from.id.toString()
  const activeCase = await fetchActiveCase(userId)
  if (!activeCase) {
    await ctx.reply(renderTemplate("client/file-before-connected"))
    return
  }

  await relayClientFile(activeCase, fileId, fileType, label)
  await ctx.reply(renderTemplate("client/file-sent"))
}
