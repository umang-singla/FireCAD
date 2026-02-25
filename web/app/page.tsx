"use client";

import Link from "next/link";
import { useState } from "react";
import { Toast } from "./_ui/Toast";

const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

export default function Home() {
  const [name, setName] = useState("My Building");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<null | { tone: "info"|"good"|"warn"|"bad"; title: string; message?: string }>(null);

  async function createProject() {
    setBusy(true);
    setToast(null);
    try {
      const r = await fetch(`${API}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(`Create failed (${r.status})`);
      const j = await r.json();
      setProjectId(j.id);
      setToast({ tone: "good", title: "Project created", message: "Open the editor, upload DXF/DWG, and run Auto-Placement." });
    } catch (e: any) {
      setToast({ tone: "bad", title: "Could not create project", message: e?.message || "Unknown error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center" }}>
      <div style={{ width: "min(1100px, 100%)", margin: "0 auto", padding: "28px 18px" }}>
        <div className="card">
          <div className="cardInnerLg">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
              <div className="brand">
                <div className="logoBox">🔥</div>
                <div>
                  <div className="brandName">FireCAD</div>
                  <div className="subTitle">Upload CAD → Auto-place → Edit → Export DXF</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <span className="kbd">DXF/DWG</span>
                <span className="kbd">Detector editor</span>
                <span className="kbd">Export DXF</span>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 16, marginTop: 18, alignItems: "start" }}>
              <div>
                <h1 className="hTitle" style={{ fontSize: 44, lineHeight: 1.05 }}>
                  A pro-grade detector layout editor.
                </h1>
                <p className="hSub" style={{ fontSize: 15, maxWidth: 640 }}>
                  FireCAD renders your plan, lets you place and edit detectors with precision, and exports an updated DXF ready for drawings.
                </p>

                <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Project name"
                    style={{ flex: 1, minWidth: 220 }}
                  />
                  <button className="btn btnPrimary" onClick={createProject} disabled={busy}>
                    {busy ? "Creating…" : "Create Project"}
                  </button>
                </div>

                {projectId ? (
                  <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <Link href={`/p/${projectId}`} className="btn btnPrimary" style={{ textDecoration: "none" }}>
                      Open Editor →
                    </Link>
                    <span className="kbd">id: {projectId}</span>
                  </div>
                ) : (
                  <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span className="kbd">Tip: run locally with</span>
                    <span className="kbd">docker compose up --build</span>
                  </div>
                )}
              </div>

              <div className="card" style={{ boxShadow: "none" }}>
                <div className="cardInnerLg">
                  <div className="sectionLabel">What you can do</div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {[
                      ["Upload CAD", "Import DXF/DWG and get a clean preview."],
                      ["Auto-Placement", "Generate initial detector placement from rules."],
                      ["Edit Fast", "Click-select, drag, double-click to add."],
                      ["Export DXF", "Download updated DXF output."],
                    ].map(([t, d]) => (
                      <div key={t} style={{ border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.22)", borderRadius: 16, padding: 12 }}>
                        <div style={{ fontWeight: 900 }}>{t}</div>
                        <div style={{ marginTop: 6, color: "rgba(255,255,255,0.68)", fontSize: 13, lineHeight: 1.45 }}>{d}</div>
                      </div>
                    ))}
                  </div>

                  <hr className="hr" />
                  <div style={{ color: "rgba(255,255,255,0.62)", fontSize: 13, lineHeight: 1.45 }}>
                    Editor controls:
                    <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <span className="kbd">click = select</span>
                      <span className="kbd">drag = move</span>
                      <span className="kbd">double-click = add</span>
                      <span className="kbd">right-click = delete</span>
                      <span className="kbd">scroll = zoom</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>

        <Toast open={!!toast} tone={toast?.tone || "info"} title={toast?.title || ""} message={toast?.message} onClose={() => setToast(null)} />
      </div>
    </div>
  );
}
