import { ArrowUpRight, ArrowDownLeft } from "lucide-react";
import { formatXOF, relativeTime } from "@/lib/api";

interface TransactionRowProps {
  type: string;
  amount: string | number;
  description?: string;
  createdAt: string;
  fromWalletId: string;
  myWalletId: string;
}

export function TransactionRow({ type, amount, description, createdAt, fromWalletId, myWalletId }: TransactionRowProps) {
  const isSent = fromWalletId === myWalletId || type === "transfer" || type === "payment";
  const label = description || (isSent ? "Envoi" : "Réception");
  const n = parseFloat(String(amount));

  return (
    <div className="flex items-center gap-3 py-3">
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
        style={{ background: isSent ? "#FEF2F2" : "#F0FDF4" }}
      >
        {isSent
          ? <ArrowUpRight size={18} style={{ color: "#EF4444" }} />
          : <ArrowDownLeft size={18} style={{ color: "#10B981" }} />
        }
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{label}</p>
        <p className="text-xs text-gray-500">{relativeTime(createdAt)}</p>
      </div>
      <span
        className="text-sm font-bold flex-shrink-0"
        style={{ color: isSent ? "#EF4444" : "#10B981" }}
      >
        {isSent ? "-" : "+"}{formatXOF(Math.abs(n))}
      </span>
    </div>
  );
}

export function TransactionRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-3 animate-pulse">
      <div className="w-10 h-10 rounded-full bg-gray-100 flex-shrink-0" />
      <div className="flex-1">
        <div className="h-3.5 w-32 bg-gray-100 rounded mb-2" />
        <div className="h-3 w-20 bg-gray-100 rounded" />
      </div>
      <div className="h-3.5 w-24 bg-gray-100 rounded" />
    </div>
  );
}
