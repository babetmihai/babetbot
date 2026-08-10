import admin from "firebase-admin"


const { FIREBASE_PROJECT_ID } = process.env

if (!admin.apps.length) {
  admin.initializeApp({ projectId: FIREBASE_PROJECT_ID })
}

const db = admin.firestore()
db.settings({ ignoreUndefinedProperties: true })

export const FieldValue = admin.firestore.FieldValue
export const FieldPath = admin.firestore.FieldPath

export default db

export const deleteQueryDocs = async (query) => {
  const snapshot = await query.get()
  if (snapshot.empty) return

  let batch = db.batch()
  let count = 0

  for (const doc of snapshot.docs) {
    batch.delete(doc.ref)
    count += 1
    if (count >= 400) {
      await batch.commit()
      batch = db.batch()
      count = 0
    }
  }

  if (count > 0) {
    await batch.commit()
  }
}
