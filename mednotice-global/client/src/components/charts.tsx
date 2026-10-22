import type { Priority } from "../types";
import { PRIORITY_META } from "../api";

export function BarChart({ data, label }: { data: Array<{ date: string; count: number }>; label?: string }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div>
      <div className="bar-chart" role="img" aria-label={label ?? "Daily case volume"}>
        {data.map((d) => (
          <div className="bar-col" key={d.date} title={`${d.date}: ${d.count} case${d.count === 1 ? "" : "s"}`}>
            <div className="bar" style={{ height: `${Math.max(3, (d.count / max) * 100)}%` }} />
            <span className="bar-day">{d.date.slice(8)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const PRIORITY_COLORS: Record<Priority, string> = {
  P1: "#ff5d6c",
  P2: "#ffab4a",
  P3: "#4cc9f0",
  P4: "#8b98b8",
};

export function PriorityDonut({ data }: { data: Array<{ priority: Priority; n: number }> }) {
  const total = data.reduce((sum, d) => sum + Number(d.n), 0) || 1;
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="donut">
      <svg width="124" height="124" viewBox="0 0 120 120" role="img" aria-label="Cases by priority">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="rgba(151,180,235,0.1)" strokeWidth="14" />
        {(["P1", "P2", "P3", "P4"] as Priority[]).map((priority) => {
          const value = Number(data.find((d) => d.priority === priority)?.n ?? 0);
          if (value === 0) return null;
          const length = (value / total) * circumference;
          const dash = `${length} ${circumference - length}`;
          const el = (
            <circle
              key={priority}
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              stroke={PRIORITY_COLORS[priority]}
              strokeWidth="14"
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
              strokeLinecap="butt"
            />
          );
          offset += length;
          return el;
        })}
        <text x="60" y="57" textAnchor="middle" fill="var(--text)" fontSize="20" fontWeight="650">{total}</text>
        <text x="60" y="73" textAnchor="middle" fill="var(--faint)" fontSize="9" letterSpacing="1.5">CASES</text>
      </svg>
      <div className="legend">
        {(["P1", "P2", "P3", "P4"] as Priority[]).map((priority) => {
          const value = Number(data.find((d) => d.priority === priority)?.n ?? 0);
          return (
            <div className="legend-item" key={priority}>
              <span className="legend-swatch" style={{ background: PRIORITY_COLORS[priority] }} />
              <span>{PRIORITY_META[priority].label}</span>
              <span className="legend-value">{value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function HBars({ items, formatLabel }: { items: Array<{ label: string; value: number }>; formatLabel?: (label: string) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div>
      {items.map((item) => (
        <div className="hbar" key={item.label}>
          <span className="hbar-label" title={item.label}>{formatLabel ? formatLabel(item.label) : item.label}</span>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ width: `${(item.value / max) * 100}%` }} />
          </span>
          <span className="hbar-value">{item.value}</span>
        </div>
      ))}
      {items.length === 0 && <div className="empty">No data yet</div>}
    </div>
  );
}

export function ScoreGauge({ score, size = 54 }: { score: number; size?: number }) {
  const color = score >= 75 ? "var(--ok)" : score >= 40 ? "var(--warn)" : "var(--danger)";
  return (
    <div
      className="gauge-circle"
      style={{ width: size, height: size, background: `conic-gradient(${color} ${score * 3.6}deg, rgba(151,180,235,0.12) 0deg)` }}
      title={`Trust score ${score}/100`}
    >
      <span style={{ width: size - 12, height: size - 12, borderRadius: "50%", background: "#0e1728", display: "grid", placeItems: "center" }}>
        {score}
      </span>
    </div>
  );
}
