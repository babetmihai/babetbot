import db, { firestore } from "./firestore.ts"
import checkpointer from "./checkpointer.ts"
import {
  areIntakeGoalsComplete,
  buildIntakeSummary,
  formatGoalContextForTools,
  getRequiredIntakeGoals,
  resetClientIntake
} from "./goals.ts"
import { renderTemplate } from "./templates.ts"
import {
  closeForumTopic,
  createForumTopic,
  editForumTopic,
  fetchAdmin,
  notifyAdmin,
  sendToTopic,
  telegram
} from "./telegram.ts"


export type CaseRecord = {
  id: string
  number: number
  clientTelegramId: string
  clientChatId: number
  providerId: string
  groupChatId: number
  topicId: number
  status: "active" | "closed"
  intakeSummary: string | null
}


export const fetchActiveCase = async (clientTelegramId) => {
  const snapshot = await db.collection("cases")
    .where("clientTelegramId", "==", clientTelegramId)
    .where("status", "==", "active")
    .orderBy("createdAt", "desc")
    .limit(1)
    .get()

  if (snapshot.empty) return null
  return mapCaseDoc(snapshot.docs[0])
}

export const fetchActiveCaseInTopic = async (groupChatId, topicId) => {
  const snapshot = await db.collection("cases")
    .where("groupChatId", "==", groupChatId)
    .where("topicId", "==", topicId)
    .where("status", "==", "active")
    .limit(1)
    .get()

  if (snapshot.empty) return null
  return mapCaseDoc(snapshot.docs[0])
}

export const fetchClosedCaseInTopic = async (groupChatId, topicId) => {
  const snapshot = await db.collection("cases")
    .where("groupChatId", "==", groupChatId)
    .where("topicId", "==", topicId)
    .where("status", "==", "closed")
    .limit(1)
    .get()

  if (snapshot.empty) return null
  return mapCaseDoc(snapshot.docs[0])
}

export const isReadyForEscalation = (userGoals) => {
  const keys = getRequiredIntakeGoals(userGoals).map((goal) => goal.key)
  return areIntakeGoalsComplete(userGoals, keys)
}

export const closeCase = async (caseId) => {
  const ref = db.collection("cases").doc(caseId)
  const closedAt = new Date().toISOString()
  await ref.update({ status: "closed", closedAt })

  const doc = await ref.get()
  if (!doc.exists) return null

  const caseRecord = mapCaseDoc(doc)

  await telegram.sendMessage(
    Number(caseRecord.clientTelegramId),
    renderTemplate("client/case-closed")
  )

  try {
    await resetClientIntake(caseRecord.clientTelegramId)
  } catch (error) {
    console.error("resetClientIntake error", caseRecord.clientTelegramId, error.message)
  }

  try {
    await checkpointer.deleteThread(caseRecord.clientTelegramId)
  } catch (error) {
    console.error("deleteThread error", caseRecord.clientTelegramId, error.message)
  }

  await sendToTopic(
    caseRecord.groupChatId,
    caseRecord.topicId,
    renderTemplate("provider/case-closed-topic")
  )
  await editForumTopic(caseRecord.groupChatId, caseRecord.topicId, buildCaseTopicName(caseRecord.number, true))

  const isSupergroupForum = caseRecord.groupChatId < 0
  if (isSupergroupForum) {
    await closeForumTopic(caseRecord.groupChatId, caseRecord.topicId)
  }

  return caseRecord
}

export const escalateToProvider = async (clientTelegramId, clientChatId, userGoals) => {
  const existing = await fetchActiveCase(clientTelegramId)
  if (existing) {
    const admin = await fetchAdmin()
    return renderTemplate("client/already-connected", { providerName: admin.name })
  }

  let admin
  try {
    admin = await fetchAdmin()
  } catch (error) {
    console.error("fetchAdmin error", error.message)
    await notifyIntakeBlocked(clientTelegramId, userGoals)
    return renderTemplate("client/intake-blocked")
  }

  const { clientMessage } = await finalizeAcceptedCase(
    clientTelegramId,
    clientChatId,
    userGoals,
    admin
  )
  return clientMessage
}

const notifyIntakeBlocked = async (clientTelegramId, userGoals) => {
  const ref = db.collection("intake_block_notifications").doc(`${clientTelegramId}_no_provider`)
  const claimed = await firestore.runTransaction(async (tx) => {
    const doc = await tx.get(ref)
    if (doc.exists) return false
    tx.set(ref, {
      clientTelegramId,
      reason: "no_provider",
      createdAt: new Date().toISOString()
    })
    return true
  })
  if (!claimed) return

  await notifyAdmin(renderTemplate("admin/intake-no-provider", {
    intakeSummary: buildIntakeSummary(userGoals)
  }))
}

const finalizeAcceptedCase = async (clientTelegramId, clientChatId, userGoals, admin) => {
  const adminChatId = Number(admin.telegramUserId)
  const intakeSummary = buildIntakeSummary(userGoals)
  const caseRef = db.collection("cases").doc()
  const connectedMessage = renderTemplate("client/connected", { providerName: admin.name })

  const result = await firestore.runTransaction(async (tx) => {
    const active = await tx.get(
      db.collection("cases")
        .where("clientTelegramId", "==", clientTelegramId)
        .where("status", "==", "active")
        .limit(1)
    )
    if (!active.empty) {
      return { raced: true, caseRecord: mapCaseDoc(active.docs[0]) }
    }

    const counterRef = db.collection("counters").doc("cases")
    const counterDoc = await tx.get(counterRef)
    const nextNumber = counterDoc.exists ? counterDoc.data().next : 1

    tx.set(counterRef, { next: nextNumber + 1 })
    tx.set(caseRef, {
      number: nextNumber,
      clientTelegramId,
      clientChatId,
      providerId: admin.telegramUserId,
      groupChatId: adminChatId,
      topicId: null,
      status: "active",
      intakeSummary,
      createdAt: new Date().toISOString(),
      closedAt: null
    })
    return { raced: false, number: nextNumber }
  })

  if (result.raced) {
    return {
      caseRecord: result.caseRecord,
      clientMessage: connectedMessage
    }
  }

  let topicId
  try {
    topicId = await createForumTopic(adminChatId, buildCaseTopicName(result.number))
    await caseRef.update({ topicId })
  } catch (error) {
    await caseRef.delete()
    throw error
  }

  const caseRecord = {
    id: caseRef.id,
    number: result.number,
    clientTelegramId,
    clientChatId,
    providerId: admin.telegramUserId,
    groupChatId: adminChatId,
    topicId,
    status: "active",
    intakeSummary
  }

  await sendToTopic(
    adminChatId,
    topicId,
    `${intakeSummary}\n\n${renderTemplate("provider/topic-opening")}`
  )

  console.log("[cases] accepted", {
    caseId: caseRecord.id,
    caseNumber: caseRecord.number,
    clientTelegramId,
    provider: admin.name,
    topicId,
    goalContext: formatGoalContextForTools(userGoals)
  })

  return {
    caseRecord,
    clientMessage: connectedMessage
  }
}

const buildCaseTopicName = (caseNumber, closed = false) => {
  const prefix = closed ? "Closed — " : ""
  return `${prefix}Case #${caseNumber}`
}

const mapCaseDoc = (doc) => {
  const data = doc.data()
  return {
    id: doc.id,
    number: data.number,
    clientTelegramId: data.clientTelegramId,
    clientChatId: data.clientChatId,
    providerId: data.providerId,
    groupChatId: data.groupChatId,
    topicId: data.topicId,
    status: data.status,
    intakeSummary: data.intakeSummary ?? null
  }
}
