import { NGROK_AUTH_TOKEN, PORT, STRIPE_DEV, TELEGRAM_SECRET_TOKEN } from "./config.js"
import express from "express"
import ngrok from "@ngrok/ngrok"
import { v4 as uuidv4 } from "uuid"
import bot from "./bot/index.js"
import { completePaymentFromSession } from "./lib/payments.js"
import { disableStripeWebhook, ensureStripeWebhook, verifyStripeWebhook } from "./lib/stripe.js"


const app = express()

const botPath = `/bot/webhook/${uuidv4()}`
const stripeWebhookPath = "/stripe/webhook"

app.post(stripeWebhookPath, express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"]
  if (!signature || typeof signature !== "string") {
    return res.sendStatus(400)
  }

  try {
    const event = verifyStripeWebhook(req.body, signature)

    if (event.type === "checkout.session.completed") {
      await completePaymentFromSession(event.data.object)
    }

    res.sendStatus(200)
  } catch (error) {
    console.error("Stripe webhook error:", error)
    res.sendStatus(400)
  }
})

app.use(botPath, (req, res, next) => {
  const secretToken = req.headers["x-telegram-bot-api-secret-token"]
  if (secretToken !== TELEGRAM_SECRET_TOKEN) {
    console.log("Invalid secret token")
    return res.sendStatus(401)
  }
  next()
})

app.use(bot.webhookCallback(botPath))

app.use((error, req, res, next) => {
  console.error(error)
  if (res.headersSent) return
  res.status(500).json({ message: error.message })
})

const init = async () => {
  try {
    await ngrok.disconnect()
    await new Promise(resolve => setTimeout(resolve, 500))

    const listener = await ngrok.forward({
      port: Number(PORT),
      authtoken: NGROK_AUTH_TOKEN,
      region: "eu"
    })
    const baseUrl = listener.url()

    const botUrl = `${baseUrl}${botPath}`
    const stripeWebhookUrl = `${baseUrl}${stripeWebhookPath}`

    await bot.telegram.setWebhook(botUrl, {
      secret_token: TELEGRAM_SECRET_TOKEN
    })

    if (STRIPE_DEV) {
      await disableStripeWebhook()
    } else {
      await ensureStripeWebhook(stripeWebhookUrl)
    }

    app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`))
    console.log("Bot started")
    if (STRIPE_DEV) {
      console.log(`Stripe dev mode — run: npm run stripe:listen`)
    } else {
      console.log(`Stripe webhook → ${stripeWebhookUrl}`)
    }
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

init()
