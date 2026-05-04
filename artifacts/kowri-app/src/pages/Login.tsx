import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Apple, Eye, EyeOff, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { normalizePhoneInput, readGrowthAttribution } from "@/lib/growth";
import { trackUxAction } from "@/lib/frontendMonitor";
import {
  enableBiometric,
  loginWithBiometric,
  loginWithPin,
  loginWithSocial,
  requestOtp,
  verifyOtp,
  type AuthFastProviders,
  type AuthMeta,
  type AuthSuccessResponse,
} from "@/services/api/authService";
import {
  generateBiometricUnlockToken,
  getBiometricUnlockToken,
  getBiometricUserId,
  hasBiometricEnabledLocally,
  persistBiometricUnlockToken,
  persistBiometricUserId,
} from "@/lib/biometricUnlock";

export default function Login() {
  const [, navigate] = useLocation();
  const { login } = useAuth();

  const [phone, setPhone]     = useState("");
  const [pin, setPin]         = useState("");
  const [otp, setOtp]         = useState("");
  const [otpChallengeId, setOtpChallengeId] = useState<string | null>(null);
  const [otpExpiresAt, setOtpExpiresAt] = useState<string | null>(null);
  const [otpRequested, setOtpRequested] = useState(false);
  const [otpDebug, setOtpDebug] = useState<string | null>(null);
  const [showPin, setShowPin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [fastProviders, setFastProviders] = useState<AuthFastProviders>({
    googleEnabled: import.meta.env.VITE_AUTH_GOOGLE_ENABLED === "1",
    appleEnabled: import.meta.env.VITE_AUTH_APPLE_ENABLED === "1",
  });
  const [authMeta, setAuthMeta] = useState<AuthMeta | null>(null);
  const [deviceId] = useState(() => {
    if (typeof window === "undefined") return "server-device";
    const key = "akwe-device-id-v1";
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    window.localStorage.setItem(key, created);
    return created;
  });
  const attribution = useMemo(() => readGrowthAttribution(), []);
  const biometricEnabled = hasBiometricEnabledLocally();
  const hasBiometricToken = Boolean(getBiometricUnlockToken());
  const biometricUserId = getBiometricUserId();

  useEffect(() => {
    if (authMeta) {
      trackUxAction("growth.auth.risk_meta_received", {
        suspicious: authMeta.suspicious,
        riskScore: authMeta.riskScore,
        deviceTrustScore: authMeta.deviceTrustScore,
        kycLevel: authMeta.kyc.level,
      });
    }
  }, [authMeta]);

  useEffect(() => {
    trackUxAction("growth.auth.login_viewed", {
      screen: "login",
      hasPrefilledPhone: Boolean(phone.trim()),
      source: "app",
      utmSource: attribution?.utmSource ?? "",
      utmMedium: attribution?.utmMedium ?? "",
      utmCampaign: attribution?.utmCampaign ?? "",
      referrerCode: attribution?.referrerCode ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitOtpRequest(): Promise<void> {
    const normalizedPhone = normalizePhoneInput(phone);
    if (!normalizedPhone) {
      setError("Numero de telephone requis");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await requestOtp({
        phone: normalizedPhone,
        purpose: "login",
        deviceId,
        deviceLabel: "mobile-primary",
      });
      setOtpChallengeId(response.challengeId);
      setOtpExpiresAt(response.expiresAt);
      setOtpRequested(true);
      setOtpDebug(response.debugOtp ?? null);
      setFastProviders(response.fastProviders);
      trackUxAction("growth.auth.otp_requested", {
        phoneCountryCode: normalizedPhone.startsWith("+225") ? "+225" : "other",
      });
    } catch (err: any) {
      setError(err.message ?? "Impossible d'envoyer OTP");
    } finally {
      setLoading(false);
    }
  }

  async function submitOtpVerification(): Promise<void> {
    const normalizedPhone = normalizePhoneInput(phone);
    if (!normalizedPhone || !otpChallengeId || otp.length < 6) {
      setError("OTP invalide");
      return;
    }
    const startedAt = Date.now();
    trackUxAction("growth.auth.login_otp_submitted", {
      phoneCountryCode: normalizedPhone.startsWith("+225") ? "+225" : "other",
      phoneLength: normalizedPhone.length,
      hasOtp: otp.length === 6,
    });
    setLoading(true);
    setError("");
    try {
      const data = await verifyOtp({
        challengeId: otpChallengeId,
        phone: normalizedPhone,
        otp,
        deviceId,
        deviceLabel: "mobile-primary",
      });
      setAuthMeta(data.authMeta ?? null);
      trackUxAction("growth.auth.login_success", {
        userId: data.user.id,
        ttfLoginMs: Date.now() - startedAt,
        method: "otp",
      });
      login(data.token, data.user);
      if (!hasBiometricToken) {
        const token = generateBiometricUnlockToken();
        await enableBiometricUnlock(data.user.id, token);
      }
      navigate("/dashboard");
    } catch (err: any) {
      trackUxAction("growth.auth.login_failed", {
        errorMessage: err?.message ?? "unknown",
      });
      setError(err.message ?? "OTP invalide");
    } finally {
      setLoading(false);
    }
  }

  async function submitPinFallback(redirectOnSuccess = true): Promise<AuthSuccessResponse | null> {
    const normalizedPhone = normalizePhoneInput(phone);
    if (!normalizedPhone || pin.length < 4) {
      setError("Numero de telephone et code PIN requis");
      return;
    }
    const startedAt = Date.now();
    setLoading(true);
    setError("");
    try {
      const data = await loginWithPin({
        phone: normalizedPhone,
        pin,
        deviceId,
        deviceLabel: "mobile-fallback-pin",
      });
      setAuthMeta(data.authMeta ?? null);
      trackUxAction("growth.auth.login_success", {
        userId: data.user.id,
        ttfLoginMs: Date.now() - startedAt,
        method: "pin",
      });
      login(data.token, data.user);
      if (redirectOnSuccess) {
        navigate("/dashboard");
      }
      return data;
    } catch (err: any) {
      setError(err.message ?? "Identifiants incorrects");
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function submitSocial(provider: "google" | "apple"): Promise<void> {
    const normalizedPhone = normalizePhoneInput(phone);
    if (!normalizedPhone) {
      setError("Numero requis pour associer le fast login");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await loginWithSocial({
        provider,
        phone: normalizedPhone,
        deviceId,
        deviceLabel: "mobile-social",
      });
      setAuthMeta(data.authMeta ?? null);
      login(data.token, data.user);
      navigate("/dashboard");
    } catch (err: any) {
      setError(err.message ?? `${provider} indisponible`);
    } finally {
      setLoading(false);
    }
  }

  async function submitBiometric(): Promise<void> {
    const unlockToken = getBiometricUnlockToken();
    if (!unlockToken || !biometricUserId) {
      setError("Biometrie non disponible sur cet appareil");
      return;
    }
    setLoading(true);
    setError("");
    try {
      let resolvedUserId = biometricUserId;
      if (pin.length === 4) {
        const fallback = await submitPinFallback(false);
        if (fallback?.user.id) {
          resolvedUserId = fallback.user.id;
        }
      }
      const data = await loginWithBiometric({
        userId: resolvedUserId,
        unlockToken,
        deviceId,
        deviceLabel: "mobile-biometric",
      });
      setAuthMeta(data.authMeta ?? null);
      login(data.token, data.user);
      navigate("/dashboard");
    } catch (err: any) {
      setError(err.message ?? "Echec de connexion biometrie");
    } finally {
      setLoading(false);
    }
  }

  async function enableBiometricUnlock(userId: string, token: string): Promise<void> {
    await requestAnimationFramePromise();
    await enableBiometric({
      userId,
      unlockToken: token,
      deviceId,
      deviceLabel: "mobile-primary",
    });
    persistBiometricUnlockToken(token);
    persistBiometricUserId(userId);
  }

  function requestAnimationFramePromise(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => resolve());
    });
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#FAFAF8" }}>
      {/* Hero */}
      <div
        className="flex flex-col items-center justify-center pt-16 pb-12 px-6"
        style={{ background: "linear-gradient(160deg, #1A6B32 0%, #2D9148 100%)" }}
      >
        <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center mb-4">
          <span className="text-white text-2xl font-black">K</span>
        </div>
        <h1 className="text-3xl font-black text-white tracking-tight">AKWÊ</h1>
        <p className="text-white/70 text-sm mt-1">Votre super-app financière</p>
      </div>

      {/* Form */}
      <div className="flex-1 px-6 pt-8 pb-8 max-w-md mx-auto w-full">
        <h2 className="text-2xl font-bold text-gray-900 mb-1">Bienvenue</h2>
        <p className="text-gray-500 text-sm mb-8">Numero + OTP en primaire, PIN en fallback securise.</p>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl text-sm font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
            {error}
          </div>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!otpRequested) {
              void submitOtpRequest();
            } else {
              void submitOtpVerification();
            }
          }}
          className="flex flex-col gap-4"
        >
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Numéro de téléphone
            </label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+2250700000000"
              className="w-full px-4 py-3.5 rounded-2xl border border-gray-200 bg-white text-gray-900 text-base focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ minHeight: 52, "--tw-ring-color": "#1A6B32" } as any}
              autoComplete="tel"
              inputMode="tel"
              enterKeyHint="next"
            />
            <p className="mt-1 text-xs text-gray-500">
              Connecte-toi avec ton numéro mobile (Orange, MTN, Moov).
            </p>
          </div>

          {otpRequested ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Code OTP (6 chiffres)
              </label>
              <input
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
                enterKeyHint="go"
                className="w-full px-4 py-3.5 rounded-2xl border border-gray-200 bg-white text-gray-900 text-base focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ minHeight: 52 }}
              />
              <p className="mt-1 text-xs text-gray-500">
                OTP valide jusqu'a {otpExpiresAt ? new Date(otpExpiresAt).toLocaleTimeString() : "..."}.
              </p>
              {otpDebug ? (
                <p className="mt-1 text-xs font-medium text-emerald-700">
                  OTP debug: {otpDebug}
                </p>
              ) : null}
            </div>
          ) : null}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              PIN fallback (4 chiffres)
            </label>
            <div className="relative">
              <input
                type={showPin ? "text" : "password"}
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="••••"
                maxLength={4}
                inputMode="numeric"
                autoComplete="one-time-code"
                enterKeyHint="go"
                className="w-full px-4 py-3.5 pr-12 rounded-2xl border border-gray-200 bg-white text-gray-900 text-base focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ minHeight: 52 }}
              />
              <button
                type="button"
                onClick={() => setShowPin(p => !p)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400"
              >
                {showPin ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              En cas d'OTP indisponible, utilise ce PIN localement securise.
            </p>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-4 rounded-2xl font-bold text-white text-base flex items-center justify-center gap-2 transition-opacity disabled:opacity-70"
            style={{ background: "#1A6B32", minHeight: 52 }}
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : null}
            {otpRequested ? "Verifier OTP et se connecter" : "Recevoir OTP"}
          </button>
        </form>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => void submitPinFallback()}
            disabled={loading}
            className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-700"
          >
            Connexion PIN fallback
          </button>
          <button
            type="button"
            onClick={() => void submitBiometric()}
            disabled={loading || !biometricEnabled}
            className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-700 disabled:opacity-50"
          >
            Deverrouiller par biometrie
          </button>
          <button
            type="button"
            onClick={() => void submitSocial("google")}
            disabled={loading || !fastProviders.googleEnabled}
            className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-700 disabled:opacity-50"
          >
            Continuer avec Google
          </button>
          <button
            type="button"
            onClick={() => void submitSocial("apple")}
            disabled={loading || !fastProviders.appleEnabled}
            className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-700 disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-2">
              <Apple size={14} />
              Continuer avec Apple
            </span>
          </button>
        </div>

        {authMeta ? (
          <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">
            <p className="font-semibold">Securite activee</p>
            <p>
              Trust device: {authMeta.deviceTrustScore}/100 • Risque: {authMeta.riskScore}/100 •
              KYC niveau {authMeta.kyc.level}
            </p>
            <p className="mt-1">{authMeta.kyc.nextLevelHint}</p>
          </div>
        ) : null}

        <p className="mt-6 text-center text-sm text-gray-500">
          Pas encore de compte ?{" "}
          <Link href="/register" className="font-semibold" style={{ color: "#1A6B32" }}>
            Créer un compte
          </Link>
        </p>

        <div className="mt-6 px-4 py-3 rounded-xl text-xs text-center" style={{ background: "#F0FDF4", color: "#166534" }}>
          <p className="font-semibold mb-0.5">Compte demo</p>
          <p>Tél: <span className="font-mono">+2250700000000</span> &nbsp;|&nbsp; PIN: <span className="font-mono">1234</span></p>
        </div>
      </div>
    </div>
  );
}

