/**
 * Configuração e Inicialização do Firebase
 * As chaves são carregadas com segurança a partir de variáveis de ambiente do Vite (.env)
 */

import { initializeApp, getApps } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyDcbHHp7fLMc_B9jh2Jh8TNfYXCmkOi5Ww",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "sergiosimulator-416ea.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "sergiosimulator-416ea",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "sergiosimulator-416ea.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "337917715273",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:337917715273:web:2c37953563ad779e74b098"
};

let app = null;
let db = null;

try {
  app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
  db = getFirestore(app);
} catch (err) {
  console.error("Falha ao inicializar o Firebase Firestore:", err);
}

export { app, db, firebaseConfig };
