interface KowriAvatarProps {
  name?: string;
  src?: string | null;
  size?: number;
  className?: string;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => (w[0] ?? "").toUpperCase())
    .join("");
}

const BG_COLORS = [
  "#1A6B32", "#2563EB", "#D97706", "#DC2626",
  "#7C3AED", "#0891B2", "#BE185D", "#065F46",
];

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return BG_COLORS[Math.abs(hash) % BG_COLORS.length];
}

export function KowriAvatar({ name = "", src, size = 40, className = "" }: KowriAvatarProps) {
  const bg  = colorFor(name || "U");
  const ini = initials(name || "U");
  const fs  = Math.round(size * 0.38);

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        className={`rounded-full object-cover flex-shrink-0 ${className}`}
        style={{ width: size, height: size }}
        onError={(e) => { (e.currentTarget as HTMLImageElement).src = ""; }}
      />
    );
  }

  return (
    <div
      className={`rounded-full flex items-center justify-center flex-shrink-0 font-bold text-white ${className}`}
      style={{ width: size, height: size, background: bg, fontSize: fs }}
    >
      {ini}
    </div>
  );
}
