import { initializeApp } from "firebase/app"
import { addDoc, collection, getFirestore } from "firebase/firestore"
import { useState } from "react"

const app = initializeApp({
  apiKey: import.meta.env.WXT_PUBLIC_FIREBASE_API_KEY,
  projectId: import.meta.env.WXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: import.meta.env.WXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: import.meta.env.WXT_PUBLIC_FIREBASE_MEASUREMENT_ID
})
const db = getFirestore(app)

export default () => {
  const [count, setCount] = useState(1)
  const addToCookies = async () => {
    const col = collection(db, `comm/()=>"---austin_session4"/messages`)
    await addDoc(col, { test: "worked!" })
  }

  return (
    <div>
      <p>This is React. {count}</p>
      <button onClick={async () => await addToCookies()}>Increment</button>
    </div>
  )
}
