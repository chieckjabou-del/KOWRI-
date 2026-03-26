import { useEffect } from "react";
import { useOfflineStore } from "@/lib/store";
import { WifiOff } from "lucide-react";

export function OfflineBanner() {
  const { isOnline, setOnline } = useOfflineStore();

  console.log("[OfflineBanner] render, isOnline:", isOnline);

  useEffect(() => {
    const on  = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online",  on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online",  on);
      window.removeEventListener("offline", off);
    };
  }, [setOnline]);

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[9999] flex items-center justify-center gap-2 py-2 px-4 text-white text-xs font-semibold"
      style={{ background: "#DC2626", display: isOnline ? "none" : "flex" }}
    >
      <WifiOff size={13} />
      Mode hors ligne — les données affichées sont en cache
    </div>
  );
}
