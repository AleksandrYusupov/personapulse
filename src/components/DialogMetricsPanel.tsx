import React from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { DialogMetric, DialogMetricsSnapshot } from '../types';

interface DialogMetricsPanelProps {
  metrics: DialogMetricsSnapshot | null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function impactClasses(impact: DialogMetric['impact']): {
  text: string;
  border: string;
  bg: string;
  fill: string;
} {
  if (impact === 'better') {
    return {
      text: 'text-emerald-300',
      border: 'border-emerald-400/35',
      bg: 'bg-emerald-400/10',
      fill: 'bg-emerald-300',
    };
  }
  if (impact === 'worse') {
    return {
      text: 'text-red-300',
      border: 'border-red-400/35',
      bg: 'bg-red-400/10',
      fill: 'bg-red-300',
    };
  }
  return {
    text: 'text-zinc-400',
    border: 'border-zinc-700/70',
    bg: 'bg-zinc-900/70',
    fill: 'bg-zinc-500',
  };
}

function DirectionIcon({ metric }: { metric: DialogMetric }) {
  const iconClassName = 'h-3 w-3 shrink-0';
  if (metric.direction === 'up') return <ArrowUp className={iconClassName} aria-hidden="true" />;
  if (metric.direction === 'down') return <ArrowDown className={iconClassName} aria-hidden="true" />;
  return <Minus className={iconClassName} aria-hidden="true" />;
}

function formatDelta(metric: DialogMetric): string {
  if (metric.delta === null) return '';
  const prefix = metric.delta > 0 ? '+' : '';
  return `${prefix}${metric.delta.toFixed(1)}pp`;
}

export default function DialogMetricsPanel({ metrics }: DialogMetricsPanelProps) {
  return (
    <section
      className="w-full max-w-[280px] sm:max-w-[310px] md:max-w-[330px] lg:max-w-[85%] xl:max-w-[75%] shrink-0 rounded-2xl border border-zinc-800/70 bg-zinc-950/45 p-4 shadow-[0_18px_45px_rgba(0,0,0,0.28)]"
      aria-labelledby="dialog-telemetry-heading"
    >
      <div className="mb-3 flex items-center justify-between gap-3 border-b border-zinc-800/70 pb-2.5">
        <h3
          id="dialog-telemetry-heading"
          className="font-orbitron text-[10px] font-black uppercase tracking-widest text-[#ECFF19]"
        >
          Dialog Telemetry
        </h3>
        <span className="rounded border border-[#ECFF19]/20 bg-[#ECFF19]/5 px-2 py-0.5 text-[8px] font-mono font-bold uppercase tracking-wider text-[#ECFF19]">
          Live
        </span>
      </div>

      {!metrics ? (
        <div className="flex h-[154px] flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800/80 bg-black/20 px-3 text-center">
          <span className="font-orbitron text-[11px] font-black uppercase tracking-widest text-zinc-400">
            Awaiting Signal
          </span>
          <span className="mt-2 max-w-[190px] text-[10px] font-mono uppercase leading-relaxed tracking-wider text-zinc-600">
            Metrics appear after the first analysis event.
          </span>
        </div>
      ) : (
        <div className="space-y-3" role="list" aria-label="Current dialog metrics">
          {metrics.metrics.map((metric) => {
            const classes = impactClasses(metric.impact);
            const percent = clampPercent(metric.value);

            return (
              <div key={metric.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5" role="listitem">
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
                      {metric.label}
                    </span>
                    <span className="text-[10px] font-mono font-black text-zinc-100">
                      {percent}%
                    </span>
                  </div>
                  <div
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full border border-zinc-800 bg-black/55"
                    aria-hidden="true"
                  >
                    <div className={`h-full rounded-full ${classes.fill}`} style={{ width: `${percent}%` }} />
                  </div>
                </div>

                <div
                  className={`flex h-8 min-w-[88px] items-center justify-center gap-1 rounded border px-1.5 font-mono font-black uppercase tracking-tight ${classes.border} ${classes.bg} ${classes.text}`}
                  aria-label={`${metric.label}: ${percent} percent, ${metric.impact.toUpperCase()} ${formatDelta(metric)}`.trim()}
                >
                  <DirectionIcon metric={metric} />
                  <span className="flex flex-col leading-none">
                    <span className="text-[8px]">{metric.impact.toUpperCase()}</span>
                    {metric.delta !== null && <span className="mt-0.5 text-[7px] opacity-85">{formatDelta(metric)}</span>}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
