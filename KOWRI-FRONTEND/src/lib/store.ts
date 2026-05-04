import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UIState {
  balanceHidden: boolean;
  toggleBalance: () => void;
  notificationCount: number;
  setNotificationCount: (n: number) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      balanceHidden: false,
      toggleBalance: () => set((s) => ({ balanceHidden: !s.balanceHidden })),
      notificationCount: 0,
      setNotificationCount: (n) => set({ notificationCount: n }),
    }),
    { name: "kowri_ui_v1", partialize: (s) => ({ balanceHidden: s.balanceHidden }) }
  )
);

interface OfflineState {
  isOnline: boolean;
  setOnline: (v: boolean) => void;
  pendingActions: number;
  setPendingActions: (n: number) => void;
}

export const useOfflineStore = create<OfflineState>()((set) => ({
  isOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
  setOnline: (v) => set({ isOnline: v }),
  pendingActions: 0,
  setPendingActions: (n) => set({ pendingActions: n }),
}));
