import { Crown, Check, Clock } from "lucide-react";

interface TontineMemberRowProps {
  member: {
    id: string;
    userId: string;
    payoutOrder: number;
    hasReceivedPayout: number;
    contributionsCount: number;
    user?: { firstName?: string; lastName?: string; phone?: string };
  };
  currentRound: number;
  currentUserId?: string;
}

export function TontineMemberRow({ member, currentRound, currentUserId }: TontineMemberRowProps) {
  const isCurrentRecipient = member.payoutOrder === currentRound + 1;
  const hasReceived        = member.hasReceivedPayout === 1;
  const isMe               = member.userId === currentUserId;

  const firstName = member.user?.firstName ?? "?";
  const lastName  = member.user?.lastName  ?? "";
  const initials  = `${firstName[0] ?? "?"}${lastName[0] ?? ""}`.toUpperCase();
  const name      = `${firstName} ${lastName}`.trim() || (member.user?.phone ?? "Membre");

  return (
    <div
      className="flex items-center gap-3 py-3 px-4 rounded-xl transition-colors"
      style={{
        background: isCurrentRecipient ? "#F0FDF4" : isMe ? "#F8FAFF" : "transparent",
        border: isCurrentRecipient ? "1px solid #BBF7D0" : "1px solid transparent",
      }}
    >
      {/* Avatar */}
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold text-white"
        style={{ background: isMe ? "#1A6B32" : "#6B7280" }}
      >
        {initials}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-gray-900 text-sm truncate">{name}</span>
          {isMe && <span className="text-xs text-gray-400">(moi)</span>}
          {isCurrentRecipient && (
            <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-800 ml-1 flex items-center gap-0.5">
              <Crown size={10} />
              Tour
            </span>
          )}
        </div>
        <span className="text-xs text-gray-500">Position #{member.payoutOrder}</span>
      </div>

      {/* Status */}
      <div className="flex-shrink-0">
        {hasReceived ? (
          <span className="flex items-center gap-1 text-xs font-medium text-green-700">
            <Check size={12} />
            Payé
          </span>
        ) : isCurrentRecipient ? (
          <span className="flex items-center gap-1 text-xs font-medium text-green-700">
            <Crown size={12} />
            Prochain
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-gray-400">
            <Clock size={12} />
            Attente
          </span>
        )}
      </div>
    </div>
  );
}
