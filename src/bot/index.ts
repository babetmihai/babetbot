import { Telegraf } from "telegraf"
import textBot from "./text.ts"
import uploadBot from "./upload.ts"
import relayBot from "./relay.ts"
import { LEGAL_DISCLAIMER, renderTemplate } from "../lib/templates.ts"
import { isAdmin } from "../lib/telegram.ts"


const { TELEGRAM_BOT_TOKEN } = process.env

export const bot = new Telegraf(TELEGRAM_BOT_TOKEN)

bot.start(async (ctx) => {
  const fromId = ctx.from.id.toString()

  if (isAdmin(fromId)) {
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ")
    await ctx.reply(renderTemplate("provider/welcome", { providerName: name }))
    return
  }

  await ctx.reply(renderTemplate("client/welcome", { legalDisclaimer: LEGAL_DISCLAIMER }))
})

bot.help(async (ctx) => {
  await ctx.reply(renderTemplate("client/help"))
})

bot.use(relayBot)
bot.use(textBot)
bot.use(uploadBot)

export default bot
