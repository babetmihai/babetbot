import ngrok from "@ngrok/ngrok"
import app from "./app.js"
import { NGROK_AUTH_TOKEN, PORT, STRIPE_DEV } from "./config.js"
import { registerWebhooks } from "./webhooks.js"


const init = async () => {
  try {
    await ngrok.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 500))

    const listener = await ngrok.forward({
      port: Number(PORT),
      authtoken: NGROK_AUTH_TOKEN,
      region: "eu"
    })
    const baseUrl = listener.url()
    const { stripeWebhookUrl } = await registerWebhooks(baseUrl)

    app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`))
    console.log("Bot started")
    if (STRIPE_DEV) {
      console.log("Stripe dev mode — run: npm run stripe")
    } else {
      console.log(`Stripe webhook → ${stripeWebhookUrl}`)
    }
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

init()
