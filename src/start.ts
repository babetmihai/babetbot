import ngrok from "@ngrok/ngrok"
import app from "./app.ts"
import { registerTelegramWebhook } from "./bot/index.ts"
import { disableStripeWebhook } from "./lib/stripe.ts"


const {
  NGROK_AUTH_TOKEN,
  PORT
} = process.env

const init = async () => {
  try {
    await ngrok.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 500))

    const listener = await ngrok.forward({
      port: Number(PORT),
      authtoken: NGROK_AUTH_TOKEN,
      region: "eu"
    })
    const botUrl = await registerTelegramWebhook(listener.url())
    await disableStripeWebhook()

    app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`))
    console.log(`Bot webhook → ${botUrl}`)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

init()
