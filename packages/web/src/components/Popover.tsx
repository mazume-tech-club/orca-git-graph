import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Popover({ button, label, children, align = 'left' }: { button: ReactNode; label: string; children: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="popover" ref={ref}>
      <button type="button" className="tool-btn" aria-haspopup="true" aria-expanded={open} title={label} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {button}
      </button>
      {open && (
        <div className={`popover-panel popover-${align}`} role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}
