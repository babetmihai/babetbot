import "dotenv/config"
import { renderTemplate } from "./lib/templates.js"

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
export const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN
export const NGROK_AUTH_TOKEN = process.env.NGROK_AUTH_TOKEN
export const PORT = process.env.PORT || "8080"
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY

const requiredEnv = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env: ${key}`)
  return value
}

export const FIREBASE_PROJECT_ID = requiredEnv("FIREBASE_PROJECT_ID")

export const STRIPE_SECRET_KEY = requiredEnv("STRIPE_SECRET_KEY")
export const STRIPE_WEBHOOK_SECRET = requiredEnv("STRIPE_WEBHOOK_SECRET")
export const STRIPE_DEV = process.env.STRIPE_DEV === "1"
export const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || "ron").toLowerCase()

export const KB_USER_ID = requiredEnv("KB_USER_ID")

export const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)

export const isAdmin = (telegramUserId) =>
  ADMIN_TELEGRAM_IDS.includes(telegramUserId)

export const CONSENT_YES_VALUE = "yes"

export const LEGAL_DISCLAIMER = renderTemplate("shared/legal-disclaimer")

export const PROMPT_TYPES = {
  goal: "goal",
  note: "note",
  question: "question",
  conversation: "conversation"
}

export const KB_SCOPE = {
  firm: "firm",
  client: "client"
} as const
