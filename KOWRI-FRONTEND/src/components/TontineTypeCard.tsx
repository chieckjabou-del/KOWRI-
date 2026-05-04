import { TYPE_META } from "@/lib/tontineTypes";

interface TontineTypeCardProps {
  type: string;
  selected: boolean;
  onClick: () => void;
}

export function TontineTypeCard({ type, selected, onClick }: TontineTypeCardProps) {
  const meta = TYPE_META[type] ?? { label: type, icon: "🔵", colorClass: "bg-gray-100 text-gray-800", desc: "" };

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left p-4 rounded-2xl border-2 transition-all"
      style={{
        borderColor: selected ? "#1A6B32" : "#E5E7EB",
        background:  selected ? "#F0FDF4" : "#FFFFFF",
        minHeight: 88,
      }}
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none mt-0.5">{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-gray-900 text-sm">{meta.label}</span>
            {selected && (
              <span
                className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 ml-auto"
                style={{ background: "#1A6B32" }}
              >
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 leading-snug">{meta.desc}</p>
        </div>
      </div>
    </button>
  );
}
