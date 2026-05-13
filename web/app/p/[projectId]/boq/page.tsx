"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getToken, getTenantRole } from "../../../lib/auth";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");

function resolveApiBase() {
  if (API_BASE) return API_BASE;
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return "http://localhost:8000";
  }
  return "";
}
const apiUrl = (path: string) => `${resolveApiBase()}${path}`;

async function authFetch(path: string, init?: RequestInit) {
  const token = getToken();
  const headers: Record<string, string> = { ...(init?.headers as any) };
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  if (!isForm && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(apiUrl(path), { ...init, headers });
  if (!res.ok) throw new Error((await res.text()) || `Error ${res.status}`);
  return res;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type BOQItem = {
  id: string;
  project_id: string;
  section: string;
  item_type: string;
  description: string;
  qty: number;
  unit: string;
  unit_price: number;
  notes: string | null;
  sort_order: number;
};

type BOQMeta = {
  project_id: string;
  client_name: string | null;
  quote_title: string | null;
  quote_number: string | null;
  valid_from: string | null;
  valid_until: string | null;
  version: number;
  scope_notes: string | null;
};

type Tab = "details" | "items";

const UNITS = ["unit", "EA", "m", "m²", "m³", "ls", "hr", "set"];
const EQUIPMENT_TYPES = [
  "Sprinkler",
  "Smoke Detector",
  "MCP",
  "Fire Hose Reel",
  "Internal Hydrant",
  "Hooter",
  "Beam Detector",
  "Control Panel",
  "GI Pipe",
  "Pump",
  "Valve",
  "Cable",
  "Conduit",
  "Other",
];

// ── Main Component ────────────────────────────────────────────────────────────

export default function BOQPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const router = useRouter();

  const [tab, setTab] = useState<Tab>("items");
  const [items, setItems] = useState<BOQItem[]>([]);
  const [meta, setMeta] = useState<BOQMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [dirty, setDirty] = useState(false);
  const isReadonly = getTenantRole() === "viewer";

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [metaRes, itemsRes, projRes] = await Promise.all([
          authFetch(`/api/projects/${projectId}/boq/meta`),
          authFetch(`/api/projects/${projectId}/boq/items`),
          authFetch(`/api/projects/${projectId}`),
        ]);
        const [metaData, itemsData, projData] = await Promise.all([
          metaRes.json(),
          itemsRes.json(),
          projRes.json(),
        ]);
        if (!alive) return;
        setMeta(metaData);
        setItems(itemsData);
        setProjectName(projData.name || "");
      } catch (e: any) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => { alive = false; };
  }, [projectId]);

  // ── Item helpers ──────────────────────────────────────────────────────────
  function updateItem(id: string, key: keyof BOQItem, value: any) {
    setItems(prev => prev.map(it => it.id === id ? { ...it, [key]: value } : it));
    setDirty(true);
  }

  function addItem() {
    const newItem: BOQItem = {
      id: `new-${Date.now()}`,
      project_id: projectId,
      section: "Equipment",
      item_type: "Other",
      description: "",
      qty: 1,
      unit: "unit",
      unit_price: 0,
      notes: null,
      sort_order: items.length,
    };
    setItems(prev => [...prev, newItem]);
    setDirty(true);
  }

  function removeItem(id: string) {
    setItems(prev => prev.filter(it => it.id !== id));
    setDirty(true);
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function save() {
    if (saving || isReadonly) return;
    setSaving(true);
    try {
      await authFetch(`/api/projects/${projectId}/boq/save`, {
        method: "POST",
        body: JSON.stringify({
          meta: meta ? {
            client_name: meta.client_name,
            quote_title: meta.quote_title,
            quote_number: meta.quote_number,
            valid_from: meta.valid_from,
            valid_until: meta.valid_until,
            version: meta.version,
            scope_notes: meta.scope_notes,
          } : undefined,
          items: items.map((it, idx) => ({
            section: it.section,
            item_type: it.item_type,
            description: it.description,
            qty: it.qty,
            unit: it.unit,
            unit_price: it.unit_price,
            notes: it.notes,
            sort_order: idx,
          })),
        }),
      });
      setDirty(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Repopulate ────────────────────────────────────────────────────────────
  async function repopulate() {
    if (!confirm("This will replace all current BOQ items with counts from the drawing placements. Continue?")) return;
    setSaving(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/boq/repopulate`, { method: "POST" });
      const newItems = await res.json();
      setItems(newItems);
      setDirty(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Export Excel ──────────────────────────────────────────────────────────
  async function exportExcel() {
    if (exporting) return;
    // Save first
    if (dirty) await save();
    setExporting(true);
    try {
      const token = getToken();
      const res = await fetch(apiUrl(`/api/projects/${projectId}/boq/export`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="?([^"]+)"?/);
      a.download = match ? match[1] : "BOQ.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  }

  // ── Derived totals ────────────────────────────────────────────────────────
  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#F5F6FA" }}>
        <div style={{ textAlign: "center", color: "#6B7280" }}>
          <div style={{ width: 40, height: 40, border: "3px solid #E8EAED", borderTopColor: "#2D6A4F", borderRadius: "50%", margin: "0 auto 12px" }} />
          <div style={{ fontSize: 14 }}>Loading BOQ…</div>
        </div>
      </div>
    );
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: "details", label: "Quote Details" },
    { key: "items", label: "Line Items" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#F5F6FA", fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* ── Top Bar ─────────────────────────────────────────────────────── */}
      <div style={{
        background: "#FFFFFF", borderBottom: "1px solid #E8EAED",
        padding: "0 24px", display: "flex", alignItems: "center", gap: 12, height: 56,
        boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
      }}>
        <button
          onClick={() => router.push(`/p/${projectId}`)}
          title="Back to project"
          style={{
            background: "none", border: "1px solid #E8EAED", cursor: "pointer",
            color: "#6B7280", fontSize: 15, padding: "6px 10px", borderRadius: 8,
            display: "flex", alignItems: "center",
          }}
        >
          ←
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, background: "#2D6A4F",
            display: "grid", placeItems: "center", flexShrink: 0,
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
          </div>
          <div>
            <div style={{ fontWeight: 700, color: "#1A1A2E", fontSize: 15, lineHeight: 1.2 }}>{projectName || "Project"}</div>
            <div style={{ fontSize: 11, color: "#6B7280" }}>Bill of Quantities</div>
          </div>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {!isReadonly && (
            <>
              <button
                onClick={repopulate}
                disabled={saving}
                style={ghostBtn}
                title="Re-read equipment counts from drawing placements"
              >
                ↺ From Drawing
              </button>
              <button
                onClick={save}
                disabled={saving || !dirty}
                style={dirty ? primaryBtn : ghostBtn}
              >
                {saving ? "Saving…" : dirty ? "● Save" : "Saved"}
              </button>
            </>
          )}
          <button onClick={exportExcel} disabled={exporting} style={successBtn}>
            {exporting ? "Exporting…" : "⬇ Export Excel"}
          </button>
        </div>
      </div>

      {/* ── Tab Bar ─────────────────────────────────────────────────────── */}
      <div style={{ background: "#FFFFFF", borderBottom: "1px solid #E8EAED", padding: "0 24px", display: "flex" }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: "13px 20px", fontSize: 13, fontWeight: tab === t.key ? 700 : 500,
              color: tab === t.key ? "#2D6A4F" : "#6B7280",
              borderBottom: tab === t.key ? "2px solid #2D6A4F" : "2px solid transparent",
              transition: "all 0.15s",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          background: "#FEF2F2", borderBottom: "1px solid #FECACA",
          color: "#991B1B", padding: "10px 24px", fontSize: 13,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          {error}
          <button onClick={() => setError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#991B1B", fontSize: 16 }}>✕</button>
        </div>
      )}

      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 20px" }}>

        {/* ── Quote Details ──────────────────────────────────────────────── */}
        {tab === "details" && meta && (
          <div style={card}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#1A1A2E", marginBottom: 20 }}>Quote Details</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <Field label="Quote To / Client Name">
                <input
                  value={meta.client_name || ""}
                  onChange={e => { setMeta(m => m ? { ...m, client_name: e.target.value } : m); setDirty(true); }}
                  style={inputSt}
                  placeholder="e.g. Kapoor Watch Co."
                  disabled={isReadonly}
                />
              </Field>
              <Field label="Quote Number">
                <input
                  value={meta.quote_number || ""}
                  onChange={e => { setMeta(m => m ? { ...m, quote_number: e.target.value } : m); setDirty(true); }}
                  style={inputSt}
                  placeholder="e.g. Q-2026-0001"
                  disabled={isReadonly}
                />
              </Field>
              <Field label="Quote Title" style={{ gridColumn: "1 / -1" }}>
                <input
                  value={meta.quote_title || ""}
                  onChange={e => { setMeta(m => m ? { ...m, quote_title: e.target.value } : m); setDirty(true); }}
                  style={inputSt}
                  placeholder="e.g. Ground Floor Fire Suppression Takeoff"
                  disabled={isReadonly}
                />
              </Field>
              <Field label="Valid From">
                <input
                  type="date"
                  value={meta.valid_from || ""}
                  onChange={e => { setMeta(m => m ? { ...m, valid_from: e.target.value } : m); setDirty(true); }}
                  style={inputSt}
                  disabled={isReadonly}
                />
              </Field>
              <Field label="Valid Until">
                <input
                  type="date"
                  value={meta.valid_until || ""}
                  onChange={e => { setMeta(m => m ? { ...m, valid_until: e.target.value } : m); setDirty(true); }}
                  style={inputSt}
                  disabled={isReadonly}
                />
              </Field>
              <Field label="Scope / Notes" style={{ gridColumn: "1 / -1" }}>
                <textarea
                  value={meta.scope_notes || ""}
                  onChange={e => { setMeta(m => m ? { ...m, scope_notes: e.target.value } : m); setDirty(true); }}
                  style={{ ...inputSt, height: 88, resize: "vertical" }}
                  placeholder="Brief scope description to appear in the exported document…"
                  disabled={isReadonly}
                />
              </Field>
            </div>
          </div>
        )}

        {/* ── Line Items Tab ──────────────────────────────────────────────── */}
        {tab === "items" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {items.length === 0 ? (
              <div style={{ ...card, textAlign: "center", padding: 48 }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>📋</div>
                <div style={{ fontWeight: 700, color: "#1A1A2E", fontSize: 15, marginBottom: 6 }}>No items yet</div>
                <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 20 }}>
                  Click <strong>↺ From Drawing</strong> to auto-populate quantities from placed equipment, or add items manually.
                </div>
                {!isReadonly && (
                  <button onClick={addItem} style={primaryBtn}>+ Add First Item</button>
                )}
              </div>
            ) : (
              <div style={{ ...card, padding: 0, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
                    <thead>
                      <tr style={{ background: "#F9FAFB", borderBottom: "1px solid #E8EAED" }}>
                        <th style={{ ...thSt, textAlign: "center", width: 36 }}>#</th>
                        <th style={{ ...thSt, textAlign: "left", width: 140 }}>TYPE</th>
                        <th style={{ ...thSt, textAlign: "left" }}>DESCRIPTION</th>
                        <th style={{ ...thSt, textAlign: "right", width: 76 }}>QTY</th>
                        <th style={{ ...thSt, textAlign: "center", width: 80 }}>UNIT</th>
                        <th style={{ ...thSt, textAlign: "right", width: 110 }}>UNIT PRICE</th>
                        <th style={{ ...thSt, textAlign: "right", width: 110 }}>TOTAL</th>
                        {!isReadonly && <th style={{ ...thSt, width: 36 }} />}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, idx) => (
                        <tr key={item.id} style={{ borderBottom: "1px solid #F3F4F6", background: idx % 2 === 0 ? "#FFFFFF" : "#FAFAFA", verticalAlign: "top" }}>
                          {/* # */}
                          <td style={{ ...tdSt, textAlign: "center", color: "#9CA3AF", fontSize: 12, paddingTop: 14 }}>{idx + 1}</td>
                          {/* TYPE */}
                          <td style={{ ...tdSt, paddingTop: 10 }}>
                            <select
                              value={item.item_type}
                              onChange={e => updateItem(item.id, "item_type", e.target.value)}
                              disabled={isReadonly}
                              style={{
                                width: "100%", border: "1px solid #E8EAED", borderRadius: 6,
                                padding: "6px 8px", fontSize: 13, color: "#1A1A2E",
                                background: "#fff", outline: "none", cursor: "pointer",
                                fontWeight: 600,
                              }}
                            >
                              {/* Include the current value if it's not in the static list (e.g. old DB entries) */}
                              {!EQUIPMENT_TYPES.includes(item.item_type) && item.item_type && (
                                <option value={item.item_type}>{item.item_type}</option>
                              )}
                              {EQUIPMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </td>
                          {/* DESCRIPTION */}
                          <td style={tdSt}>
                            <textarea
                              value={item.description}
                              onChange={e => updateItem(item.id, "description", e.target.value)}
                              disabled={isReadonly}
                              placeholder={`e.g. Type: End suction\nCapacity = 2280 LPM\nHead = 95 M\nMotor RPM — 2900`}
                              rows={Math.max(2, (item.description.match(/\n/g) || []).length + 1)}
                              style={{
                                width: "100%", border: "1px solid transparent", borderRadius: 6,
                                padding: "6px 8px", fontSize: 13, background: "transparent",
                                outline: "none", color: item.description ? "#1A1A2E" : "#9CA3AF",
                                cursor: isReadonly ? "default" : "text", boxSizing: "border-box",
                                resize: "vertical", fontFamily: "inherit", lineHeight: 1.5,
                              }}
                              onFocus={e => (e.target.style.borderColor = "#2D6A4F")}
                              onBlur={e => (e.target.style.borderColor = "transparent")}
                            />
                          </td>
                          {/* QTY */}
                          <td style={{ ...tdSt, textAlign: "right" }}>
                            <input
                              type="number"
                              value={item.qty}
                              min={0}
                              step={1}
                              onChange={e => updateItem(item.id, "qty", parseFloat(e.target.value) || 0)}
                              disabled={isReadonly}
                              style={{
                                width: 64, textAlign: "right", border: "1px solid #E8EAED",
                                borderRadius: 6, padding: "5px 7px", fontSize: 14, fontWeight: 600,
                                color: "#1A1A2E", outline: "none", background: "#fff",
                              }}
                              onFocus={e => (e.target.style.borderColor = "#2D6A4F")}
                              onBlur={e => (e.target.style.borderColor = "#E8EAED")}
                            />
                          </td>
                          {/* UNIT */}
                          <td style={{ ...tdSt, textAlign: "center" }}>
                            <select
                              value={item.unit}
                              onChange={e => updateItem(item.id, "unit", e.target.value)}
                              disabled={isReadonly}
                              style={{
                                border: "1px solid #E8EAED", borderRadius: 6, padding: "5px 7px",
                                fontSize: 13, color: "#374151", background: "#fff", outline: "none",
                                minWidth: 64, cursor: "pointer",
                              }}
                            >
                              {UNITS.map(u => <option key={u}>{u}</option>)}
                            </select>
                          </td>
                          {/* UNIT PRICE */}
                          <td style={{ ...tdSt, textAlign: "right" }}>
                            <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                              <input
                                type="number"
                                value={item.unit_price > 0 ? String(item.unit_price) : ""}
                                min={0}
                                step={0.01}
                                onChange={e => updateItem(item.id, "unit_price", e.target.value === "" ? 0 : (parseFloat(e.target.value) || 0))}
                                disabled={isReadonly}
                                placeholder={(item.item_type || "").toLowerCase().includes("pipe") ? "per m" : ""}
                                style={{
                                  width: 96, textAlign: "right", border: "1px solid #E8EAED",
                                  borderRadius: 6, padding: "5px 7px", fontSize: 13, fontWeight: 600,
                                  color: "#1A1A2E", outline: "none", background: "#fff",
                                }}
                                onFocus={e => (e.target.style.borderColor = "#2D6A4F")}
                                onBlur={e => (e.target.style.borderColor = "#E8EAED")}
                              />
                              {(item.item_type || "").toLowerCase().includes("pipe") && (
                                <span style={{ fontSize: 12, color: "#6B7280", minWidth: 20 }}>/m</span>
                              )}
                            </div>
                          </td>
                          {/* TOTAL */}
                          <td style={{ ...tdSt, textAlign: "right", fontWeight: 700, color: "#1A1A2E" }}>
                            {item.unit_price > 0 ? (item.qty * item.unit_price).toFixed(2) : ""}
                          </td>
                          {/* DELETE */}
                          {!isReadonly && (
                            <td style={{ ...tdSt, textAlign: "center" }}>
                              <button
                                onClick={() => removeItem(item.id)}
                                style={{
                                  background: "none", border: "none", cursor: "pointer",
                                  color: "#D1D5DB", fontSize: 15, padding: "3px 6px",
                                  borderRadius: 4, transition: "color 0.15s",
                                }}
                                onMouseEnter={e => (e.currentTarget.style.color = "#EF4444")}
                                onMouseLeave={e => (e.currentTarget.style.color = "#D1D5DB")}
                                title="Remove"
                              >✕</button>
                            </td>
                          )}
                        </tr>
                      ))}
                      {/* Add row */}
                      {!isReadonly && (
                        <tr>
                          <td colSpan={8} style={{ padding: "10px 12px" }}>
                            <button
                              onClick={addItem}
                              style={{
                                background: "none", border: "1px dashed #D1D5DB", borderRadius: 8,
                                padding: "8px 16px", fontSize: 13, color: "#9CA3AF", cursor: "pointer",
                                width: "100%", textAlign: "left", transition: "all 0.15s",
                              }}
                              onMouseEnter={e => { e.currentTarget.style.borderColor = "#2D6A4F"; e.currentTarget.style.color = "#2D6A4F"; }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = "#D1D5DB"; e.currentTarget.style.color = "#9CA3AF"; }}
                            >+ Add item…</button>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {items.length > 0 && (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <span style={{ fontSize: 12, color: "#9CA3AF" }}>
                  {items.length} {items.length === 1 ? "item" : "items"}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

function Field({ label, children, style }: {
  label: string; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, ...style }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const card: React.CSSProperties = {
  background: "#FFFFFF", borderRadius: 12, border: "1px solid #E8EAED",
  boxShadow: "0 1px 4px rgba(0,0,0,0.05)", padding: 24,
};

const inputSt: React.CSSProperties = {
  border: "1px solid #E8EAED", borderRadius: 8, padding: "9px 12px",
  fontSize: 14, color: "#1A1A2E", outline: "none", width: "100%",
  boxSizing: "border-box", background: "#fff",
};

const thSt: React.CSSProperties = {
  padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#6B7280",
  textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap",
  textAlign: "center",
};

const tdSt: React.CSSProperties = {
  padding: "8px 12px", fontSize: 13, color: "#374151", verticalAlign: "middle",
};

const primaryBtn: React.CSSProperties = {
  background: "#2D6A4F", color: "#fff", border: "none", borderRadius: 8,
  padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  background: "#fff", color: "#374151", border: "1px solid #E8EAED",
  borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer",
};

const successBtn: React.CSSProperties = {
  background: "#2D6A4F", color: "#fff", border: "none", borderRadius: 8,
  padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer",
};
