import { ADMIN_TELEGRAM_IDS, isAdmin } from "../config.js"
import supabase from "./supabase.js"
import { renderTemplate } from "./templates.js"
import { telegram } from "./telegram.js"


export type Provider = {
  id: number
  name: string
  telegramUserId: string
  telegramUsername: string | null
  botStartedAt: string | null
}

const providerSelect = "id, name, telegram_user_id, telegram_username, bot_started_at"
const signupSelect = "id, telegram_user_id, telegram_username, name, status"

export const fetchProviders = async () => {
  const { data, error } = await supabase
    .from("providers")
    .select(providerSelect)

  if (error) throw error
  return (data ?? []).map(mapRow)
}

export const fetchProvider = async (id) => {
  const { data, error } = await supabase
    .from("providers")
    .select(providerSelect)
    .eq("id", id)
    .maybeSingle()

  if (error) throw error
  return data ? mapRow(data) : null
}

export const fetchProviderByTelegramUserId = async (telegramUserId) => {
  const { data, error } = await supabase
    .from("providers")
    .select(providerSelect)
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle()

  if (error) throw error
  return data ? mapRow(data) : null
}

export const markProviderBotStarted = async (telegramUserId) => {
  const { data, error } = await supabase
    .from("providers")
    .update({ bot_started_at: new Date().toISOString() })
    .eq("telegram_user_id", telegramUserId)
    .is("bot_started_at", null)
    .select(providerSelect)
    .maybeSingle()

  if (error) throw error
  if (data) return mapRow(data)

  return fetchProviderByTelegramUserId(telegramUserId)
}

export const fetchOnboardedProviders = async () => {
  const providers = await fetchProviders()
  return providers.filter((provider) => provider.botStartedAt)
}

export const createProvider = async (input) => {
  const { data, error } = await supabase
    .from("providers")
    .upsert({
      name: input.name.trim(),
      telegram_user_id: input.telegramUserId,
      telegram_username: input.telegramUsername ?? null
    }, { onConflict: "telegram_user_id" })
    .select(providerSelect)
    .single()

  if (error) throw error
  return mapRow(data)
}

export const formatProviderMention = (provider) => {
  if (!provider.telegramUsername) return provider.name
  const handle = provider.telegramUsername.startsWith("@")
    ? provider.telegramUsername.slice(1)
    : provider.telegramUsername
  return `@${handle}`
}

export const buildProviderWelcomeText = (providerName) =>
  renderTemplate("provider/welcome", { providerName })

export const submitProviderSignupRequest = async (input) => {
  const existingProvider = await fetchProviderByTelegramUserId(input.telegramUserId)
  if (existingProvider) {
    return { message: renderTemplate("provider/signup-already-registered") }
  }

  if (isAdmin(input.telegramUserId)) {
    const provider = await createProvider({
      name: input.name,
      telegramUserId: input.telegramUserId,
      telegramUsername: input.telegramUsername
    })
    await markProviderBotStarted(input.telegramUserId)

    const existingRequest = await fetchProviderSignupRequestByTelegramUserId(input.telegramUserId)
    if (existingRequest && existingRequest.status === "pending") {
      await resolveProviderSignupRequest(existingRequest.id, "approved")
    }

    return {
      message: buildProviderWelcomeText(provider.name)
    }
  }

  const existingRequest = await fetchProviderSignupRequestByTelegramUserId(input.telegramUserId)
  if (existingRequest && existingRequest.status === "pending") {
    return { message: renderTemplate("provider/signup-pending") }
  }

  let request
  if (existingRequest && existingRequest.status === "declined") {
    request = await reopenProviderSignupRequest(existingRequest.id, input)
  } else {
    request = await insertProviderSignupRequest(input)
  }

  await notifyAdminsOfProviderSignupRequest(request)
  return { message: renderTemplate("provider/signup-sent") }
}

