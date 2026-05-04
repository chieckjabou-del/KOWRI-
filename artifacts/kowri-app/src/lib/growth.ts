import { trackUxAction } from "@/lib/frontendMonitor";

const ATTRIBUTION_KEY = "akwe-growth-attribution-v1";
const DEFAULT_PUBLIC_APP_URL = "https://akwe.app";

export type GrowthAttribution = {
  referrerCode: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  capturedAt: string;
};

function safeReadAttribution(): GrowthAttribution | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ATTRIBUTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GrowthAttribution;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeWriteAttribution(payload: GrowthAttribution): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage errors
  }
}

export function readGrowthAttribution(): GrowthAttribution | null {
  return safeReadAttribution();
}

export function normalizePhoneInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) {
    return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  }
  return trimmed.replace(/\D/g, "");
}

export function captureGrowthAttributionFromUrl(): GrowthAttribution | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const referrerCode = params.get("ref")?.trim().toUpperCase() ?? null;
  const utmSource = params.get("utm_source")?.trim() ?? null;
  const utmMedium = params.get("utm_medium")?.trim() ?? null;
  const utmCampaign = params.get("utm_campaign")?.trim() ?? null;

  if (!referrerCode && !utmSource && !utmMedium && !utmCampaign) {
    return safeReadAttribution();
  }

  const payload: GrowthAttribution = {
    referrerCode,
    utmSource,
    utmMedium,
    utmCampaign,
    capturedAt: new Date().toISOString(),
  };
  safeWriteAttribution(payload);
  trackUxAction("growth.referral.invite_opened", {
    referrerCode: referrerCode ?? "",
    utmSource: utmSource ?? "",
    utmMedium: utmMedium ?? "",
    utmCampaign: utmCampaign ?? "",
    landingPath: window.location.pathname,
  });
  return payload;
}

function sanitizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

export function makeReferralCodeFromUserId(userId: string | null | undefined): string {
  if (!userId) return "";
  return userId.slice(0, 8).toUpperCase();
}

export function getPublicAppBaseUrl(): string {
  const envValue =
    typeof import.meta !== "undefined" &&
    typeof import.meta.env?.VITE_PUBLIC_APP_URL === "string"
      ? import.meta.env.VITE_PUBLIC_APP_URL.trim()
      : "";
  const base = envValue || DEFAULT_PUBLIC_APP_URL;
  return base.replace(/\/$/, "");
}

export function buildReferralInviteLink(referrerCode: string): string {
  const base = getPublicAppBaseUrl();
  const code = sanitizeCode(referrerCode);
  const params = new URLSearchParams({
    ref: code,
    utm_source: "whatsapp",
    utm_medium: "referral",
    utm_campaign: "growth-mode",
  });
  return `${base}/register?${params.toString()}`;
}

export function buildWhatsAppShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

export function buildWhatsAppInviteMessage(options: {
  inviteLink: string;
  referrerCode: string;
  firstName?: string | null;
}): string {
  const namePrefix = options.firstName ? `Salut, c'est ${options.firstName} 👋\n` : "Salut 👋\n";
  return `${namePrefix}Je gere mes tontines et paiements sur AKWE.\nInscris-toi avec mon code ${options.referrerCode} via ce lien: ${options.inviteLink}\nBonus de bienvenue apres ta premiere operation eligible ✅`;
}
