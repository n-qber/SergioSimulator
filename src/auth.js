/**
 * Serviço de Autenticação (Firebase Auth)
 * Suporte para Login com Google, E-mail/Senha e Convidado Anônimo.
 */

import { auth } from './firebase.js';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged, 
  signInAnonymously, 
  sendPasswordResetEmail, 
  updateProfile 
} from 'firebase/auth';

class AuthService {
  constructor() {
    this.user = null;
    this.isInitialized = false;
    this.listeners = new Set();
    this.googleProvider = new GoogleAuthProvider();
    this.googleProvider.setCustomParameters({ prompt: 'select_account' });

    this.init();
  }

  init() {
    if (!auth) {
      console.warn("Firebase Auth não disponível.");
      this.isInitialized = true;
      return;
    }

    onAuthStateChanged(auth, (firebaseUser) => {
      this.user = firebaseUser;
      this.isInitialized = true;
      this.notify();
    }, (error) => {
      console.error("Erro no observador de autenticação:", error);
      this.isInitialized = true;
      this.notify();
    });
  }

  // Notifica todos os ouvintes registrados sobre mudança de estado
  notify() {
    this.listeners.forEach(fn => {
      try {
        fn(this.user, this.isLoggedIn());
      } catch (err) {
        console.error("Erro no listener de auth:", err);
      }
    });
  }

  onUserChange(fn) {
    this.listeners.add(fn);
    if (this.isInitialized) {
      fn(this.user, this.isLoggedIn());
    }
    return () => this.listeners.delete(fn);
  }

  // Retorna true se houver usuário real logado (não anônimo)
  isLoggedIn() {
    return Boolean(this.user && !this.user.isAnonymous);
  }

  // Retorna true se estiver usando sessão anônima
  isAnonymous() {
    return Boolean(this.user && this.user.isAnonymous);
  }

  getCurrentUser() {
    return this.user;
  }

  getUid() {
    return this.user ? this.user.uid : null;
  }

  getDisplayName() {
    if (!this.user) return 'Convidado';
    if (this.user.displayName) return this.user.displayName;
    if (this.user.email) return this.user.email.split('@')[0];
    return 'Usuário';
  }

  getEmail() {
    return this.user?.email || null;
  }

  getPhotoURL() {
    return this.user?.photoURL || null;
  }

  // Login com Google via Popup
  async loginWithGoogle() {
    if (!auth) throw new Error("Firebase Auth não inicializado");
    try {
      const result = await signInWithPopup(auth, this.googleProvider);
      return result.user;
    } catch (err) {
      throw new Error(this.translateAuthError(err));
    }
  }

  // Login com E-mail e Senha
  async loginWithEmail(email, password) {
    if (!auth) throw new Error("Firebase Auth não inicializado");
    try {
      const result = await signInWithEmailAndPassword(auth, email.trim(), password);
      return result.user;
    } catch (err) {
      throw new Error(this.translateAuthError(err));
    }
  }

  // Cadastro com E-mail e Senha
  async registerWithEmail(email, password, displayName = '') {
    if (!auth) throw new Error("Firebase Auth não inicializado");
    try {
      const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (displayName && displayName.trim()) {
        await updateProfile(result.user, { displayName: displayName.trim() });
      }
      return result.user;
    } catch (err) {
      throw new Error(this.translateAuthError(err));
    }
  }

  // Recuperação de senha via e-mail
  async resetPassword(email) {
    if (!auth) throw new Error("Firebase Auth não inicializado");
    try {
      await sendPasswordResetEmail(auth, email.trim());
      return true;
    } catch (err) {
      throw new Error(this.translateAuthError(err));
    }
  }

  // Login Anônimo silencioso (para convidados terem credenciais se necessário)
  async ensureAnonymousUser() {
    if (!auth || this.user) return this.user;
    try {
      const result = await signInAnonymously(auth);
      return result.user;
    } catch (err) {
      console.warn("Login anônimo não concluído (modo offline permitido):", err.message);
      return null;
    }
  }

  // Sair da conta
  async logout() {
    if (!auth) return;
    try {
      await signOut(auth);
    } catch (err) {
      console.error("Erro ao deslogar:", err);
      throw new Error(this.translateAuthError(err));
    }
  }

  // Tradução amigável de erros do Firebase Auth
  translateAuthError(err) {
    const code = err.code || '';
    switch (code) {
      case 'auth/popup-closed-by-user':
        return 'Login cancelado: a janela do Google foi fechada.';
      case 'auth/popup-blocked':
        return 'O navegador bloqueou a janela de login. Por favor, autorize popups para este site.';
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
        return 'E-mail ou senha incorretos.';
      case 'auth/email-already-in-use':
        return 'Este e-mail já está cadastrado. Tente entrar ou recuperar sua senha.';
      case 'auth/invalid-email':
        return 'Formato de e-mail inválido.';
      case 'auth/weak-password':
        return 'A senha é muito fraca. Digite pelo menos 8 caracteres.';
      case 'auth/too-many-requests':
        return 'Muitas tentativas sem sucesso. Aguarde alguns instantes e tente novamente.';
      case 'auth/network-request-failed':
        return 'Falha de conexão com os servidores de autenticação.';
      case 'auth/operation-not-allowed':
        return 'Este método de login não está ativado no console do Firebase.';
      default:
        return err.message || 'Ocorreu um erro na autenticação.';
    }
  }
}

export const authService = new AuthService();
