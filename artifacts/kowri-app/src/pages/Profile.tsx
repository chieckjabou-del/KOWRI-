import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { LogOut, User, Phone, MapPin, Shield, Camera, ChevronRight } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

const KYC_LIMIT_LABELS: Record<number, string> = {
  0: "100 000 XOF / mois",
  1: "1 000 000 XOF / mois",
  2: "10 000 000 XOF / mois",
};

const KYC_LEVEL_LABELS: Record<number, string> = {
  0: "Tier 0 — Téléphone vérifié",
  1: "Tier 1 — Identité vérifiée",
  2: "Tier 2 — Vérification complète",
};

export default function Profile() {
  const { user, logout, token } = useAuth();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  const { data: userData } = useQuery({
    queryKey: ["user", user?.id],
    queryFn: () => apiFetch<any>(`/users/${user?.id}`, token),
    enabled: !!user?.id,
  });

  const { data: kycData } = useQuery({
    queryKey: ["kyc", user?.id],
    queryFn: () => apiFetch<any>(`/users/${user?.id}/kyc`, token),
    enabled: !!user?.id,
  });

  const avatarMut = useMutation({
    mutationFn: (avatarBase64: string) =>
      apiFetch(`/users/${user?.id}/avatar`, token, {
        method: "PATCH",
        body: JSON.stringify({ avatarBase64 }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user"] }),
  });

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result as string;
      setAvatarPreview(b64);
      avatarMut.mutate(b64);
    };
    reader.readAsDataURL(file);
  }

  function handleLogout() {
    logout();
    navigate("/login");
  }

  const kycLevel: number = userData?.kycLevel ?? 0;
  const avatarUrl = avatarPreview ?? userData?.avatarUrl ?? null;
  const latestKyc = kycData?.record;

  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      <TopBar title="Mon Profil" />

      <main className="px-4 pt-5 max-w-lg mx-auto space-y-4">
        {/* Avatar card */}
        <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col items-center text-center">
          <div className="relative mb-3">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="Avatar"
                className="w-20 h-20 rounded-full object-cover border-2 border-gray-100"
              />
            ) : (
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-black text-white"
                style={{ background: "linear-gradient(135deg, #1A6B32, #2D9148)" }}
              >
                {user?.firstName?.[0]}{user?.lastName?.[0]}
              </div>
            )}
            <button
              onClick={() => fileRef.current?.click()}
              className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center hover:bg-gray-50 shadow-sm"
              title="Changer la photo"
            >
              <Camera size={13} className="text-gray-600" />
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
          </div>

          <h1 className="text-xl font-bold text-gray-900">{user?.firstName} {user?.lastName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{user?.phone}</p>
          <span
            className="mt-2 text-xs px-3 py-1 rounded-full font-medium capitalize"
            style={{ background: "#F0FDF4", color: "#16A34A" }}
          >
            {user?.status ?? "actif"}
          </span>

          {avatarMut.isPending && (
            <p className="text-xs text-gray-400 mt-2">Enregistrement…</p>
          )}
        </div>

        {/* KYC status card */}
        <button
          onClick={() => navigate("/kyc")}
          className="w-full bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden text-left"
        >
          <div className="flex items-center gap-3 px-4 py-4">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold"
              style={{ background: kycLevel === 0 ? "#6B7280" : kycLevel === 1 ? "#1A6B32" : "#1D4ED8" }}
            >
              {kycLevel}
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">{KYC_LEVEL_LABELS[kycLevel] ?? "Tier 0"}</p>
              <p className="text-xs text-gray-500">Plafond : {KYC_LIMIT_LABELS[kycLevel]}</p>
              {latestKyc?.status === "pending" && (
                <p className="text-xs text-amber-600 font-medium mt-0.5">Dossier en cours d'examen…</p>
              )}
            </div>
            <ChevronRight size={16} className="text-gray-400" />
          </div>
          {kycLevel < 2 && (
            <div className="border-t border-gray-50 px-4 py-2 bg-green-50">
              <p className="text-xs text-green-700 font-medium">
                Augmenter votre plafond → Soumettre un dossier KYC
              </p>
            </div>
          )}
        </button>

        {/* Info */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <InfoRow icon={<User size={16} />} label="Nom complet" value={`${user?.firstName} ${user?.lastName}`} />
          <InfoRow icon={<Phone size={16} />} label="Téléphone" value={user?.phone ?? "—"} />
          <InfoRow icon={<MapPin size={16} />} label="Pays" value={user?.country ?? "—"} />
          <InfoRow icon={<Shield size={16} />} label="Statut du compte" value={user?.status ?? "actif"} last />
        </div>

        {/* Security */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <button className="w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-gray-50 transition-colors">
            <Shield size={18} className="text-gray-500" />
            <div>
              <p className="text-sm font-medium text-gray-900">Changer mon PIN</p>
              <p className="text-xs text-gray-500">Sécurité du compte</p>
            </div>
          </button>
        </div>

        {/* Logout */}
        <button
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-semibold text-sm border border-red-100 bg-white"
          style={{ color: "#DC2626", minHeight: 52 }}
        >
          <LogOut size={18} />
          Se déconnecter
        </button>
      </main>

      <BottomNav />
    </div>
  );
}

function InfoRow({ icon, label, value, last }: { icon: React.ReactNode; label: string; value: string; last?: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-4 ${last ? "" : "border-b border-gray-50"}`}>
      <div className="text-gray-400">{icon}</div>
      <div className="flex-1">
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-sm font-medium text-gray-900">{value}</p>
      </div>
    </div>
  );
}
