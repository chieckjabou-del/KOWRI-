import { useState } from "react";
import { useLocation } from "wouter";
import { Link } from "wouter";
import { ChevronLeft, Eye, EyeOff, Loader2, CheckCircle2 } from "lucide-react";
import { useAuth, AuthUser } from "@/lib/auth";
import { apiFetch, buildApiUrl } from "@/lib/api";

const STEPS = ["Téléphone", "PIN", "Votre nom"] as const;

const INPUT_CLS = "w-full px-4 py-4 rounded-2xl border border-gray-200 bg-gray-50 text-gray-900 text-base focus:outline-none focus:border-[#1A6B32] transition-colors";

export default function Register() {
  const { login }    = useAuth();
  const [, navigate] = useLocation();

  const [step, setStep]     = useState(0);
  const [phone, setPhone]   = useState("");
  const [pin, setPin]       = useState("");
  const [pin2, setPin2]     = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName,  setLastName]  = useState("");
  const [showPin,   setShowPin]   = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");
  const [done,      setDone]      = useState(false);

  function validateStep(): string | null {
    if (step === 0) {
      if (!phone.trim()) return "Entrez votre numéro de téléphone";
      if (!/^\+?\d{8,15}$/.test(phone.replace(/\s/g, "")))
        return "Numéro invalide (ex: +2250700000000)";
    }
    if (step === 1) {
      if (!/^\d{4}$/.test(pin))  return "Le PIN doit contenir exactement 4 chiffres";
      if (pin !== pin2)           return "Les PIN ne correspondent pas";
    }
    if (step === 2) {
      if (!firstName.trim()) return "Entrez votre prénom";
    }
    return null;
  }

  async function handleNext() {
    setError("");
    const err = validateStep();
    if (err) { setError(err); return; }

    if (step < 2) {
      setStep(s => s + 1);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(buildApiUrl("/users"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone:     phone.replace(/\s/g, ""),
          pin,
          firstName: firstName.trim(),
          lastName:  lastName.trim() || "",
        }),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || j.error || `Erreur ${res.status}`);
      }

      setDone(true);
      setTimeout(async () => {
        try {
          const loginData = await apiFetch<{ token: string; user: AuthUser }>(
            "/users/login", null,
            { method: "POST", body: JSON.stringify({ phone: phone.replace(/\s/g, ""), pin }) }
          );
          login(loginData.token, loginData.user);
          navigate("/dashboard");
        } catch {
          navigate("/login");
        }
      }, 1500);
    } catch (e: any) {
      setError(e.message ?? "Inscription échouée. Réessayez.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#FAFAF8" }}>

      {/* ── Success overlay: always in DOM, shown via opacity/pointer-events ── */}
      <div
        style={{
          position: "fixed", inset: 0, zIndex: 50,
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "0 24px",
          background: "#FAFAF8",
          opacity: done ? 1 : 0,
          pointerEvents: done ? "auto" : "none",
          transition: "opacity 0.3s",
        }}
        aria-hidden={!done}
      >
        <div className="text-center">
          <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: "#F0FDF4" }}>
            <CheckCircle2 size={40} style={{ color: "#1A6B32" }} />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Bienvenue sur KOWRI !</h2>
          <p className="text-gray-500">Connexion en cours…</p>
        </div>
      </div>

      {/* ── Header ── */}
      <div className="px-4 pt-12 pb-4 max-w-lg mx-auto w-full">
        <div className="flex items-center gap-3 mb-6">

          {/* Both back-button and login-link ALWAYS in DOM — no type-change insertBefore */}
          <button
            onClick={() => { setStep(s => s - 1); setError(""); }}
            className="p-2 rounded-full hover:bg-gray-100"
            style={{ display: step > 0 ? "flex" : "none" }}
            aria-hidden={step === 0}
            tabIndex={step > 0 ? 0 : -1}
          >
            <ChevronLeft size={22} className="text-gray-700" />
          </button>
          <Link
            href="/login"
            className="p-2 rounded-full hover:bg-gray-100"
            style={{ display: step === 0 ? "flex" : "none" }}
            aria-hidden={step > 0}
            tabIndex={step === 0 ? 0 : -1}
          >
            <ChevronLeft size={22} className="text-gray-700" />
          </Link>

          <div className="flex-1">
            <div className="flex gap-1.5">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className="h-1.5 flex-1 rounded-full transition-all"
                  style={{ background: i <= step ? "#1A6B32" : "#E5E7EB" }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Branding */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center font-black text-xl text-white" style={{ background: "#1A6B32" }}>
            K
          </div>
          <span className="text-2xl font-black text-gray-900">KOWRI</span>
        </div>
      </div>

      {/* ── Form ── */}
      <div className="flex-1 px-4 max-w-lg mx-auto w-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">
            {step === 0 ? "Créer un compte" : step === 1 ? "Choisissez votre PIN" : "Comment vous appelez-vous ?"}
          </h1>
          <p className="text-gray-500 text-sm">
            {step === 0
              ? "Entrez votre numéro de téléphone mobile"
              : step === 1
              ? "Un code à 4 chiffres pour sécuriser votre compte"
              : "Votre prénom et nom (optionnel)"}
          </p>
        </div>

        <div className="space-y-4">

          {/* ─── Step 0: Phone ─── Always rendered, hidden via display:none */}
          <div style={{ display: step === 0 ? "block" : "none" }} aria-hidden={step !== 0}>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+2250700000000"
              inputMode="tel"
              tabIndex={step === 0 ? 0 : -1}
              className={INPUT_CLS}
              onKeyDown={e => { if (e.key === "Enter" && step === 0) handleNext(); }}
            />
          </div>

          {/* ─── Step 1: PIN ─── Always rendered, hidden via display:none */}
          <div style={{ display: step === 1 ? "block" : "none" }} aria-hidden={step !== 1} className="space-y-4">
            <div className="relative">
              <input
                type={showPin ? "text" : "password"}
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="••••"
                inputMode="numeric"
                maxLength={4}
                tabIndex={step === 1 ? 0 : -1}
                className={INPUT_CLS}
                style={{ letterSpacing: "0.5em", fontSize: 22 }}
              />
              <button
                type="button"
                onClick={() => setShowPin(v => !v)}
                tabIndex={step === 1 ? 0 : -1}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showPin ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <input
              type="password"
              value={pin2}
              onChange={e => setPin2(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="Confirmer le PIN"
              inputMode="numeric"
              maxLength={4}
              tabIndex={step === 1 ? 0 : -1}
              className={INPUT_CLS}
              style={{ letterSpacing: "0.5em", fontSize: 22 }}
              onKeyDown={e => { if (e.key === "Enter" && step === 1) handleNext(); }}
            />
          </div>

          {/* ─── Step 2: Name ─── Always rendered, hidden via display:none */}
          <div style={{ display: step === 2 ? "block" : "none" }} aria-hidden={step !== 2} className="space-y-4">
            <input
              type="text"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              placeholder="Prénom"
              tabIndex={step === 2 ? 0 : -1}
              className={INPUT_CLS}
            />
            <input
              type="text"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              placeholder="Nom de famille (optionnel)"
              tabIndex={step === 2 ? 0 : -1}
              className={INPUT_CLS}
              onKeyDown={e => { if (e.key === "Enter" && step === 2) handleNext(); }}
            />
          </div>

          {/* Error — always rendered, shown via display:none/block */}
          <div
            className="px-4 py-3 rounded-xl text-sm font-medium"
            style={{
              background: "#FEF2F2",
              color: "#DC2626",
              display: error ? "block" : "none",
            }}
          >
            {error || " "}
          </div>

          <button
            onClick={handleNext}
            disabled={loading}
            className="w-full py-4 rounded-2xl font-bold text-white text-base flex items-center justify-center gap-2 disabled:opacity-70 transition-opacity"
            style={{ background: "#1A6B32", minHeight: 56 }}
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : null}
            {step < 2 ? "Continuer" : loading ? "Création…" : "Créer mon compte"}
          </button>
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          Déjà un compte ?{" "}
          <Link href="/login">
            <span style={{ color: "#1A6B32" }} className="font-semibold">Se connecter</span>
          </Link>
        </p>
      </div>
    </div>
  );
}
