import { useEffect } from "react";
import { useOfflineStore } from "@/lib/store";
import { WifiOff } from "lucide-react";
import { getQueueLength, syncOfflinePendingCount } from "@/lib/offlineQueue";

export function OfflineBanner() {
  const { isOnline, setOnline, pendingActions, setPendingActions } = useOfflineStore();

  useEffect(() => {
    setOnline(navigator.onLine);
    setPendingActions(syncOfflinePendingCount());
    const on  = () => setOnline(true);
    const off = () => setOnline(false);
    const onQueueUpdated = (event: Event) => {
      const queueEvent = event as CustomEvent<{ queueLength?: number }>;
      setPendingActions(queueEvent.detail?.queueLength ?? getQueueLength());
    };
    window.addEventListener("online",  on);
    window.addEventListener("offline", off);
    window.addEventListener("akwe-offline-queue-updated", onQueueUpdated as EventListener);
    return () => {
      window.removeEventListener("online",  on);
      window.removeEventListener("offline", off);
      window.removeEventListener("akwe-offline-queue-updated", onQueueUpdated as EventListener);
    };
  }, [setOnline, setPendingActions]);

  if (isOnline) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[9999] flex items-center justify-center gap-2 py-2 px-4 text-white text-xs font-semibold"
      style={{ background: "#DC2626" }}
      role="status"
      aria-live="polite"
    >
      <WifiOff size={13} />
      Mode hors ligne — données en cache
      {pendingActions > 0 ? ` • ${pendingActions} action(s) en attente` : ""}
    </div>
  );
}
