import { useState } from "react";
import { useLocation } from "wouter";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth, AuthUser } from "@/lib/auth";

const DEMO_PHONE = "+2250700000000";
const DEMO_PIN = "1234";

function buildDemoUser(phone: string): AuthUser {
  return {
    id: "demo-user",
    phone,
    firstName: "Compte",
    lastName: "Demo",
    status: "active",
    country: "CI",
  };
}

export default function Login() {
  const [, navigate] = useLocation();
  const { login } = useAuth();

  const [phone, setPhone]     = useState("");
  const [pin, setPin]         = useState("");
  const [showPin, setShowPin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim() || pin.length < 4) {
      setError("Numéro de téléphone et code PIN requis");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch<{ token: string; user: AuthUser }>(
        "/users/login",
        null,
        { method: "POST", body: JSON.stringify({ phone: phone.trim(), pin }) }
      );
      login(data.token, data.user);
      navigate("/dashboard");
    } catch (err: any) {
      const normalizedPhone = phone.trim();
      const isApiUnavailable = err?.status === 0 || err?.status === 404 || err?.status === 405;
      const canUseDemo = normalizedPhone === DEMO_PHONE && pin === DEMO_PIN;
      if (isApiUnavailable && canUseDemo) {
        login(`demo-token-${Date.now()}`, buildDemoUser(normalizedPhone));
        navigate("/dashboard");
        return;
      }
      if (isApiUnavailable) {
        setError("Connexion serveur indisponible. Utilisez le compte démo en attendant la remise en ligne.");
        return;
      }
      setError(err.message ?? "Identifiants incorrects");
    } finally {
      setLoading(false);
    }
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
        <h1 className="text-3xl font-black text-white tracking-tight">KOWRI</h1>
        <p className="text-white/70 text-sm mt-1">Votre super-app financière</p>
      </div>

      {/* Form */}
      <div className="flex-1 px-6 pt-8 pb-8 max-w-md mx-auto w-full">
        <h2 className="text-2xl font-bold text-gray-900 mb-1">Bienvenue</h2>
        <p className="text-gray-500 text-sm mb-8">Connectez-vous à votre compte</p>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl text-sm font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Code PIN (4 chiffres)
            </label>
            <div className="relative">
              <input
                type={showPin ? "text" : "password"}
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="••••"
                maxLength={4}
                inputMode="numeric"
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
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-4 rounded-2xl font-bold text-white text-base flex items-center justify-center gap-2 transition-opacity disabled:opacity-70"
            style={{ background: "#1A6B32", minHeight: 52 }}
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : null}
            Se connecter
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500">
          Pas encore de compte ?{" "}
          <a href="/register" className="font-semibold" style={{ color: "#1A6B32" }}>
            Créer un compte
          </a>
        </p>

        <div className="mt-6 px-4 py-3 rounded-xl text-xs text-center" style={{ background: "#F0FDF4", color: "#166534" }}>
          <p className="font-semibold mb-0.5">Compte démo</p>
          <p>Tél: <span className="font-mono">+2250700000000</span> &nbsp;|&nbsp; PIN: <span className="font-mono">1234</span></p>
        </div>
      </div>
    </div>
  );
}