export const respondToProviderSignupRequest = async (requestId, adminTelegramUserId, action) => {
  if (!isAdmin(adminTelegramUserId)) {
    return { toast: "Not authorized.", editText: null }
  }

  const request = await fetchProviderSignupRequest(requestId)
  if (!request) {
    return { toast: "Signup request not found.", editText: null }
  }

  if (request.status !== "pending") {
    return { toast: "This request was already handled.", editText: null }
  }

  if (action === "decline") {
    await resolveProviderSignupRequest(requestId, "declined")

    try {
      await telegram.sendMessage(
        Number(request.telegramUserId),
        renderTemplate("provider/signup-declined")
      )
    } catch (error) {
      console.error("provider signup decline notify error", error.message)
    }

    return {
      toast: "Signup declined.",
      editText: renderTemplate("admin/signup-declined", {
        name: request.name,
        telegramUserId: request.telegramUserId
      })
    }
  }

  const provider = await createProvider({
    name: request.name,
    telegramUserId: request.telegramUserId,
    telegramUsername: request.telegramUsername
  })

  await markProviderBotStarted(request.telegramUserId)
  await resolveProviderSignupRequest(requestId, "approved")

  try {
    await telegram.sendMessage(
      Number(request.telegramUserId),
      buildProviderWelcomeText(provider.name)
    )
  } catch (error) {
    console.error("provider signup approve notify error", error.message)
  }

  return {
    toast: renderTemplate("bot/signup-approved-toast"),
    editText: renderTemplate("admin/signup-approved", {
      name: provider.name,
      telegramUserId: provider.telegramUserId
    })
  }
}

const mapRow = (row) => ({
  id: row.id,
  name: row.name,
  telegramUserId: row.telegram_user_id,
  telegramUsername: row.telegram_username,
  botStartedAt: row.bot_started_at
})

const mapSignupRow = (row) => ({
  id: row.id,
  telegramUserId: row.telegram_user_id,
  telegramUsername: row.telegram_username,
  name: row.name,
  status: row.status
})

const fetchProviderSignupRequest = async (requestId) => {
  const { data, error } = await supabase
    .from("provider_signup_requests")
    .select(signupSelect)
    .eq("id", requestId)
    .maybeSingle()

  if (error) throw error
  return data ? mapSignupRow(data) : null
}

const fetchProviderSignupRequestByTelegramUserId = async (telegramUserId) => {
  const { data, error } = await supabase
    .from("provider_signup_requests")
    .select(signupSelect)
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle()

  if (error) throw error
  return data ? mapSignupRow(data) : null
}

const insertProviderSignupRequest = async (input) => {
  const { data, error } = await supabase
    .from("provider_signup_requests")
    .insert({
      telegram_user_id: input.telegramUserId,
      telegram_username: input.telegramUsername ?? null,
      name: input.name.trim(),
      status: "pending"
    })
    .select(signupSelect)
    .single()

  if (error) throw error
  return mapSignupRow(data)
}

const reopenProviderSignupRequest = async (requestId, input) => {
  const { data, error } = await supabase
    .from("provider_signup_requests")
    .update({
      name: input.name.trim(),
      telegram_username: input.telegramUsername ?? null,
      status: "pending",
      resolved_at: null
    })
    .eq("id", requestId)
    .select(signupSelect)
    .single()

  if (error) throw error
  return mapSignupRow(data)
}

const resolveProviderSignupRequest = async (requestId, status) => {
  const { error } = await supabase
    .from("provider_signup_requests")
    .update({
      status,
      resolved_at: new Date().toISOString()
    })
    .eq("id", requestId)
    .eq("status", "pending")

  if (error) throw error
}

const notifyAdminsOfProviderSignupRequest = async (request) => {
  const handle = request.telegramUsername ? `@${request.telegramUsername.replace(/^@/, "")}` : request.telegramUserId
  const text = renderTemplate("admin/signup-request", {
    name: request.name,
    telegramHandle: handle,
    userId: request.telegramUserId
  })

  const keyboard = {
    inline_keyboard: [[
      { text: "Approve", callback_data: `pjoin:${request.id}:approve` },
      { text: "Decline", callback_data: `pjoin:${request.id}:decline` }
    ]]
  }

  for (const adminId of ADMIN_TELEGRAM_IDS) {
    try {
      await telegram.sendMessage(Number(adminId), text, { reply_markup: keyboard })
    } catch (error) {
      console.error("notifyAdminsOfProviderSignupRequest error", adminId, error.message)
    }
  }
}
