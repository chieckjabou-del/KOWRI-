import {
  CheckCircle2,
  Clock3,
  ShieldCheck,
  ShieldX,
  RefreshCw,
  CloudOff,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type TrustPillState =
  | "secure"
  | "updated"
  | "syncing"
  | "processing"
  | "confirmed"
  | "queued-offline"
  | "fallback";

const STATE_STYLES: Record<TrustPillState, { label: string; className: string; icon: React.ReactNode }> = {
  secure: {
    label: "Securise",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
  },
  updated: {
    label: "Mis a jour",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
  },
  syncing: {
    label: "Synchronisation",
    className: "border-amber-200 bg-amber-50 text-amber-700",
    icon: <RefreshCw className="h-3.5 w-3.5 animate-spin" />,
  },
  processing: {
    label: "Transaction en cours",
    className: "border-sky-200 bg-sky-50 text-sky-700",
    icon: <Clock3 className="h-3.5 w-3.5" />,
  },
  confirmed: {
    label: "Confirme",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
  },
  "queued-offline": {
    label: "En file hors ligne",
    className: "border-violet-200 bg-violet-50 text-violet-700",
    icon: <CloudOff className="h-3.5 w-3.5" />,
  },
  fallback: {
    label: "Mode secours",
    className: "border-gray-200 bg-gray-100 text-gray-700",
    icon: <ShieldX className="h-3.5 w-3.5" />,
  },
};

export function TrustPill({
  state,
  className,
}: {
  state: TrustPillState;
  className?: string;
}) {
  const style = STATE_STYLES[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
        style.className,
        className,
      )}
    >
      {style.icon}
      {style.label}
    </span>
  );
}
