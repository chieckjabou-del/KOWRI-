import { useEffect } from "react";
import { useOfflineStore } from "@/lib/store";

export function useOffline() {
  const { isOnline, setOnline } = useOfflineStore();

  useEffect(() => {
    const onOnline  = () => setOnline(true);
    const onOffline = () => setOnline(false);

    window.addEventListener("online",  onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      window.removeEventListener("online",  onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [setOnline]);

  return { isOnline };
}
