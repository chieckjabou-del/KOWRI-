import { Link, useLocation } from "wouter";
import { Home, Users, TrendingUp, PiggyBank, Globe } from "lucide-react";

const tabs = [
  { href: "/dashboard", label: "Accueil",  Icon: Home       },
  { href: "/tontines",  label: "Tontines", Icon: Users      },
  { href: "/credit",    label: "Crédit",   Icon: TrendingUp },
  { href: "/savings",   label: "Épargne",  Icon: PiggyBank  },
  { href: "/diaspora",  label: "Diaspora", Icon: Globe      },
];

export function BottomNav() {
  const [location] = useLocation();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-100"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex items-center justify-around">
        {tabs.map(({ href, label, Icon }) => {
          const active = location === href || (href !== "/dashboard" && location.startsWith(href));
          return (
            <Link key={href} href={href}>
              <button
                className="flex flex-col items-center gap-0.5 py-3 px-2 min-h-[56px] min-w-[56px] transition-colors"
                style={{ color: active ? "#1A6B32" : "#9CA3AF" }}
              >
                <Icon size={20} strokeWidth={active ? 2.5 : 1.8} />
                <span className="text-[9px] font-medium">{label}</span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
