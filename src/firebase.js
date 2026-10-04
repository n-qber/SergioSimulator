/**
 * Configuração e Inicialização do Firebase
 * As chaves são carregadas com segurança a partir de variáveis de ambiente do Vite (.env)
 */

import { initializeApp, getApps } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || "AIzaSyDcbHHp7fLMc_B9jh2Jh8TNfYXCmkOi5Ww",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || "sergiosimulator-416ea.firebaseapp.com",
  projectId: env.VITE_FIREBASE_PROJECT_ID || "sergiosimulator-416ea",
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || "sergiosimulator-416ea.firebasestorage.app",
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || "337917715273",
  appId: env.VITE_FIREBASE_APP_ID || "1:337917715273:web:2c37953563ad779e74b098"
};

let app = null;
let db = null;
let auth = null;

try {
  app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
  db = getFirestore(app);
  auth = getAuth(app);
} catch (err) {
  console.error("Falha ao inicializar o Firebase:", err);
}

export { app, db, auth, firebaseConfig };
