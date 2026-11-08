// 0.8.3: pure helpers of the lightning legend gate (ltggate.ts): age window, icon paint, filter.
import type { ExpressionSpecification } from "maplibre-gl";

export const LTG = "glm";

/** the layer's span in seconds ("Last" option) */
export function ltgSpan(opt?: string): number {
  return (+(opt ?? 15) || 15) * 60;
}

/** age window in seconds from a gate (0–1 of the span); full span when not gated */
export function ltgWindow(span: number, g: [number, number] | null): [number, number] {
  if (!g) return [0, span];
  const a0 = Math.max(0, Math.min(span, g[0] * span));
  const a1 = Math.max(a0, Math.min(span, g[1] * span));
  return [a0, a1];
}

/** icon paint for a window: white at the newest edge → yellow → orange → red → dark at the oldest */
export function ltgPaint(win: [number, number], opacity: number): { color: ExpressionSpecification; opacity: ExpressionSpecification } {
  const a0 = win[0];
  const w = Math.max(2, win[1] - a0);
  const k = Math.min(0.29, 60 / w); // ~1 min of white-yellow, as before
  const at = (f: number) => a0 + f * w;
  const age: ExpressionSpecification = ["to-number", ["get", "age"], 0];
  return {
    color: ["interpolate", ["linear"], age, a0, "#ffffff", at(k), "#fff59d", at(0.3), "#ffb300", at(0.65), "#f4511e", at(1), "#8d2a1a"],
    opacity: ["*", opacity, ["interpolate", ["linear"], age, a0, 1, at(0.5), 0.75, at(1), 0.15]],
  };
}

/** filter for a gated window (null = show all) */
export function ltgFilter(span: number, g: [number, number] | null): ExpressionSpecification | null {
  if (!g) return null;
  const [a0, a1] = ltgWindow(span, g);
  const age: ExpressionSpecification = ["to-number", ["get", "age"], 0];
  return ["all", [">=", age, a0 - 0.5], ["<=", age, a1 + 0.5]];
}

/** the legend's age scale ("0", "5 min" …) for a span in seconds */
export function ltgTicks(span: number): string[] {
  const m = span / 60;
  return [0, 0.25, 0.5, 0.75, 1].map((f) => (f === 0 ? "now" : `${Math.round(f * m * 10) / 10} min`));
}
