import db from "./firestore.ts"
import { renderTemplate } from "./templates.ts"
import { isAdmin, notifyAdmins, telegram } from "./telegram.ts"


export type Provider = {
  id: string
  name: string
  telegramUserId: string
  telegramUsername: string | null
  botStartedAt: string | null
}

export const fetchProviders = async () => {
  const snapshot = await db.collection("providers").get()
  return snapshot.docs.map(mapProviderDoc)
}

export const fetchProvider = async (id) => {
  const doc = await db.collection("providers").doc(id).get()
  if (!doc.exists) return null
  return mapProviderDoc(doc)
}

export const fetchProviderByTelegramUserId = async (telegramUserId) => {
  const snapshot = await db.collection("providers")
    .where("telegramUserId", "==", telegramUserId)
    .limit(1)
    .get()

  if (snapshot.empty) return null
  return mapProviderDoc(snapshot.docs[0])
}

export const markProviderBotStarted = async (telegramUserId) => {
  const provider = await fetchProviderByTelegramUserId(telegramUserId)
  if (!provider) return null

  if (!provider.botStartedAt) {
    const botStartedAt = new Date().toISOString()
    await db.collection("providers").doc(provider.id).update({ botStartedAt })
    return { ...provider, botStartedAt }
  }

  return provider
}

export const fetchOnboardedProviders = async () => {
  const providers = await fetchProviders()
  return providers.filter((provider) => provider.botStartedAt)
}

export const createProvider = async (input) => {
  const existing = await fetchProviderByTelegramUserId(input.telegramUserId)
  const payload = {
    name: input.name.trim(),
    telegramUserId: input.telegramUserId,
    telegramUsername: input.telegramUsername ?? null
  }

  if (existing) {
    await db.collection("providers").doc(existing.id).set(payload, { merge: true })
    return fetchProvider(existing.id)
  }

  const ref = await db.collection("providers").add({
    ...payload,
    botStartedAt: null,
    createdAt: new Date().toISOString()
  })

  return fetchProvider(ref.id)
}

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
      message: renderTemplate("provider/welcome", { providerName: provider.name })
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
      renderTemplate("provider/welcome", { providerName: provider.name })
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

const mapProviderDoc = (doc) => {
  const data = doc.data()
  return {
    id: doc.id,
    name: data.name,
    telegramUserId: data.telegramUserId,
    telegramUsername: data.telegramUsername ?? null,
    botStartedAt: data.botStartedAt ?? null
  }
}

const mapSignupDoc = (doc) => {
  const data = doc.data()
  return {
    id: doc.id,
    telegramUserId: data.telegramUserId,
    telegramUsername: data.telegramUsername ?? null,
    name: data.name,
    status: data.status
  }
}

const fetchProviderSignupRequest = async (requestId) => {
  const doc = await db.collection("provider_signup_requests").doc(requestId).get()
  if (!doc.exists) return null
  return mapSignupDoc(doc)
}

const fetchProviderSignupRequestByTelegramUserId = async (telegramUserId) => {
  const snapshot = await db.collection("provider_signup_requests")
    .where("telegramUserId", "==", telegramUserId)
    .limit(1)
    .get()

  if (snapshot.empty) return null
  return mapSignupDoc(snapshot.docs[0])
}

const insertProviderSignupRequest = async (input) => {
  const ref = await db.collection("provider_signup_requests").add({
    telegramUserId: input.telegramUserId,
    telegramUsername: input.telegramUsername ?? null,
    name: input.name.trim(),
    status: "pending",
    createdAt: new Date().toISOString(),
    resolvedAt: null
  })

  return fetchProviderSignupRequest(ref.id)
}

const reopenProviderSignupRequest = async (requestId, input) => {
  await db.collection("provider_signup_requests").doc(requestId).update({
    name: input.name.trim(),
    telegramUsername: input.telegramUsername ?? null,
    status: "pending",
    resolvedAt: null
  })

  return fetchProviderSignupRequest(requestId)
}

const resolveProviderSignupRequest = async (requestId, status) => {
  const ref = db.collection("provider_signup_requests").doc(requestId)
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref)
    if (!doc.exists) return
    if (doc.data().status !== "pending") return
    tx.update(ref, {
      status,
      resolvedAt: new Date().toISOString()
    })
  })
}

const notifyAdminsOfProviderSignupRequest = async (request) => {
  const handle = request.telegramUsername ? `@${request.telegramUsername.replace(/^@/, "")}` : request.telegramUserId
  const text = renderTemplate("admin/signup-request", {
    name: request.name,
    telegramHandle: handle,
    userId: request.telegramUserId
  })

  await notifyAdmins(text, {
    reply_markup: {
      inline_keyboard: [[
        { text: "Approve", callback_data: `pjoin:${request.id}:approve` },
        { text: "Decline", callback_data: `pjoin:${request.id}:decline` }
      ]]
    }
  })
}
