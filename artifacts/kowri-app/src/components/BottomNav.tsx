import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Home, Users, TrendingUp, PiggyBank, Globe,
  MoreHorizontal, BarChart3, Shield, Star, X,
} from "lucide-react";

const PRIMARY_TABS = [
  { href: "/dashboard", label: "Accueil",  Icon: Home       },
  { href: "/tontines",  label: "Tontines", Icon: Users      },
  { href: "/credit",    label: "Crédit",   Icon: TrendingUp },
  { href: "/savings",   label: "Épargne",  Icon: PiggyBank  },
  { href: "/diaspora",  label: "Diaspora", Icon: Globe      },
];

const MORE_ITEMS = [
  { href: "/invest",    label: "Investir",   Icon: BarChart3, color: "#1A6B32" },
  { href: "/insurance", label: "Assurance",  Icon: Shield,    color: "#2563EB" },
  { href: "/creator",   label: "Créateur",   Icon: Star,      color: "#D97706" },
];

export function BottomNav() {
  const [location] = useLocation();
  const [showMore, setShowMore] = useState(false);

  const isMoreActive =
    location.startsWith("/invest") ||
    location.startsWith("/insurance") ||
    location.startsWith("/creator");

  return (
    <>
      {/* Overlay for "More" drawer */}
      {showMore && (
        <div
          className="fixed inset-0 z-40"
          style={{ background: "rgba(0,0,0,0.3)" }}
          onClick={() => setShowMore(false)}
        />
      )}

      {/* More drawer */}
      {showMore && (
        <div
          className="fixed left-0 right-0 z-50 bg-white rounded-t-3xl shadow-xl border-t border-gray-100"
          style={{ bottom: "calc(56px + env(safe-area-inset-bottom))" }}
        >
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <p className="font-bold text-gray-900 text-sm">Autres services</p>
            <button
              onClick={() => setShowMore(false)}
              className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center"
            >
              <X size={14} className="text-gray-600" />
            </button>
          </div>
          <div className="px-4 pb-5 grid grid-cols-3 gap-3">
            {MORE_ITEMS.map(({ href, label, Icon, color }) => {
              const active = location.startsWith(href);
              return (
                <Link key={href} href={href} onClick={() => setShowMore(false)}>
                  <div
                    className="flex flex-col items-center gap-2 py-4 rounded-2xl border transition-all"
                    style={{
                      background: active ? `${color}10` : "#F9FAFB",
                      borderColor: active ? color : "#F3F4F6",
                    }}
                  >
                    <div
                      className="w-11 h-11 rounded-xl flex items-center justify-center"
                      style={{ background: active ? `${color}20` : "#FFFFFF" }}
                    >
                      <Icon size={22} style={{ color: active ? color : "#6B7280" }} strokeWidth={active ? 2.5 : 1.8} />
                    </div>
                    <span
                      className="text-xs font-semibold"
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
      )}

      {/* Main nav bar */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-100"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center justify-around">
          {PRIMARY_TABS.map(({ href, label, Icon }) => {
            const active = location === href || (href !== "/dashboard" && location.startsWith(href));
            return (
              <Link key={href} href={href}>
                <button
                  className="flex flex-col items-center gap-0.5 py-3 px-2 min-h-[56px] min-w-[52px] transition-colors"
                  style={{ color: active ? "#1A6B32" : "#9CA3AF" }}
                >
                  <Icon size={20} strokeWidth={active ? 2.5 : 1.8} />
                  <span className="text-[9px] font-medium">{label}</span>
                </button>
              </Link>
            );
          })}

          {/* More button */}
          <button
            onClick={() => setShowMore(v => !v)}
            className="flex flex-col items-center gap-0.5 py-3 px-2 min-h-[56px] min-w-[52px] transition-colors"
            style={{ color: isMoreActive ? "#1A6B32" : "#9CA3AF" }}
          >
            <MoreHorizontal size={20} strokeWidth={isMoreActive ? 2.5 : 1.8} />
            <span className="text-[9px] font-medium">Plus</span>
          </button>
        </div>
      </nav>
    </>
  );
}
