import { Send, Download, RefreshCw } from "lucide-react";
import { formatXOF } from "@/lib/api";
import { Link } from "wouter";

interface WalletCardProps {
  balance: string | number;
  availableBalance: string | number;
  status: string;
  walletId: string;
  isLoading?: boolean;
}

export function WalletCard({ balance, availableBalance, status, walletId, isLoading }: WalletCardProps) {
  if (isLoading) {
    return (
      <div className="rounded-3xl p-6 animate-pulse" style={{ background: "linear-gradient(135deg, #1A6B32 0%, #2D9148 100%)" }}>
        <div className="h-4 w-32 bg-white/20 rounded mb-6" />
        <div className="h-10 w-48 bg-white/20 rounded mb-2" />
        <div className="h-3 w-24 bg-white/20 rounded mb-8" />
        <div className="flex gap-4">
          {[0,1,2].map(i => <div key={i} className="h-12 flex-1 bg-white/20 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const isFrozen = status === "frozen";

  return (
    <div
      className="rounded-3xl p-6 text-white shadow-lg"
      style={{ background: isFrozen
        ? "linear-gradient(135deg, #6B7280 0%, #9CA3AF 100%)"
        : "linear-gradient(135deg, #1A6B32 0%, #2D9148 100%)"
      }}
    >
      <div className="flex items-start justify-between mb-4">
        <p className="text-sm font-medium opacity-80">Mon Wallet KOWRI</p>
        {isFrozen && (
          <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full font-medium">
            Gelé
          </span>
        )}
        {!isFrozen && (
          <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full font-medium">
            Actif
          </span>
        )}
      </div>

      <p className="text-4xl font-black tracking-tight mb-1">
        {formatXOF(availableBalance)}
      </p>
      <p className="text-xs opacity-70 mb-6">
        Solde total: {formatXOF(balance)}
      </p>

      <div className="grid grid-cols-3 gap-3">
        <Link href="/send">
          <button
            className="flex flex-col items-center gap-1.5 bg-white/15 hover:bg-white/25 rounded-2xl py-3 w-full transition-colors"
            disabled={isFrozen}
          >
            <Send size={18} />
            <span className="text-xs font-semibold">Envoyer</span>
          </button>
        </Link>
        <button className="flex flex-col items-center gap-1.5 bg-white/15 hover:bg-white/25 rounded-2xl py-3 transition-colors">
          <Download size={18} />
          <span className="text-xs font-semibold">Recevoir</span>
        </button>
        <button className="flex flex-col items-center gap-1.5 bg-white/15 hover:bg-white/25 rounded-2xl py-3 transition-colors">
          <RefreshCw size={18} />
          <span className="text-xs font-semibold">Recharger</span>
        </button>
      </div>
    </div>
  );
}
