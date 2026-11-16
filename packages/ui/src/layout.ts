/**
 * The workbench's panel sizes. Pure rules, kept apart from the drag handling so they can be
 * tested: what a size may be, when a drag means "collapse", and what survives a reload.
 */
export interface Layout {
  side: number;          // px, the left panel (fire, steps, world)
  inspect: number;       // px, the right panel
  trace: number;         // px, the trace under the timeline
  sideOpen: boolean;
  inspectOpen: boolean;
  traceOpen: boolean;
}

export type Panel = "side" | "inspect" | "trace";
const OPEN = { side: "sideOpen", inspect: "inspectOpen", trace: "traceOpen" } as const;

export const DEFAULT_LAYOUT: Layout = { side: 340, inspect: 360, trace: 240, sideOpen: true, inspectOpen: true, traceOpen: true };
export const MIN: Record<Panel, number> = { side: 220, inspect: 220, trace: 90 };
/** Dragged below this, a panel collapses instead of getting uselessly narrow. */
export const COLLAPSE_BELOW: Record<Panel, number> = { side: 120, inspect: 120, trace: 50 };
/** The centre — the picture — never gets squeezed below this. */
const CENTRE_MIN = 320;
const MAIN_MIN = 200;

/**
 * Applies a drag: `wanted` is the size the pointer asks for. Below the collapse threshold the
 * panel closes (keeping its last real size for when it reopens); otherwise it is clamped
 * between its minimum and what the window leaves after the other panels and the centre.
 */
export function resize(layout: Layout, panel: Panel, wanted: number, viewport: { width: number; height: number }): Layout {
  if (wanted < COLLAPSE_BELOW[panel]) return { ...layout, [OPEN[panel]]: false };
  const max = panel === "trace"
    ? viewport.height - MAIN_MIN - 160
    : viewport.width - CENTRE_MIN - (panel === "side" ? (layout.inspectOpen ? layout.inspect : 0) : (layout.sideOpen ? layout.side : 0));
  const size = Math.round(Math.max(MIN[panel], Math.min(Math.max(MIN[panel], max), wanted)));
  return { ...layout, [panel]: size, [OPEN[panel]]: true };
}

export function toggle(layout: Layout, panel: Panel): Layout {
  return { ...layout, [OPEN[panel]]: !layout[OPEN[panel]] };
}

export function isOpen(layout: Layout, panel: Panel): boolean {
  return layout[OPEN[panel]];
}

/** Whatever was stored — possibly by an older version, possibly nonsense — made safe. */
export function restore(text: string | null): Layout {
  if (!text) return DEFAULT_LAYOUT;
  try {
    const raw = JSON.parse(text) as Partial<Layout>;
    const out = { ...DEFAULT_LAYOUT };
    for (const p of ["side", "inspect", "trace"] as Panel[]) {
      if (typeof raw[p] === "number" && Number.isFinite(raw[p])) out[p] = Math.max(MIN[p], raw[p]!);
      if (typeof raw[OPEN[p]] === "boolean") out[OPEN[p]] = raw[OPEN[p]]!;
    }
    return out;
  } catch {
    return DEFAULT_LAYOUT;
  }
}
