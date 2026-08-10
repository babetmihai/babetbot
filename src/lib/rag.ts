import { Document } from "@langchain/core/documents"
import { OpenAIEmbeddings } from "@langchain/openai"
import path from "path"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters"
import db, { FieldValue, deleteQueryDocs } from "./firestore.ts"


const {
  KB_USER_ID,
  OPENAI_API_KEY
} = process.env

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

export const embeddings = new OpenAIEmbeddings({
  apiKey: OPENAI_API_KEY,
  model: "text-embedding-3-small"
})

const rag = {
  list: async (userId, query, count = 5, extraFilter = {}) => {
    const queryEmbedding = await embeddings.embedQuery(query)

    let collectionQuery = db.collection("documents").where("user_id", "==", userId)
    for (const [key, value] of Object.entries(extraFilter)) {
      collectionQuery = collectionQuery.where(key, "==", value)
    }

    const snapshot = await collectionQuery.findNearest({
      vectorField: "embedding",
      queryVector: queryEmbedding,
      limit: count,
      distanceMeasure: "COSINE"
    }).get()

    return snapshot.docs.map((doc) => toRagRow(doc.data()))
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

    await addDocuments(chunks)
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

    await addDocuments([doc])
  },

  listRecent: async (userId, count = 8, extraFilter = {}) => {
    let query = db.collection("documents").where("user_id", "==", userId)
    for (const [key, value] of Object.entries(extraFilter)) {
      query = query.where(key, "==", value)
    }

    const snapshot = await query
      .orderBy("created_at", "desc")
      .limit(count)
      .get()

    return snapshot.docs.map((doc) => toRagRow(doc.data()))
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
    let query = db.collection("documents").where("user_id", "==", userId)
    for (const [key, value] of Object.entries(extraFilter)) {
      query = query.where(key, "==", value)
    }
    await deleteQueryDocs(query)
  },

  replaceGoal: async (userId, goalKey, content, metadata = {}) => {
    await rag.deleteByFilter(userId, { type: PROMPT_TYPES.goal, goal_key: goalKey })
    await rag.add(userId, content, "user", metadata)
  }
}

export default rag

const addDocuments = async (docs) => {
  const texts = docs.map((doc) => doc.pageContent)
  const vectors = await embeddings.embedDocuments(texts)

  let batch = db.batch()
  let count = 0

  for (let i = 0; i < docs.length; i += 1) {
    const metadata = docs[i].metadata ?? {}
    const ref = db.collection("documents").doc()
    batch.set(ref, {
      content: docs[i].pageContent,
      embedding: FieldValue.vector(vectors[i]),
      user_id: metadata.user_id,
      scope: metadata.scope ?? null,
      type: metadata.type ?? null,
      goal_key: metadata.goal_key ?? null,
      role: metadata.role ?? null,
      source: metadata.source ?? null,
      topic: metadata.topic ?? null,
      created_at: metadata.created_at ?? new Date().toISOString()
    })
    count += 1

    if (count >= 400) {
      await batch.commit()
      batch = db.batch()
      count = 0
    }
  }

  if (count > 0) await batch.commit()
}

const toRagRow = (data) => ({
  pageContent: data.content ?? "",
  metadata: data.metadata ?? {
    user_id: data.user_id,
    scope: data.scope,
    type: data.type,
    goal_key: data.goal_key,
    role: data.role,
    source: data.source,
    topic: data.topic,
    created_at: data.created_at
  }
})

const dedupeResults = (results) => {
  const seen = new Set()
  return results.filter((row) => {
    const key = `${row.pageContent.slice(0, 120)}|${JSON.stringify(row.metadata)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
