import { Telegraf } from "telegraf"
import textBot from "./text.js"
import uploadBot from "./upload.js"
import relayBot from "./relay.js"
import adminBot from "./admin.js"
import { TELEGRAM_BOT_TOKEN, LEGAL_DISCLAIMER } from "../config.js"
import {
  buildProviderWelcomeText,
  fetchProviderByTelegramUserId,
  markProviderBotStarted,
  submitProviderSignupRequest
} from "../lib/providers.js"
import { renderTemplate } from "../lib/templates.js"


export const bot = new Telegraf(TELEGRAM_BOT_TOKEN)

bot.start(async (ctx) => {
  const fromId = ctx.from.id.toString()
  const provider = await fetchProviderByTelegramUserId(fromId)

  if (provider) {
    await markProviderBotStarted(fromId)
    await ctx.reply(buildProviderWelcomeText(provider.name))
    return
  }

  const isProviderLink = ctx.startPayload === "provider"
  if (isProviderLink) {
    await ctx.reply(renderTemplate("provider/signup-onboarding"))
    return
  }

  await ctx.reply(renderTemplate("client/welcome", { legalDisclaimer: LEGAL_DISCLAIMER }))
})

bot.command("join", async (ctx) => {
  if (ctx.chat.type !== "private") {
    await ctx.reply("Use /join in a private chat with the bot.")
    return
  }

  if (!("text" in ctx.message)) return

  const name = parseJoinArgs(ctx.message.text)
  if (!name) {
    await ctx.reply("Usage: /join Your Name")
    return
  }

  const fromId = ctx.from.id.toString()
  const result = await submitProviderSignupRequest({
    telegramUserId: fromId,
    telegramUsername: ctx.from.username || null,
    name
  })

  await ctx.reply(result.message)
})

bot.help(async (ctx) => {
  await ctx.reply(renderTemplate("client/help"))
})

bot.use(relayBot)
bot.use(adminBot)
bot.use(textBot)
bot.use(uploadBot)

export default bot

const parseJoinArgs = (text) => {
  const body = text.replace(/^\/join(@\w+)?\s*/i, "").trim()
  if (!body) return null
  return body
}
