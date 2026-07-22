import { SupabaseVectorStore } from "@langchain/community/vectorstores/supabase"
import { Document } from "@langchain/core/documents"
import { OpenAIEmbeddings } from "@langchain/openai"
import supabase from "./supabase.js"
import path from "path"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters"
import { KB_USER_ID, KB_SCOPE, OPENAI_API_KEY, PROMPT_TYPES } from "../config.js"


export const embeddings = new OpenAIEmbeddings({
  apiKey: OPENAI_API_KEY,
  model: "text-embedding-3-small"
})

export const vectorStore = new SupabaseVectorStore(embeddings, {
  client: supabase,
  tableName: "documents",
  queryName: "match_documents"
})

const rag = {
  list: async (userId, query, count = 5, extraFilter = {}) => {
    const results = await vectorStore.similaritySearch(query, count, {
      user_id: userId,
      ...extraFilter
    })

    return results.map((row) => ({
      pageContent: row.pageContent,
      metadata: row.metadata ?? {}
    }))
  },

  listForIntake: async (clientUserId, query, count = 6) => {
    const firmCount = Math.max(2, Math.ceil(count * 0.6))
    const clientCount = Math.max(1, count - firmCount)

    const [firmResults, clientResults] = await Promise.all([
      rag.list(KB_USER_ID, query, firmCount, { scope: KB_SCOPE.firm }),
      rag.list(clientUserId, query, clientCount * 2)
    ])

    const clientKnowledge = clientResults.filter((row) => {
      const type = row.metadata.type
      return type === PROMPT_TYPES.note || type === PROMPT_TYPES.goal
    }).slice(0, clientCount)

    return dedupeResults([...firmResults, ...clientKnowledge])
  },

  ingestPdf: async (userId, role, filePath, extraMetadata = {}) => {
    const loader = new PDFLoader(filePath, { splitPages: true })
    const docs = await loader.load()
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 800,
      chunkOverlap: 120
    })

    const chunks = await textSplitter.splitDocuments(docs)

    for (const chunk of chunks) {
      chunk.metadata.user_id = userId
      chunk.metadata.source = path.basename(filePath)
      chunk.metadata.role = role
      chunk.metadata.created_at = new Date().toISOString()
      Object.assign(chunk.metadata, extraMetadata)
    }

    await vectorStore.addDocuments(chunks)
  },

  ingestFirmPdf: async (filePath) => {
    await rag.ingestPdf(KB_USER_ID, "firm", filePath, {
      scope: KB_SCOPE.firm,
      type: PROMPT_TYPES.note
    })
  },

  add: async (userId, message, role = "user", metadata = {}) => {
    const doc = new Document({
      pageContent: message,
      metadata: {
        ...metadata,
        user_id: userId,
        role,
        created_at: new Date().toISOString()
      }
    })

    await vectorStore.addDocuments([doc])
  },

  listRecent: async (userId, count = 8, extraFilter = {}) => {
    const { data, error } = await supabase
      .from("documents")
      .select("content, metadata")
      .contains("metadata", { user_id: userId, ...extraFilter })
      .order("id", { ascending: false })
      .limit(count)

    if (error) throw error

    return (data ?? []).map((row) => ({
      pageContent: row.content ?? "",
      metadata: row.metadata ?? {}
    }))
  },

  saveConversationTurn: async (userId, role, content) => {
    const text = content.trim()
    if (!text) return
    await rag.add(userId, text, role, {
      type: PROMPT_TYPES.conversation,
      scope: KB_SCOPE.client,
      source: "telegram"
    })
  },

  deleteByFilter: async (userId, extraFilter = {}) => {
    const { error } = await supabase
      .from("documents")
      .delete()
      .contains("metadata", { user_id: userId, ...extraFilter })

    if (error) throw error
  },

  replaceGoal: async (userId, goalKey, content, metadata = {}) => {
    await rag.deleteByFilter(userId, { type: PROMPT_TYPES.goal, goal_key: goalKey })
    await rag.add(userId, content, "user", metadata)
  }
}

export default rag

const dedupeResults = (results) => {
  const seen = new Set()
  return results.filter((row) => {
    const key = `${row.pageContent.slice(0, 120)}|${JSON.stringify(row.metadata)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
