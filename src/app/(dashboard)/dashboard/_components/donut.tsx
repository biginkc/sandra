type DonutProps = {
  /** Nullable: the dashboard RPC returns null while metrics are unbacked
   *  (e.g. before the first cron snapshot, or when a join can't resolve). */
  numerator: number | null;
  denominator: number | null;
  size?: number;
  thickness?: number;
};

export function Donut({
  numerator,
  denominator,
  size = 160,
  thickness = 18,
}: DonutProps) {
  const num = numerator ?? 0;
  const den = denominator ?? 0;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = den > 0 ? num / den : 0;
  const filled = circumference * ratio;
  const empty = circumference - filled;
  const percent = den > 0 ? Math.round(ratio * 100) : null;
  const center = size / 2;

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={thickness}
        />
        {den > 0 && (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={thickness}
            strokeDasharray={`${filled} ${empty}`}
            strokeLinecap="butt"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-foreground text-3xl font-extrabold tracking-tight">
          {percent === null ? "—" : `${percent}%`}
        </div>
        <div className="text-muted-foreground text-xs font-medium">
          {num.toLocaleString()} of {den.toLocaleString()}
        </div>
      </div>
    </div>
  );
}
