import { ArrowUpRight, ArrowDownLeft, Clock, XCircle, RotateCcw } from "lucide-react";
import { formatXOF, relativeTime } from "@/lib/api";

interface TransactionRowProps {
  type: string;
  amount: string | number;
  description?: string;
  createdAt: string;
  fromWalletId: string;
  myWalletId: string;
  // Ledger status. Anything other than "completed" is shown as such: a
  // pending, failed or reversed movement must never look like money received.
  status?: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending:    "En attente",
  processing: "En cours",
  failed:     "Échouée",
  reversed:   "Annulée",
};

export function TransactionRow({ type, amount, description, createdAt, fromWalletId, myWalletId, status }: TransactionRowProps) {
  const isSent = fromWalletId === myWalletId || type === "transfer" || type === "payment";
  const label = description || (isSent ? "Envoi" : "Réception");
  const n = parseFloat(String(amount));
  const settled = status === undefined || status === "completed";
  const notSettled = !settled;
  const failed = status === "failed" || status === "reversed";
  const statusLabel = status ? STATUS_LABEL[status] ?? status : undefined;

  const Icon = failed ? (status === "reversed" ? RotateCcw : XCircle) : notSettled ? Clock : isSent ? ArrowUpRight : ArrowDownLeft;
  const tone = failed ? "#6B7280" : notSettled ? "#D97706" : isSent ? "#EF4444" : "#10B981";
  const bg   = failed ? "#F3F4F6" : notSettled ? "#FFFBEB" : isSent ? "#FEF2F2" : "#F0FDF4";

  return (
    <div className="flex items-center gap-3 py-3" data-status={status ?? "completed"}>
      <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: bg }}>
        <Icon size={18} style={{ color: tone }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{label}</p>
        <p className="text-xs text-gray-500">
          {relativeTime(createdAt)}
          {statusLabel && notSettled && (
            <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase" style={{ background: bg, color: tone }}>
              {statusLabel}
            </span>
          )}
        </p>
      </div>
      <span
        className="text-sm font-bold flex-shrink-0"
        style={{ color: tone, textDecoration: failed ? "line-through" : undefined }}
      >
        {failed ? "" : isSent ? "-" : "+"}{formatXOF(Math.abs(n))}
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
