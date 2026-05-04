const BIOMETRIC_UNLOCK_KEY = "akwe-biometric-unlock-token-v1";
const BIOMETRIC_ENABLED_KEY = "akwe-biometric-enabled-v1";
const BIOMETRIC_USER_ID_KEY = "akwe-biometric-user-id-v1";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

export function hasBiometricEnabledLocally(): boolean {
  if (!canUseStorage()) return false;
  try {
    return window.localStorage.getItem(BIOMETRIC_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function getBiometricUnlockToken(): string | null {
  if (!canUseStorage()) return null;
  try {
    return window.localStorage.getItem(BIOMETRIC_UNLOCK_KEY);
  } catch {
    return null;
  }
}

export function getBiometricUserId(): string | null {
  if (!canUseStorage()) return null;
  try {
    return window.localStorage.getItem(BIOMETRIC_USER_ID_KEY);
  } catch {
    return null;
  }
}

export function persistBiometricUnlockToken(token: string): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(BIOMETRIC_UNLOCK_KEY, token);
    window.localStorage.setItem(BIOMETRIC_ENABLED_KEY, "1");
  } catch {
    // ignore storage failures
  }
}

export function persistBiometricUserId(userId: string): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(BIOMETRIC_USER_ID_KEY, userId);
  } catch {
    // ignore storage failures
  }
}

export function clearBiometricUnlockToken(): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(BIOMETRIC_UNLOCK_KEY);
    window.localStorage.removeItem(BIOMETRIC_ENABLED_KEY);
    window.localStorage.removeItem(BIOMETRIC_USER_ID_KEY);
  } catch {
    // ignore storage failures
  }
}

export function generateBiometricUnlockToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `bio-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
