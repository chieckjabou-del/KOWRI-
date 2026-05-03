import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Bell, CheckCheck, Banknote, CreditCard, Users, Info, AlertCircle } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  channel: string;
  read: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `il y a ${hrs} h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `il y a ${days} j`;
  return new Date(dateStr).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function NotifIcon({ type }: { type: string }) {
  const cls = "w-5 h-5";
  if (type === "transaction") return <Banknote className={cls} />;
  if (type === "credit") return <CreditCard className={cls} />;
  if (type === "tontine") return <Users className={cls} />;
  return <Info className={cls} />;
}

function iconBg(type: string) {
  if (type === "transaction") return "bg-green-100 text-green-700";
  if (type === "credit") return "bg-blue-100 text-blue-700";
  if (type === "tontine") return "bg-purple-100 text-purple-700";
  return "bg-gray-100 text-gray-600";
}

export default function Notifications() {
  const { token } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => apiFetch<{ notifications: Notification[]; unreadCount: number }>("/notifications", token),
    refetchInterval: 30000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/notifications/${id}/read`, token, { method: "PATCH" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markAll = useMutation({
    mutationFn: () =>
      apiFetch("/notifications/read-all", token, { method: "PATCH" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const notifications: Notification[] = Array.isArray(data?.notifications) ? data!.notifications : [];
  const unread = data?.unreadCount ?? 0;

  return (
    <div className="min-h-screen flex flex-col pb-20" style={{ background: "#FAFAF8" }}>
      <TopBar title="Notifications" showBack onBack={() => setLocation("/dashboard")} />

      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm text-gray-500">
          {unread > 0 ? `${unread} non lue${unread > 1 ? "s" : ""}` : "Tout lu"}
        </span>
        {unread > 0 && (
          <button
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg"
            style={{ color: "#1A6B32", background: "#e8f5e9" }}
          >
            <CheckCheck size={15} />
            Tout marquer lu
          </button>
        )}
      </div>

      <div className="flex-1 px-4 pb-6 space-y-2">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 bg-white rounded-xl animate-pulse border border-gray-100" />
          ))
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <AlertCircle size={32} className="mx-auto mb-3" style={{ color: "#DC2626" }} />
            <p className="text-sm font-medium text-gray-700 mb-1">Impossible de charger</p>
            <p className="text-xs text-gray-400 mb-4">{(error as any)?.message ?? "Erreur réseau"}</p>
            <button
              onClick={() => refetch()}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-white"
              style={{ background: "#1A6B32" }}
            >
              Réessayer
            </button>
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
              <Bell size={28} className="text-gray-300" />
            </div>
            <p className="font-semibold text-gray-700 mb-1">Aucune notification</p>
            <p className="text-sm text-gray-400">Vos alertes apparaîtront ici</p>
          </div>
        ) : (
          notifications.map((n) => (
            <button
              key={n.id}
              onClick={() => { if (!n.read) markRead.mutate(n.id); }}
              className="w-full text-left bg-white rounded-xl border border-gray-100 p-4 flex items-start gap-3 transition-opacity active:opacity-70"
              style={{ opacity: n.read ? 0.7 : 1 }}
            >
              <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${iconBg(n.type)}`}>
                <NotifIcon type={n.type} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <span className={`text-sm font-semibold leading-tight ${n.read ? "text-gray-600" : "text-gray-900"}`}>
                    {n.title}
                  </span>
                  <span className="text-xs text-gray-400 flex-shrink-0 mt-0.5">
                    {timeAgo(n.createdAt)}
                  </span>
                </div>
                <p className={`text-sm mt-0.5 leading-snug ${n.read ? "text-gray-400" : "text-gray-600"}`}>
                  {n.message}
                </p>
              </div>
              {!n.read && (
                <div className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5" style={{ background: "#1A6B32" }} />
              )}
            </button>
          ))
        )}
      </div>

      <BottomNav />
    </div>
  );
}
