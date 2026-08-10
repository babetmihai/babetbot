import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId
} from "@langchain/langgraph-checkpoint"
import db, { deleteQueryDocs } from "./firestore.ts"


class FirestoreSaver extends BaseCheckpointSaver {
  async getTuple(config) {
    const threadId = config.configurable?.thread_id
    const checkpointNs = config.configurable?.checkpoint_ns ?? ""
    const checkpointId = getCheckpointId(config)

    if (!threadId) return undefined

    let doc
    if (checkpointId) {
      doc = await checkpointRef(threadId, checkpointNs, checkpointId).get()
      if (!doc.exists) return undefined
    } else {
      const snapshot = await db.collection("agent_checkpoints")
        .where("threadId", "==", threadId)
        .where("checkpointNs", "==", checkpointNs)
        .orderBy("checkpointId", "desc")
        .limit(1)
        .get()

      if (snapshot.empty) return undefined
      doc = snapshot.docs[0]
    }

    return this.loadTuple(doc)
  }

  async *list(config, options) {
    const { before, limit, filter } = options ?? {}
    const threadId = config.configurable?.thread_id
    const checkpointNs = config.configurable?.checkpoint_ns
    const configCheckpointId = config.configurable?.checkpoint_id

    let query: any = db.collection("agent_checkpoints")
    if (threadId) query = query.where("threadId", "==", threadId)
    if (checkpointNs !== undefined) query = query.where("checkpointNs", "==", checkpointNs)
    query = query.orderBy("checkpointId", "desc")

    const snapshot = await query.get()
    let remaining = limit

    for (const doc of snapshot.docs) {
      const data = doc.data()
      if (configCheckpointId && data.checkpointId !== configCheckpointId) continue
      if (before?.configurable?.checkpoint_id && data.checkpointId >= before.configurable.checkpoint_id) {
        continue
      }

      const tuple = await this.loadTuple(doc)
      if (filter && !Object.entries(filter).every(([key, value]) => tuple.metadata?.[key] === value)) {
        continue
      }

      if (remaining !== undefined) {
        if (remaining <= 0) break
        remaining -= 1
      }

      yield tuple
    }
  }

  async put(config, checkpoint, metadata) {
    const preparedCheckpoint = copyCheckpoint(checkpoint)
    const threadId = config.configurable?.thread_id
    const checkpointNs = config.configurable?.checkpoint_ns ?? ""

    if (threadId === undefined) {
      throw new Error("Failed to put checkpoint. Missing configurable.thread_id")
    }

    const [[checkpointType, serializedCheckpoint], [metadataType, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata)
    ])

    await checkpointRef(threadId, checkpointNs, checkpoint.id).set({
      threadId,
      checkpointNs,
      checkpointId: checkpoint.id,
      parentCheckpointId: config.configurable?.checkpoint_id ?? null,
      checkpointType,
      checkpoint: Buffer.from(serializedCheckpoint),
      metadataType,
      metadata: Buffer.from(serializedMetadata)
    })

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id
      }
    }
  }

  async putWrites(config, writes, taskId) {
    const threadId = config.configurable?.thread_id
    const checkpointNs = config.configurable?.checkpoint_ns ?? ""
    const checkpointId = config.configurable?.checkpoint_id

    if (threadId === undefined) {
      throw new Error("Failed to put writes. Missing configurable.thread_id")
    }
    if (checkpointId === undefined) {
      throw new Error("Failed to put writes. Missing configurable.checkpoint_id")
    }

    await Promise.all(writes.map(async ([channel, value], idx) => {
      const [valueType, serializedValue] = await this.serde.dumpsTyped(value)
      const writeIdx = WRITES_IDX_MAP[channel] ?? idx
      if (writeIdx >= 0) {
        const existing = await writeRef(threadId, checkpointNs, checkpointId, taskId, writeIdx).get()
        if (existing.exists) return
      }

      await writeRef(threadId, checkpointNs, checkpointId, taskId, writeIdx).set({
        threadId,
        checkpointNs,
        checkpointId,
        taskId,
        idx: writeIdx,
        channel,
        type: valueType,
        value: Buffer.from(serializedValue)
      })
    }))
  }

  async deleteThread(threadId) {
    await deleteQueryDocs(db.collection("agent_checkpoints").where("threadId", "==", threadId))
    await deleteQueryDocs(db.collection("agent_writes").where("threadId", "==", threadId))
  }

  async loadTuple(doc) {
    const data = doc.data()
    const checkpoint = await this.serde.loadsTyped(data.checkpointType, toUint8Array(data.checkpoint))
    const metadata = await this.serde.loadsTyped(data.metadataType, toUint8Array(data.metadata))

    const writesSnap = await db.collection("agent_writes")
      .where("threadId", "==", data.threadId)
      .where("checkpointNs", "==", data.checkpointNs)
      .where("checkpointId", "==", data.checkpointId)
      .get()

    const pendingWrites = []
    for (const writeDoc of writesSnap.docs) {
      const write = writeDoc.data()
      const loaded = await this.serde.loadsTyped(write.type, toUint8Array(write.value))
      pendingWrites.push([write.taskId, write.channel, loaded])
    }

    const tuple: any = {
      config: {
        configurable: {
          thread_id: data.threadId,
          checkpoint_ns: data.checkpointNs,
          checkpoint_id: data.checkpointId
        }
      },
      checkpoint,
      metadata,
      pendingWrites
    }

    if (data.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: data.threadId,
          checkpoint_ns: data.checkpointNs,
          checkpoint_id: data.parentCheckpointId
        }
      }
    }

    return tuple
  }
}

const checkpointDocId = (threadId, checkpointNs, checkpointId) =>
  `${encodeURIComponent(threadId)}__${encodeURIComponent(checkpointNs)}__${checkpointId}`

const writeDocId = (threadId, checkpointNs, checkpointId, taskId, idx) =>
  `${encodeURIComponent(threadId)}__${encodeURIComponent(checkpointNs)}__${checkpointId}__${taskId}_${idx}`

const checkpointRef = (threadId, checkpointNs, checkpointId) =>
  db.collection("agent_checkpoints").doc(checkpointDocId(threadId, checkpointNs, checkpointId))

const writeRef = (threadId, checkpointNs, checkpointId, taskId, idx) =>
  db.collection("agent_writes").doc(writeDocId(threadId, checkpointNs, checkpointId, taskId, idx))

const toUint8Array = (value) => {
  if (!value) return new Uint8Array()
  if (value instanceof Uint8Array) return value
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  if (typeof value.toUint8Array === "function") return value.toUint8Array()
  return new Uint8Array(value)
}

const checkpointer = new FirestoreSaver()

export default checkpointer
