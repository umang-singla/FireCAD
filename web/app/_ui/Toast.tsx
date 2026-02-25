"use client";

import { useEffect } from "react";

export function Toast({
  open,
  tone = "info",
  title,
  message,
  autoCloseMs = 2600,
  onClose,
}: {
  open: boolean;
  tone?: "info" | "good" | "warn" | "bad";
  title: string;
  message?: string;
  autoCloseMs?: number;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    if (!autoCloseMs || autoCloseMs <= 0) return;
    const t = setTimeout(onClose, autoCloseMs);
    return () => clearTimeout(t);
  }, [open, autoCloseMs, onClose]);

  if (!open) return null;

  const border =
    tone === "good"
      ? "rgba(52,211,153,0.55)"
      : tone === "warn"
      ? "rgba(251,191,36,0.60)"
      : tone === "bad"
      ? "rgba(251,113,133,0.65)"
      : "rgba(96,165,250,0.55)";

  return (
    <div className="toast" style={{ borderColor: border }} role="status">
      <div className="toastTitle">{title}</div>
      {message ? <div className="toastMsg">{message}</div> : null}
    </div>
  );
}
