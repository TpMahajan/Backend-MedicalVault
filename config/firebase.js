import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import dotenv from "dotenv";

dotenv.config();

let firebaseApp = null;
let initializationError = null;

const normalizePrivateKey = (value) => String(value || "").replace(/\\n/g, "\n").trim();

function serviceAccountFromEnvironment() {
  const encoded = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (encoded) {
    try {
      const account = JSON.parse(encoded);
      if (account.project_id && account.client_email && account.private_key) {
        return { ...account, private_key: normalizePrivateKey(account.private_key) };
      }
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing required service-account fields");
  }

  const account = {
    project_id: String(process.env.FIREBASE_PROJECT_ID || "").trim(),
    client_email: String(process.env.FIREBASE_CLIENT_EMAIL || "").trim(),
    private_key: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
  };
  if (!account.project_id || !account.client_email || !account.private_key) {
    const missing = [
      !account.project_id && "FIREBASE_PROJECT_ID",
      !account.client_email && "FIREBASE_CLIENT_EMAIL",
      !account.private_key && "FIREBASE_PRIVATE_KEY",
    ].filter(Boolean);
    throw new Error(`Firebase credentials missing: ${missing.join(", ")}`);
  }
  return account;
}

export function initializeFirebase() {
  if (firebaseApp) return firebaseApp;
  try {
    const account = serviceAccountFromEnvironment();
    firebaseApp = getApps()[0] || initializeApp({ credential: cert(account), projectId: account.project_id });
    initializationError = null;
    console.info(`[fcm] initialized project=${account.project_id}`);
    return firebaseApp;
  } catch (error) {
    initializationError = error;
    // Credentials are deployment configuration. Never print the account or key.
    console.error(`[fcm] initialization unavailable: ${error.message}`);
    return null;
  }
}

export function getFirebaseMessaging() {
  const app = initializeFirebase();
  if (!app) throw initializationError || new Error("Firebase Admin is not configured");
  return getMessaging(app);
}

export function firebaseHealth() {
  const app = firebaseApp || getApps()[0];
  return { initialized: Boolean(app), projectId: app?.options?.projectId || null, error: initializationError?.message || null };
}

const stringData = (data) => Object.fromEntries(
  Object.entries(data || {}).flatMap(([key, value]) => value == null ? [] : [[key, typeof value === "string" ? value : JSON.stringify(value)]])
);

export async function sendPushNotification(token, notification, data = {}) {
  try {
    if (!String(token || "").trim()) return { success: false, code: "messaging/invalid-registration-token", error: "Missing registration token" };
    const imageUrl = /^https?:\/\//i.test(String(notification?.image || "")) ? notification.image : undefined;
    const messageId = await getFirebaseMessaging().send({
      token,
      notification: { title: String(notification?.title || "Notification"), body: String(notification?.body || ""), ...(imageUrl ? { imageUrl } : {}) },
      data: stringData(data),
      android: { priority: "high", notification: { channelId: "medical_vault_high", sound: "default", ...(imageUrl ? { imageUrl } : {}) } },
      apns: { payload: { aps: { sound: "default" } }, ...(imageUrl ? { fcmOptions: { imageUrl } } : {}) },
    });
    console.info("[fcm] send status=success");
    return { success: true, messageId };
  } catch (error) {
    console.warn(`[fcm] send status=failed code=${error?.code || "unknown"}`);
    return { success: false, error: error?.message || "FCM send failed", code: error?.code || null };
  }
}
