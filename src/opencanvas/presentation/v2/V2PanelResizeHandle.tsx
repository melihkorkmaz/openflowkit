import { useEffect, useRef, useState } from 'react';
import { clampPanelWidth, PANEL_WIDTH } from './useV2Preferences';

const STEP = 16;

/** The viewport width, kept current, for the panel's 65 % cap. */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}

/**
 * The drag handle on the workspace panel's left edge. Live while dragging (`onResize`), saved once on release
 * (`onCommit`); arrows step 16 px (64 with Shift), Home and End jump to the limits. Hidden on narrow screens by CSS.
 */
export function V2PanelResizeHandle({ width, viewportWidth, onResize, onCommit }: {
  readonly width: number;
  readonly viewportWidth: number;
  readonly onResize: (width: number) => void;
  readonly onCommit: (width: number) => void;
}): React.JSX.Element {
  const drag = useRef<{ readonly right: number; last: number } | null>(null);
  const max = clampPanelWidth(Number.POSITIVE_INFINITY, viewportWidth);
  const fromPointer = (clientX: number) => clampPanelWidth(drag.current!.right - clientX, viewportWidth);
  return (
    <div className="ofk-v2-panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
      aria-valuemin={PANEL_WIDTH.min} aria-valuemax={max} aria-valuenow={width}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const root = event.currentTarget.closest('.ofk-v2');
        drag.current = { right: root?.getBoundingClientRect().right ?? window.innerWidth, last: width };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        drag.current.last = fromPointer(event.clientX);
        onResize(drag.current.last);
      }}
      onPointerUp={() => { if (drag.current) onCommit(drag.current.last); drag.current = null; }}
      onPointerCancel={() => { if (drag.current) onCommit(drag.current.last); drag.current = null; }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? STEP * 4 : STEP;
        const next = event.key === 'ArrowLeft' ? width + step
          : event.key === 'ArrowRight' ? width - step
          : event.key === 'Home' ? PANEL_WIDTH.min
          : event.key === 'End' ? max : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        onCommit(clampPanelWidth(next, viewportWidth));
      }} />
  );
}
