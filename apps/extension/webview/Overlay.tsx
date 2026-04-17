import React, { useEffect } from "react";

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Key for mount animation — different keys retrigger the slide-in. */
  animKey?: string;
}

/**
 * Full-webview overlay with glass backdrop. Takes over the entire panel
 * (not modal-style centered) because the webview is narrow — centered
 * modals look cramped. Escape closes. Click outside content area closes.
 *
 * Used by Profile / Settings / Subscription pages.
 */
export function Overlay({ open, onClose, children, animKey }: OverlayProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="overlay" key={animKey}>
      <div className="overlay-scroll">{children}</div>
    </div>
  );
}
