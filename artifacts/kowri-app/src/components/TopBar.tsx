import { Bell } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

interface TopBarProps {
  title?: string;
  showBack?: boolean;
  onBack?: () => void;
}

export function TopBar({ title, showBack, onBack }: TopBarProps) {
  const { user, token } = useAuth();
  const [, setLocation] = useLocation();

  const { data } = useQuery({
    queryKey: ["notifications", "badge"],
    queryFn: () => apiFetch<{ unreadCount: number }>("/notifications", token),
    refetchInterval: 30000,
    enabled: !!token,
    select: (d) => d.unreadCount,
  });

  const unread = data ?? 0;

  return (
    <header
      className="sticky top-0 z-40 bg-white border-b border-gray-100 flex items-center justify-between px-4"
      style={{ height: 56 }}
    >
      <div className="flex items-center gap-3">
        {showBack ? (
          <button
            onClick={onBack}
            className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
          </button>
        ) : (
          <span className="font-black text-xl tracking-tight" style={{ color: "#1A6B32" }}>
            KOWRI
          </span>
        )}
        {title && <span className="font-semibold text-gray-900">{title}</span>}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => setLocation("/notifications")}
          className="relative w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100"
          aria-label="Notifications"
        >
          <Bell size={20} className="text-gray-600" />
          {unread > 0 && (
            <span
              className="absolute top-1.5 right-1.5 min-w-[16px] h-4 rounded-full flex items-center justify-center text-white text-[10px] font-bold px-1"
              style={{ background: "#E53E3E" }}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>

        {user && (
          <Link href="/profile">
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold cursor-pointer"
              style={{ background: "#1A6B32" }}
            >
              {user.firstName[0]}{user.lastName[0]}
            </div>
          </Link>
        )}
      </div>
    </header>
  );
}
