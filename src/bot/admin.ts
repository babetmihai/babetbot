import { Composer } from "telegraf"
import { respondToProviderSignupRequest } from "../lib/providers.js"


const bot = new Composer()

bot.on("callback_query", async (ctx, next) => {
  if (!("data" in ctx.callbackQuery)) return next()

  const data = ctx.callbackQuery.data
  if (!data.startsWith("pjoin:")) return next()

  const parts = data.split(":")
  const requestId = parts[1]
  const action = parts[2]

  if (!requestId || !action) {
    await ctx.answerCbQuery("Invalid signup action.")
    return
  }

  const result = await respondToProviderSignupRequest(requestId, ctx.from.id.toString(), action)
  await ctx.answerCbQuery(result.toast)

  if (result.editText && "message" in ctx.callbackQuery) {
    await ctx.editMessageText(result.editText)
  }
})

export default bot
