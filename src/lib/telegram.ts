import { Telegram } from "telegraf"


const {
  TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_IDS
} = process.env

export const telegram = new Telegram(TELEGRAM_BOT_TOKEN)

export const adminTelegramIds = ADMIN_TELEGRAM_IDS
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)

export const isAdmin = (telegramUserId) =>
  adminTelegramIds.includes(telegramUserId)

export const notifyAdmins = async (text, extra = {}) => {
  for (const adminId of adminTelegramIds) {
    try {
      await telegram.sendMessage(Number(adminId), text, extra)
    } catch (error) {
      console.error("notifyAdmins error", adminId, error.message)
    }
  }
}

export const createForumTopic = async (chatId, name) => {
  const result = await telegram.callApi("createForumTopic", {
    chat_id: chatId,
    name: name.slice(0, 128)
  })

  if (!result.message_thread_id) {
    throw new Error("createForumTopic did not return message_thread_id")
  }

  return result.message_thread_id
}

export const sendToTopic = async (chatId, topicId, text, extra = {}) => {
  return telegram.sendMessage(chatId, text, { message_thread_id: topicId, ...extra })
}

export const editForumTopic = async (chatId, topicId, name) => {
  await telegram.callApi("editForumTopic", {
    chat_id: chatId,
    message_thread_id: topicId,
    name: name.slice(0, 128)
  })
}

export const closeForumTopic = async (chatId, topicId) => {
  await telegram.callApi("closeForumTopic", {
    chat_id: chatId,
    message_thread_id: topicId
  })
}

export const deleteForumTopic = async (chatId, topicId) => {
  await telegram.callApi("deleteForumTopic", {
    chat_id: chatId,
    message_thread_id: topicId
  })
}

let cachedBotId = null
let cachedBotUsername = null

export const fetchBotId = async () => {
  if (cachedBotId) return cachedBotId
  const me = await telegram.getMe()
  cachedBotId = me.id
  return cachedBotId
}

export const fetchBotUsername = async () => {
  if (cachedBotUsername) return cachedBotUsername
  const me = await telegram.getMe()
  cachedBotUsername = me.username
  return cachedBotUsername
}
