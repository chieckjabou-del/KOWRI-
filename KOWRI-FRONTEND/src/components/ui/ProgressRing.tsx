interface ProgressRingProps {
  value: number;
  max?: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
  label?: string;
  sublabel?: string;
}

export function ProgressRing({
  value,
  max = 100,
  size = 120,
  strokeWidth = 10,
  color = "#1A6B32",
  trackColor = "#F3F4F6",
  label,
  sublabel,
}: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circ   = 2 * Math.PI * radius;
  const pct    = Math.min(Math.max(value / max, 0), 1);
  const dash   = (pct * circ).toFixed(2);
  const center = size / 2;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={center} cy={center} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
        <circle
          cx={center} cy={center} r={radius} fill="none"
          stroke={color} strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          style={{ transition: "stroke-dasharray 0.6s ease" }}
        />
      </svg>
      {(label || sublabel) ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {label ? <span className="font-bold text-gray-900 leading-tight" style={{ fontSize: size * 0.18 }}>{label}</span> : null}
          {sublabel ? <span className="text-gray-500 leading-tight" style={{ fontSize: size * 0.11 }}>{sublabel}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
