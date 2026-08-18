import "dotenv/config"
import db, { deleteQueryDocs } from "./lib/firestore.ts"
import { adminTelegramId, deleteForumTopic, telegram } from "./lib/telegram.ts"


const MESSAGE_CHUNK = 100

const run = async () => {
  const casesSnap = await db.collection("cases").get()
  const chatIds = new Set([Number(adminTelegramId)])

  for (const doc of casesSnap.docs) {
    const data = doc.data()
    const { topicId, groupChatId, clientChatId, clientTelegramId } = data || {}

    if (topicId && groupChatId) {
      try {
        await deleteForumTopic(groupChatId, topicId)
        console.log(`Deleted topic ${topicId}`)
      } catch (error) {
        console.error(`Topic ${topicId}:`, error.message)
      }
    }

    if (clientChatId) chatIds.add(Number(clientChatId))
    if (clientTelegramId) chatIds.add(Number(clientTelegramId))
  }

  const goalsSnap = await db.collection("user_goal_values").get()
  for (const doc of goalsSnap.docs) {
    const { userId } = doc.data() || {}
    if (userId) chatIds.add(Number(userId))
  }

  for (const chatId of chatIds) {
    try {
      await clearChatMessages(chatId)
      console.log(`Cleared chat ${chatId}`)
    } catch (error) {
      console.error(`Chat ${chatId}:`, error.message)
    }
  }

  await deleteQueryDocs(db.collection("cases"))
  await deleteQueryDocs(db.collection("user_goal_values"))
  await deleteQueryDocs(db.collection("agent_checkpoints"))
  await deleteQueryDocs(db.collection("agent_writes"))
  await deleteQueryDocs(db.collection("intake_block_notifications"))
  await deleteQueryDocs(db.collection("documents").where("scope", "==", "client"))
  await db.collection("counters").doc("cases").delete()

  console.log("Done.")
}

const clearChatMessages = async (chatId) => {
  const sent = await telegram.sendMessage(chatId, ".")
  const lastId = sent.message_id
  let chunk = []

  for (let id = 1; id <= lastId; id += 1) {
    chunk.push(id)
    if (chunk.length === MESSAGE_CHUNK) {
      await deleteMessageChunk(chatId, chunk)
      chunk = []
    }
  }

  if (chunk.length) {
    await deleteMessageChunk(chatId, chunk)
  }
}

const deleteMessageChunk = async (chatId, messageIds) => {
  try {
    await telegram.callApi("deleteMessages", {
      chat_id: chatId,
      message_ids: messageIds
    })
  } catch (error) {
    console.error("deleteMessages error", chatId, error.message)
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
