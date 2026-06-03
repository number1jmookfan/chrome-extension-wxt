import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  where,
  type DocumentChange,
  type Firestore,
  type Unsubscribe
} from "firebase/firestore"

type CommChannel = {
  sendCommMsg: (data: CommDocMessage) => void
  commUnsub: Unsubscribe
}

export function initCommChannel(
  db: Firestore,
  sessionId: string,
  newCommMsgHandler: (data: CommDocMessage) => void
): CommChannel | undefined {
  const commColRef = collection(db, `comm/${sessionId}/messages`)
  const commQuery = query(
    commColRef,
    // This ensures that if the service worker is restarted,
    // it doesn't receive and process all the old messages.
    where("createdAt", ">", Timestamp.now()),
    orderBy("createdAt", "desc")
  )

  // Send Comm Msg Function
  const sendCommMsg = async (data: CommDocMessage) => {
    try {
      const commColRef = collection(db, `comm/${sessionId}/messages`)
      await addDoc(commColRef, { ...data, createdAt: serverTimestamp() })
      remoteLog("sent comm message", "info", { data })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      remoteLog("failed to send comm message", "error", {
        error: message
      })
    }
  }

  // Handle Comm Snapshot Changes
  const handleCommSnapshotChanges = (snap: {
    docChanges: () => DocumentChange[]
  }) => {
    snap.docChanges().forEach((change) => {
      remoteLog("comm snapshot change detected", "info", {
        changeType: change.type,
        changeData: change.doc.data()
      })

      switch (change.type) {
        case "added":
          newCommMsgHandler(change.doc.data() as CommDocMessage)
          break
        case "modified":
        case "removed":
          console.warn(`change type: ${change.type} not implemented`)
          break
        default:
          remoteLog("unknown change type detected", "error", {
            changeType: change.type
          })
      }
    })
  }

  try {
    const commUnsub = onSnapshot(
      commQuery,
      handleCommSnapshotChanges,
      (error) => {
        const message = error instanceof Error ? error.message : "Unknown error"
        remoteLog("error listening to comm channel", "error", {
          error: message
        })
      }
    )
    return {
      sendCommMsg,
      commUnsub
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    remoteLog("failed to initialize comm channel", "error", {
      error: message
    })
  }
}
