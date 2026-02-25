"use client";

export function Switch({
  value,
  onChange,
  ariaLabel,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel || "toggle"}
      className={value ? "switch switchOn" : "switch"}
      onClick={() => onChange(!value)}
    >
      <div className="switchKnob" />
    </button>
  );
}
