import { Send, Download, Plus, Minus, Eye, EyeOff } from "lucide-react";
import { formatXOF } from "@/lib/api";
import { Link } from "wouter";
import { useUIStore } from "@/lib/store";

interface WalletCardProps {
  balance: string | number;
  availableBalance: string | number;
  status: string;
  walletId: string;
  isLoading?: boolean;
  onDeposit?: () => void;
  onWithdraw?: () => void;
}

export function WalletCard({
  balance, availableBalance, status, walletId, isLoading, onDeposit, onWithdraw,
}: WalletCardProps) {
  const { balanceHidden, toggleBalance } = useUIStore();

  if (isLoading) {
    return (
      <div className="rounded-3xl p-6 animate-pulse" style={{ background: "linear-gradient(135deg, #1A6B32 0%, #2D9148 100%)" }}>
        <div className="h-4 w-32 bg-white/20 rounded mb-6" />
        <div className="h-10 w-48 bg-white/20 rounded mb-2" />
        <div className="h-3 w-24 bg-white/20 rounded mb-8" />
        <div className="grid grid-cols-4 gap-3">
          {[0,1,2,3].map(i => <div key={i} className="h-16 bg-white/20 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  const isFrozen = status === "frozen";
  const showAmt  = balanceHidden ? "••••••" : formatXOF(availableBalance);
  const showTotal = balanceHidden ? "••••••" : formatXOF(balance);

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
        <div className="flex items-center gap-2">
          <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full font-medium">
            {isFrozen ? "Gelé" : "Actif"}
          </span>
          <button
            onClick={toggleBalance}
            className="p-1 rounded-full hover:bg-white/20 transition-colors"
            aria-label={balanceHidden ? "Afficher le solde" : "Masquer le solde"}
          >
            {balanceHidden ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
        </div>
      </div>

      <p className="text-4xl font-black tracking-tight mb-1">
        {showAmt}
      </p>
      <p className="text-xs opacity-70 mb-6">
        Solde total : {showTotal}
      </p>

      <div className="grid grid-cols-4 gap-2">
        <Link href="/send">
          <button
            className="flex flex-col items-center gap-1.5 bg-white/15 hover:bg-white/25 rounded-2xl py-3 w-full transition-colors disabled:opacity-40"
            disabled={isFrozen}
            style={{ minHeight: 64 }}
          >
            <Send size={17} />
            <span className="text-xs font-semibold">Envoyer</span>
          </button>
        </Link>

        <button
          className="flex flex-col items-center gap-1.5 bg-white/15 hover:bg-white/25 rounded-2xl py-3 transition-colors"
          style={{ minHeight: 64 }}
          onClick={() => {
            navigator.clipboard?.writeText(walletId).catch(() => {});
          }}
        >
          <Download size={17} />
          <span className="text-xs font-semibold">Recevoir</span>
        </button>

        <button
          className="flex flex-col items-center gap-1.5 bg-white/15 hover:bg-white/25 rounded-2xl py-3 transition-colors"
          style={{ minHeight: 64 }}
          onClick={onDeposit}
        >
          <Plus size={17} />
          <span className="text-xs font-semibold">Déposer</span>
        </button>

        <button
          className="flex flex-col items-center gap-1.5 bg-white/15 hover:bg-white/25 rounded-2xl py-3 transition-colors disabled:opacity-40"
          style={{ minHeight: 64 }}
          disabled={isFrozen}
          onClick={onWithdraw}
        >
          <Minus size={17} />
          <span className="text-xs font-semibold">Retirer</span>
        </button>
      </div>
    </div>
  );
}
