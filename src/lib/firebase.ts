import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type { CreditTransaction, Project, StudioUserAccount, UserCreditWallet } from '../types/domain';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

function sanitizeId(raw: string): string {
  return String(raw || 'item')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 120) || 'item';
}

export async function signInWithGooglePopup(): Promise<StudioUserAccount> {
  const credential = await signInWithPopup(auth, googleProvider);
  const user = credential.user;
  return mapFirebaseUserToStudioAccount(user);
}

export async function signOutStudioUser(): Promise<void> {
  await signOut(auth);
}

export function subscribeToStudioAuth(
  callback: (user: StudioUserAccount | null) => void
): () => void {
  return onAuthStateChanged(auth, (firebaseUser) => {
    if (!firebaseUser) {
      callback(null);
      return;
    }
    callback(mapFirebaseUserToStudioAccount(firebaseUser));
  });
}

export function mapFirebaseUserToStudioAccount(user: User): StudioUserAccount {
  return {
    uid: sanitizeId(user.uid),
    displayName: (user.displayName || user.email?.split('@')[0] || 'Studio Operator').slice(0, 120),
    email: (user.email || 'operator@stratastudio.app').slice(0, 254),
    photoURL: (user.photoURL || '').slice(0, 1024),
    emailVerified: Boolean(user.emailVerified),
    provider: 'google',
  };
}

export async function syncUserWalletToFirestore(
  user: StudioUserAccount,
  wallet: UserCreditWallet
): Promise<void> {
  if (!auth.currentUser || !auth.currentUser.emailVerified) return;
  const uid = sanitizeId(auth.currentUser.uid);
  const path = `users/${uid}`;
  const docRef = doc(db, 'users', uid);

  const payload = {
    uid,
    displayName: (user.displayName || 'Studio Operator').slice(0, 120),
    email: (user.email || 'operator@stratastudio.app').slice(0, 254),
    photoURL: (user.photoURL || '').slice(0, 1024),
    creditBalance: Math.max(0, Math.min(10000000, Math.round(wallet.balance))),
    lifetimeCreditsAdded: Math.max(0, Math.min(10000000, Math.round(wallet.lifetimeCreditsAdded))),
    lifetimeCreditsUsed: Math.max(0, Math.min(10000000, Math.round(wallet.lifetimeCreditsUsed))),
    autoRechargeEnabled: Boolean(wallet.autoRechargeEnabled),
    updatedAt: new Date().toISOString().slice(0, 64),
  };

  try {
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      await setDoc(docRef, payload);
    } else {
      await updateDoc(docRef, {
        displayName: payload.displayName,
        email: payload.email,
        photoURL: payload.photoURL,
        creditBalance: payload.creditBalance,
        lifetimeCreditsAdded: payload.lifetimeCreditsAdded,
        lifetimeCreditsUsed: payload.lifetimeCreditsUsed,
        autoRechargeEnabled: payload.autoRechargeEnabled,
        updatedAt: payload.updatedAt,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }
}

export async function syncProjectSummaryToFirestore(
  project: Project,
  transcriptCount: number,
  clipCount: number
): Promise<void> {
  if (!auth.currentUser || !auth.currentUser.emailVerified) return;
  const uid = sanitizeId(auth.currentUser.uid);
  const cleanProjectId = sanitizeId(`${uid}_${project.id}`);
  const path = `projects/${cleanProjectId}`;
  const docRef = doc(db, 'projects', cleanProjectId);

  const payload = {
    projectId: cleanProjectId,
    ownerId: uid,
    name: (project.name || 'Untitled Project').slice(0, 200),
    brandProfileId: sanitizeId(project.brandId || 'brand-default'),
    primaryObjective: (project.primaryObjective || '').slice(0, 1000),
    transcriptCount: Math.max(0, Math.min(100000, transcriptCount)),
    clipCount: Math.max(0, Math.min(10000, clipCount)),
    updatedAt: new Date().toISOString().slice(0, 64),
  };

  try {
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      await setDoc(docRef, payload);
    } else {
      await updateDoc(docRef, {
        name: payload.name,
        brandProfileId: payload.brandProfileId,
        primaryObjective: payload.primaryObjective,
        transcriptCount: payload.transcriptCount,
        clipCount: payload.clipCount,
        updatedAt: payload.updatedAt,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }
}

export async function syncCreditTransactionToFirestore(
  tx: CreditTransaction
): Promise<void> {
  if (!auth.currentUser || !auth.currentUser.emailVerified) return;
  const uid = sanitizeId(auth.currentUser.uid);
  const txId = sanitizeId(tx.id);
  const path = `creditTransactions/${txId}`;
  const docRef = doc(db, 'creditTransactions', txId);

  const payload = {
    txId,
    ownerId: uid,
    type: tx.type,
    operation: (tx.operation || 'studio_op').slice(0, 64),
    description: (tx.description || 'Credit operation').slice(0, 300),
    amount: Math.max(-100000, Math.min(1000000, Math.round(tx.amount))),
    balanceAfter: Math.max(0, Math.min(10000000, Math.round(tx.balanceAfter))),
    createdAt: (tx.createdAt || new Date().toISOString()).slice(0, 64),
  };

  try {
    await setDoc(docRef, payload);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }
}
