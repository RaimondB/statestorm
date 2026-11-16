import { useRef } from "react";

interface Props {
  /** The grid area this bar sits in. */
  area: string;
  /** "col" bars sit between columns and drag sideways; "row" bars drag up and down. */
  axis: "col" | "row";
  /** The panel's size when the drag starts. */
  size: number;
  /** +1 when dragging towards larger coordinates grows the panel (the left panel), -1 when it
   *  shrinks it (the right panel, the trace below). */
  sign: 1 | -1;
  collapsed: boolean;
  label: string;
  onResize: (wanted: number) => void;
  onToggle: () => void;
}

/**
 * A draggable bar between two panels. Drag to resize; drag nearly shut to collapse; double-click,
 * Enter or the little button to collapse or restore; arrow keys to resize without a mouse.
 */
export function Splitter({ area, axis, size, sign, collapsed, label, onResize, onToggle }: Props) {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const pos = (e: { clientX: number; clientY: number }) => (axis === "col" ? e.clientX : e.clientY);
  // Pointing at the collapse button on the right panel's bar points left, and so on.
  const arrows = axis === "col" ? (sign > 0 ? ["›", "‹"] : ["‹", "›"]) : ["▴", "▾"];

  return (
    <div
      className={`splitter ${axis}${collapsed ? " collapsed" : ""}`}
      style={{ gridArea: area }}
      role="separator"
      aria-orientation={axis === "col" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={collapsed ? 0 : size}
      tabIndex={0}
      title={`${label} — drag to resize, double-click to ${collapsed ? "restore" : "collapse"}`}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { pos: pos(e), size: collapsed ? 0 : size };
        document.body.classList.add(axis === "col" ? "resizing-col" : "resizing-row");
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        onResize(start.current.size + sign * (pos(e) - start.current.pos));
      }}
      onPointerUp={(e) => {
        start.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove("resizing-col", "resizing-row");
      }}
      onDoubleClick={onToggle}
      onKeyDown={(e) => {
        const grow = axis === "col" ? (sign > 0 ? "ArrowRight" : "ArrowLeft") : (sign > 0 ? "ArrowDown" : "ArrowUp");
        const shrink = axis === "col" ? (sign > 0 ? "ArrowLeft" : "ArrowRight") : (sign > 0 ? "ArrowUp" : "ArrowDown");
        if (e.key === grow) { e.preventDefault(); onResize((collapsed ? 0 : size) + 32); }
        else if (e.key === shrink) { e.preventDefault(); onResize(size - 32); }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
      }}
    >
      <button className="splitter-toggle" onClick={onToggle} tabIndex={-1}
        aria-label={collapsed ? `Show ${label}` : `Hide ${label}`}>{collapsed ? arrows[0] : arrows[1]}</button>
    </div>
  );
}
