import React from "react";

export function Field({
  label,
  right,
  children,
  hint,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.70)", fontWeight: 800 }}>
          {label}
        </div>
        {right ? <div className="kbd">{right}</div> : null}
      </div>
      <div style={{ marginTop: 8 }}>{children}</div>
      {hint ? (
        <div style={{ marginTop: 6, fontSize: 12, color: "rgba(255,255,255,0.55)", lineHeight: 1.4 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
