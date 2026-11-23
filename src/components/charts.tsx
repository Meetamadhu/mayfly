"use client";

import { useState } from "react";
import { niceMax } from "@/lib/activity";

/**
 * Small bar charts for the Activity and Cost pages, drawn with HTML so the text stays crisp at any width.
 * Each column is focusable and shows its numbers on hover or focus; a hidden table carries the same numbers for
 * screen readers.
 */

export type ChartSeries = { key: string; label: string; tone: string };
export type ChartColumn = { label: string; title: string; values: Record<string, number> };

export function BarChart({
  columns,
  series,
  stacked = false,
  format,
  axisFormat = format,
  caption,
  minTop = 0,
}: {
  columns: ChartColumn[];
  series: ChartSeries[];
  /** Stacked: one bar per column with the series on top of each other. Otherwise the series stand side by side. */
  stacked?: boolean;
  format: (value: number) => string;
  axisFormat?: (value: number) => string;
  caption: string;
  /** The axis never tops out below this, so tiny numbers don't fill the chart or round to "0, 0, 0". */
  minTop?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const peak = Math.max(
    0,
    ...columns.map((column) =>
      stacked
        ? series.reduce((sum, s) => sum + (column.values[s.key] ?? 0), 0)
        : Math.max(0, ...series.map((s) => column.values[s.key] ?? 0)),
    ),
  );
  const top = niceMax(Math.max(peak, minTop));
  const ticks = [4, 3, 2, 1, 0].map((step) => (top * step) / 4);
  const pct = (value: number) => `${Math.max(0, Math.min(100, (value / top) * 100))}%`;

  return (
    <div className="chart">
      <div className="chart-plot" onMouseLeave={() => setActive(null)}>
        <div className="chart-grid" aria-hidden="true">
          {ticks.map((tick) => (
            <div key={tick} className="chart-gridline" style={{ bottom: pct(tick) }}>
              <span>{axisFormat(tick)}</span>
            </div>
          ))}
        </div>
        <div className="chart-cols" data-stacked={stacked ? "1" : "0"}>
          {columns.map((column, index) => (
            <div
              key={column.title}
              className="chart-col"
              tabIndex={0}
              aria-label={`${column.title}: ${series.map((s) => `${s.label} ${format(column.values[s.key] ?? 0)}`).join(", ")}`}
              data-active={active === index ? "1" : undefined}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
            >
              <div className="chart-bars">
                {stacked ? (
                  <div className="chart-stack">
                    {[...series].reverse().map((s) =>
                      (column.values[s.key] ?? 0) > 0 ? (
                        <span key={s.key} data-tone={s.tone} style={{ height: pct(column.values[s.key] ?? 0) }} />
                      ) : null,
                    )}
                  </div>
                ) : (
                  series.map((s) => (
                    <span key={s.key} className="chart-bar" data-tone={s.tone} style={{ height: pct(column.values[s.key] ?? 0) }} />
                  ))
                )}
              </div>
              <span className="chart-label" aria-hidden="true">
                {column.label}
              </span>
              {active === index ? (
                <div className="chart-tip" role="presentation" data-edge={index >= columns.length - 2 ? "end" : index <= 0 ? "start" : undefined}>
                  <strong>{column.title}</strong>
                  {series.map((s) => (
                    <span key={s.key}>
                      <i data-tone={s.tone} />
                      {s.label}
                      <b>{format(column.values[s.key] ?? 0)}</b>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <div className="visually-hidden">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => (
            <tr key={column.title}>
              <th scope="row">{column.title}</th>
              {series.map((s) => (
                <td key={s.key}>{format(column.values[s.key] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

export function ChartLegend({ series }: { series: ChartSeries[] }) {
  return (
    <ul className="chart-legend">
      {series.map((s) => (
        <li key={s.key}>
          <i data-tone={s.tone} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
