// My Firebase Details
const firebaseConfig = {
  apiKey: "AIzaSyArKIYCeyX8P5EIYZQ7jAg-g4DA_nWEJ_E",
  authDomain: "expansion-draft.firebaseapp.com",
  projectId: "expansion-draft",
  storageBucket: "expansion-draft.firebasestorage.app",
  messagingSenderId: "564825367944",
  appId: "1:564825367944:web:3e254205066c5c9ad0063d"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Export Firestore save/load functions
export async function saveToFirebase(key, value) {
    try {
        await db.collection('expansion_draft').doc(key).set({
            data: value,
            updated: firebase.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Saved ${key} to Firebase`);
    } catch (error) {
        console.error('Firebase save error:', error);
    }
}

export async function loadFromFirebase(key) {
    try {
        const doc = await db.collection('expansion_draft').doc(key).get();
        if (doc.exists) {
            return doc.data().data;
        }
        return null;
    } catch (error) {
        console.error('Firebase load error:', error);
        return null;
    }
}

export function listenToFirebase(key, callback) {
    return db.collection('expansion_draft').doc(key).onSnapshot(doc => {
        if (doc.exists) {
            callback(doc.data().data);
        }
    });
}