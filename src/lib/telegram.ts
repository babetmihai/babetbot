import { Telegram } from "telegraf"


const {
  TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_ID
} = process.env

export const telegram = new Telegram(TELEGRAM_BOT_TOKEN)

export const adminTelegramId = ADMIN_TELEGRAM_ID

export const isAdmin = (telegramUserId) =>
  telegramUserId === adminTelegramId

export const fetchAdmin = async () => {
  const chat = await telegram.getChat(Number(adminTelegramId))
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ")
  return {
    telegramUserId: adminTelegramId,
    name
  }
}

export const notifyAdmin = async (text, extra = {}) => {
  try {
    await telegram.sendMessage(Number(adminTelegramId), text, extra)
  } catch (error) {
    console.error("notifyAdmin error", error.message)
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
