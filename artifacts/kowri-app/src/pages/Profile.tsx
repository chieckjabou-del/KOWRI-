import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { LogOut, User, Phone, MapPin, Shield } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

export default function Profile() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();

  function handleLogout() {
    logout();
    navigate("/login");
  }

  return (
    <div className="min-h-screen pb-20" style={{ background: "#FAFAF8" }}>
      <TopBar title="Mon Profil" />

      <main className="px-4 pt-5 max-w-lg mx-auto space-y-4">
        {/* Avatar card */}
        <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col items-center text-center">
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-black text-white mb-3"
            style={{ background: "linear-gradient(135deg, #1A6B32, #2D9148)" }}
          >
            {user?.firstName?.[0]}{user?.lastName?.[0]}
          </div>
          <h1 className="text-xl font-bold text-gray-900">
            {user?.firstName} {user?.lastName}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">{user?.phone}</p>
          <span
            className="mt-2 text-xs px-3 py-1 rounded-full font-medium capitalize"
            style={{ background: "#F0FDF4", color: "#16A34A" }}
          >
            {user?.status ?? "actif"}
          </span>
        </div>

        {/* Info */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <InfoRow icon={<User size={16} />} label="Nom complet" value={`${user?.firstName} ${user?.lastName}`} />
          <InfoRow icon={<Phone size={16} />} label="Téléphone" value={user?.phone ?? "—"} />
          <InfoRow icon={<MapPin size={16} />} label="Pays" value={user?.country ?? "—"} />
          <InfoRow icon={<Shield size={16} />} label="Statut du compte" value={user?.status ?? "actif"} last />
        </div>

        {/* Security */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <button className="w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-gray-50 transition-colors border-b border-gray-50">
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
