import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Home, Users, Send, Globe, User,
  MoreHorizontal, BarChart3, Shield, Star, PiggyBank,
  TrendingUp, Store, ShieldCheck, X, MessageSquare,
} from "lucide-react";

const PRIMARY_TABS = [
  { href: "/dashboard",  label: "Accueil",  Icon: Home  },
  { href: "/tontines",   label: "Tontines", Icon: Users },
  { href: "/send",       label: "Envoyer",  Icon: Send  },
  { href: "/diaspora",   label: "Diaspora", Icon: Globe },
  { href: "/profile",    label: "Profil",   Icon: User  },
];

const MORE_ITEMS = [
  { href: "/credit",    label: "Crédit",      Icon: TrendingUp, color: "#1A6B32" },
  { href: "/savings",   label: "Épargne",     Icon: PiggyBank,  color: "#D97706" },
  { href: "/invest",    label: "Investir",    Icon: BarChart3,  color: "#2563EB" },
  { href: "/insurance", label: "Assurance",   Icon: Shield,     color: "#7C3AED" },
  { href: "/creator",   label: "Créateur",    Icon: Star,       color: "#EA580C" },
  { href: "/merchant",  label: "Marchand",    Icon: Store,      color: "#0891B2" },
  { href: "/agent",     label: "Agent",       Icon: ShieldCheck,color: "#065F46" },
  { href: "/support",   label: "Support",     Icon: MessageSquare, color: "#6B7280" },
];

const MORE_ACTIVE_PREFIXES = [
  "/invest", "/insurance", "/creator", "/merchant", "/agent", "/support",
  "/credit", "/savings",
];

export function BottomNav() {
  const [location] = useLocation();
  const [showMore, setShowMore] = useState(false);

  const isMoreActive = MORE_ACTIVE_PREFIXES.some(p => location.startsWith(p));

  return (
    <div>
      <div
        className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.35)", display: showMore ? "block" : "none" }}
        onClick={() => setShowMore(false)}
      />

      <div
        className="fixed left-0 right-0 z-50 bg-white rounded-t-3xl shadow-2xl border-t border-gray-100 max-w-lg mx-auto"
        style={{
          bottom: "calc(56px + env(safe-area-inset-bottom))",
          display: showMore ? "block" : "none",
        }}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <p className="font-bold text-gray-900 text-sm">Autres services</p>
          <button
            onClick={() => setShowMore(false)}
            className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center"
          >
            <X size={14} className="text-gray-600" />
          </button>
        </div>
        <div className="px-4 pb-5 grid grid-cols-4 gap-2">
          {MORE_ITEMS.map(({ href, label, Icon, color }) => {
            const active = location.startsWith(href);
            return (
              <Link key={href} href={href} onClick={() => setShowMore(false)}>
                <div
                  className="flex flex-col items-center gap-1.5 py-3 rounded-2xl border transition-all cursor-pointer"
                  style={{
                    background:   active ? `${color}15` : "#F9FAFB",
                    borderColor:  active ? color : "#F3F4F6",
                  }}
                >
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center"
                    style={{ background: active ? `${color}25` : "#FFFFFF" }}
                  >
                    <Icon size={18} style={{ color: active ? color : "#6B7280" }} strokeWidth={active ? 2.5 : 1.8} />
                  </div>
                  <span
                    className="text-[10px] font-semibold text-center leading-tight"
                    style={{ color: active ? color : "#6B7280" }}
                  >
                    {label}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      <nav
        className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-100"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center justify-around max-w-lg mx-auto">
          {PRIMARY_TABS.map(({ href, label, Icon }) => {
            const active = location === href || (href !== "/dashboard" && location.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                className="flex flex-col items-center gap-0.5 py-3 px-1.5 min-h-[56px] min-w-[52px] transition-colors"
                style={{ color: active ? "#1A6B32" : "#9CA3AF" }}
              >
                <Icon size={21} strokeWidth={active ? 2.5 : 1.8} />
                <span className="text-[9px] font-medium">{label}</span>
              </Link>
            );
          })}

          <button
            onClick={() => setShowMore(v => !v)}
            className="flex flex-col items-center gap-0.5 py-3 px-1.5 min-h-[56px] min-w-[52px] transition-colors"
            style={{ color: isMoreActive ? "#1A6B32" : "#9CA3AF" }}
          >
            <MoreHorizontal size={21} strokeWidth={isMoreActive ? 2.5 : 1.8} />
            <span className="text-[9px] font-medium">Plus</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
