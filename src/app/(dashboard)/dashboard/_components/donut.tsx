type DonutProps = {
  numerator: number;
  denominator: number;
  size?: number;
  thickness?: number;
};

export function Donut({
  numerator,
  denominator,
  size = 160,
  thickness = 18,
}: DonutProps) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = denominator > 0 ? numerator / denominator : 0;
  const filled = circumference * ratio;
  const empty = circumference - filled;
  const percent = denominator > 0 ? Math.round(ratio * 100) : null;
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
        {denominator > 0 && (
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
          {numerator.toLocaleString()} of {denominator.toLocaleString()}
        </div>
      </div>
    </div>
  );
}
