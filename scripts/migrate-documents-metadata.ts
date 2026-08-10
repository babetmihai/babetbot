/**
 * Flatten documents: promote filter fields to top-level and drop nested metadata.
 *
 *   npx tsx scripts/migrate-documents-metadata.ts
 *   npx tsx scripts/migrate-documents-metadata.ts --dry-run
 */
import db, { FieldValue } from "../src/lib/firestore.js"

const DRY_RUN = process.argv.includes("--dry-run")
const BATCH_SIZE = 400
const FIELDS = ["user_id", "scope", "type", "goal_key", "role", "source", "topic", "created_at"]

const run = async () => {
  const snapshot = await db.collection("documents").get()
  let updated = 0
  let skipped = 0
  let batch = db.batch()
  let batchCount = 0

  for (const doc of snapshot.docs) {
    const data = doc.data()
    if (!data.metadata) {
      skipped += 1
      continue
    }

    const metadata = data.metadata
    const patch = { metadata: FieldValue.delete() }
    for (const key of FIELDS) {
      const top = data[key]
      const nested = metadata[key]
      patch[key] = top !== undefined && top !== null ? top : nested ?? null
    }

    if (!DRY_RUN) {
      batch.update(doc.ref, patch)
      batchCount += 1
      if (batchCount >= BATCH_SIZE) {
        await batch.commit()
        batch = db.batch()
        batchCount = 0
      }
    }

    updated += 1
  }

  if (!DRY_RUN && batchCount > 0) await batch.commit()

  console.log(DRY_RUN
    ? `Dry run: would update ${updated}, skip ${skipped} (no nested metadata)`
    : `Updated ${updated}, skipped ${skipped}`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
