"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import { Toast } from "../../_ui/Toast";
import { Field } from "../../_ui/Field";
import { Switch } from "../../_ui/Switch";
import { IconBot, IconBolt, IconDownload, IconRefresh, IconUpload, IconWarn } from "../../_ui/icons";

const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

type Project = {
  id: string;
  name: string;
  status: string;
  error?: string | null;
  files: Record<string, string | null>;
};

type Detector = {
  id: string;
  project_id: string;
  x: number;
  y: number;
  z: number;
  dtype: string;
  locked: boolean;
};

type Mapping = {
  width_px: number;
  height_px: number;
  world_bbox: { xmin: number; xmax: number; ymin: number; ymax: number };
};

type Settings = {
  detector_spacing_m: number; // used by pipeline
  wall_buffer_m: number;      // used by pipeline
  target_long_side_px: number;
  gemini_model: string;
  units: "mm" | "cm" | "m" | "inch" | "ft";
  // UI-only
  grid_snap_m: number;
  show_grid: boolean;
  strategy: string;
  detector_density: "low" | "medium" | "high";
};

function worldToPixel(m: Mapping, x: number, y: number) {
  const { xmin, xmax, ymin, ymax } = m.world_bbox;
  const u = (x - xmin) / (xmax - xmin);
  const v = (ymax - y) / (ymax - ymin);
  return { px: u * m.width_px, py: v * m.height_px };
}

function pixelToWorld(m: Mapping, px: number, py: number) {
  const { xmin, xmax, ymin, ymax } = m.world_bbox;
  const u = px / m.width_px;
  const v = py / m.height_px;
  return { x: xmin + u * (xmax - xmin), y: ymax - v * (ymax - ymin) };
}

function statusClass(status?: string) {
  const s = (status || "").toLowerCase();
  if (s.includes("error")) return "badge badgeBad";
  if (s.includes("running")) return "badge badgeWarn";
  if (s.includes("done") || s.includes("ready")) return "badge badgeGood";
  if (s.includes("uploaded")) return "badge badgeInfo";
  return "badge";
}

type ChatMsg = { from: "user" | "ai"; text: string };

export default function ProjectPage({ params }: { params: { projectId: string } }) {
  const projectId = params.projectId;

  const [project, setProject] = useState<Project | null>(null);
  const [detectors, setDetectors] = useState<Detector[]>([]);
  const [mapping, setMapping] = useState<Mapping | null>(null);

  const [settings, setSettings] = useState<Settings>({
    detector_spacing_m: 7.5,
    wall_buffer_m: 0.5,
    target_long_side_px: 12000,
    gemini_model: "gemini-2.5-flash-image",
    units: "mm",

    grid_snap_m: 0.5,
    show_grid: true,
    strategy: "Grid (Optimized Coverage)",
    detector_density: "medium",
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedDetector = useMemo(
    () => detectors.find((d) => d.id === selectedId) || null,
    [detectors, selectedId]
  );

  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<null | { tone: "info"|"good"|"warn"|"bad"; title: string; message?: string }>(null);

  const [aiEnabled, setAiEnabled] = useState(true);
  const [rtCheck, setRtCheck] = useState(true);
  const [chat, setChat] = useState<ChatMsg[]>([
    { from: "ai", text: "I can flag coverage gaps and suggest placements (UI preview). Connect backend later for real compliance checks." },
  ]);
  const [chatInput, setChatInput] = useState("");

  async function refresh() {
    try {
      const p: Project = await (await fetch(`${API}/api/projects/${projectId}`)).json();
      setProject(p);

      const d: Detector[] = await (
        await fetch(`${API}/api/projects/${projectId}/detectors`)
      ).json();
      setDetectors(d);

      if (p.files?.mapping_json) {
        const mj: Mapping = await (await fetch(`${API}${p.files.mapping_json}`)).json();
        setMapping(mj);
      } else {
        setMapping(null);
      }
    } catch (e: any) {
      setToast({ tone: "bad", title: "Refresh failed", message: e?.message || "Unknown error" });
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canRender = !!project?.files?.render_png && !!mapping;

  async function saveSettings() {
    await fetch(`${API}/api/projects/${projectId}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          detector_spacing_m: settings.detector_spacing_m,
          wall_buffer_m: settings.wall_buffer_m,
          target_long_side_px: settings.target_long_side_px,
          gemini_model: settings.gemini_model,
          units: settings.units,
          // UI-only keys are fine to store too:
          grid_snap_m: settings.grid_snap_m,
          show_grid: settings.show_grid,
          strategy: settings.strategy,
          detector_density: settings.detector_density,
        },
      }),
    });
  }

  async function runPipeline() {
    setBusyMsg("Running auto-placement…");
    setToast(null);
    try {
      await saveSettings();
      const r = await fetch(`${API}/api/projects/${projectId}/run`, { method: "POST" });
      if (!r.ok) throw new Error(`Run failed (${r.status})`);
      setToast({ tone: "good", title: "Auto-Placement started", message: "Hit Refresh to update status and preview." });
      await refresh();
    } catch (e: any) {
      setToast({ tone: "bad", title: "Run failed", message: e?.message || "Unknown error" });
    } finally {
      setBusyMsg(null);
    }
  }

  async function resetDetectors() {
    setBusyMsg("Clearing detectors…");
    try {
      const r = await fetch(`${API}/api/projects/${projectId}/reset_detectors`, { method: "POST" });
      if (!r.ok) throw new Error(`Reset failed (${r.status})`);
      setSelectedId(null);
      setToast({ tone: "good", title: "Cleared detectors" });
      await refresh();
    } catch (e: any) {
      setToast({ tone: "bad", title: "Reset failed", message: e?.message || "Unknown error" });
    } finally {
      setBusyMsg(null);
    }
  }

  async function uploadFile(e: any) {
    const f: File | undefined = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);

    setBusyMsg("Uploading CAD…");
    try {
      const r = await fetch(`${API}/api/projects/${projectId}/upload`, { method: "POST", body: fd });
      if (!r.ok) throw new Error(`Upload failed (${r.status})`);
      setToast({ tone: "good", title: "Uploaded", message: "Now run Auto-Placement to render preview." });
      await refresh();
    } catch (err: any) {
      setToast({ tone: "bad", title: "Upload failed", message: err?.message || "Unknown error" });
    } finally {
      setBusyMsg(null);
    }
  }

  function pushChat(text: string) {
    if (!text.trim()) return;
    const t = text.trim();
    setChat((c) => [...c, { from: "user", text: t }]);
    setChatInput("");
    // local dummy response
    setTimeout(() => {
      setChat((c) => [
        ...c,
        {
          from: "ai",
          text:
            "Noted. For real compliance checks, we'll hook this panel to a backend endpoint. For now, you can run Auto-Placement and refine manually.",
        },
      ]);
    }, 500);
  }

  const projectTitle = project?.name ? project.name : `Project ${projectId}`;
  const status = project?.status || "loading";

  const selectedInfo = useMemo(() => {
    if (!selectedDetector || !mapping) return null;
    const covR = settings.detector_spacing_m / 2;
    const area = Math.PI * covR * covR;
    return { area };
  }, [selectedDetector, mapping, settings.detector_spacing_m]);

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <Link href="/" style={{ display: "inline-flex" }}>
            <div className="logoBox">🔥</div>
          </Link>
          <div>
            <div className="brandName">FireCAD</div>
            <div className="subTitle">
              {projectTitle} <span style={{ opacity: 0.5 }}>•</span>{" "}
              <span className={statusClass(status)}>
                <span className="badgeDot" />
                {status.toUpperCase()}
              </span>
            </div>
          </div>
        </div>

        <div className="topRight">
          {busyMsg ? (
            <span className="pill">
              <span className="spin" />
              {busyMsg}
            </span>
          ) : null}

          <span className="kbd">Click-select</span>
          <span className="kbd">Drag</span>
          <span className="kbd">Double-click</span>
          <span className="kbd">Right-click</span>

          <button className="btn iconBtn" onClick={refresh} disabled={!!busyMsg}>
            <IconRefresh /> Refresh
          </button>

          {project?.files?.output_dxf ? (
            <a className="btn iconBtn" href={`${API}${project.files.output_dxf}`} style={{ textDecoration: "none" }}>
              <IconDownload /> DXF
            </a>
          ) : (
            <button className="btn iconBtn" disabled>
              <IconDownload /> DXF
            </button>
          )}

          <button className="btn btnPrimary iconBtn" onClick={runPipeline} disabled={!!busyMsg || !project?.files?.input}>
            <IconBolt /> Auto-Placement
          </button>
        </div>
      </div>

      <div className="grid">
        {/* LEFT */}
        <aside className="side">
          <div className="sideScroll">
            <div className="sectionLabel">Upload CAD</div>
            <div className="card">
              <div className="cardInnerLg">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div className="warnIcon"><IconUpload /></div>
                  <div>
                    <div style={{ fontWeight: 900 }}>Click to upload or drag & drop</div>
                    <div style={{ marginTop: 4, color: "rgba(255,255,255,0.60)", fontSize: 12 }}>
                      .DWG, .DXF up to 50MB
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 12 }}>
                  <input type="file" accept=".dxf,.dwg" onChange={uploadFile} style={{ width: "100%", color: "rgba(255,255,255,0.70)" }} />
                </div>

                <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="kbd">{project?.files?.input ? "file uploaded" : "no file"}</span>
                  <span className="kbd">{canRender ? "preview ready" : "no preview"}</span>
                </div>

                {project?.error ? (
                  <div style={{ marginTop: 12, borderRadius: 16, border: "1px solid rgba(251,113,133,0.45)", background: "rgba(251,113,133,0.10)", padding: 10, fontSize: 12, whiteSpace: "pre-wrap" }}>
                    {project.error}
                  </div>
                ) : null}
              </div>
            </div>

            <div style={{ height: 14 }} />

            <div className="sectionLabel">Detector Settings</div>
            <div className="card">
              <div className="cardInnerLg">
                <Field label="Auto-Placement Strategy">
                  <select className="select" value={settings.strategy} onChange={(e) => setSettings({ ...settings, strategy: e.target.value })}>
                    <option>Grid (Optimized Coverage)</option>
                    <option>Symmetry-first</option>
                    <option>Max Coverage</option>
                  </select>
                </Field>

                <Field label="Grid Snap" right={`${settings.grid_snap_m.toFixed(1)}m`}>
                  <input className="range" type="range" min={0} max={2} step={0.1} value={settings.grid_snap_m} onChange={(e) => setSettings({ ...settings, grid_snap_m: Number(e.target.value) })} />
                </Field>

                <Field label="Detector Radius" right={`${(settings.detector_spacing_m).toFixed(1)}m`} hint="(Maps to detector spacing for the pipeline)">
                  <input className="range" type="range" min={3} max={12} step={0.1} value={settings.detector_spacing_m} onChange={(e) => setSettings({ ...settings, detector_spacing_m: Number(e.target.value) })} />
                </Field>

                <Field label="Wall buffer (m)" right={`${settings.wall_buffer_m.toFixed(1)}m`}>
                  <input className="range" type="range" min={0} max={2} step={0.1} value={settings.wall_buffer_m} onChange={(e) => setSettings({ ...settings, wall_buffer_m: Number(e.target.value) })} />
                </Field>

                <Field label="Units">
                  <select className="select" value={settings.units} onChange={(e) => setSettings({ ...settings, units: e.target.value as Settings["units"] })}>
                    <option value="mm">mm</option>
                    <option value="cm">cm</option>
                    <option value="m">m</option>
                    <option value="inch">inch</option>
                    <option value="ft">ft</option>
                  </select>
                </Field>

                <Field label="Render long side (px)">
                  <input className="input" type="number" step={500} value={settings.target_long_side_px} onChange={(e) => setSettings({ ...settings, target_long_side_px: Number(e.target.value) })} />
                </Field>

                <Field label="Gemini image model">
                  <input className="input" value={settings.gemini_model} onChange={(e) => setSettings({ ...settings, gemini_model: e.target.value })} />
                </Field>
              </div>
            </div>

            <div style={{ height: 14 }} />

            <div className="sectionLabel">Selected Detector</div>
            <div className="card">
              <div className="cardInnerLg">
                {selectedDetector ? (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                      <div style={{ fontWeight: 900 }}>
                        {selectedDetector.dtype === "smoke" ? "Smoke (Optical)" : "Heat"}
                      </div>
                      <span className="kbd">{selectedDetector.locked ? "locked" : "unlocked"}</span>
                    </div>

                    <div style={{ marginTop: 10, display: "grid", gap: 8, fontSize: 13, color: "rgba(255,255,255,0.78)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "rgba(255,255,255,0.55)" }}>ID</span>
                        <span className="kbd">{selectedDetector.id}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "rgba(255,255,255,0.55)" }}>Coordinates</span>
                        <span className="kbd">X: {selectedDetector.x.toFixed(1)}, Y: {selectedDetector.y.toFixed(1)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "rgba(255,255,255,0.55)" }}>Coverage</span>
                        <span className="kbd">{selectedInfo ? `${Math.round(selectedInfo.area)} m²` : "-"}</span>
                      </div>
                    </div>

                    <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <button className="btn" onClick={() => toggleLock(selectedDetector, setBusyMsg, setToast, projectId, refresh)}>
                        {selectedDetector.locked ? "Unlock" : "Lock"}
                      </button>
                      <button className="btn btnDanger" onClick={() => deleteDetector(selectedDetector.id, setBusyMsg, setToast, refresh, () => setSelectedId(null))}>
                        Delete
                      </button>
                    </div>
                  </>
                ) : (
                  <div style={{ color: "rgba(255,255,255,0.62)", fontSize: 13, lineHeight: 1.5 }}>
                    Click a detector on the canvas to see details.
                  </div>
                )}
              </div>
            </div>

            <div style={{ height: 14 }} />

            <div className="sectionLabel">Canvas Actions</div>
            <div className="card">
              <div className="cardInnerLg">
                <button className="btn btnGhost" onClick={() => setSettings({ ...settings, show_grid: !settings.show_grid })} style={{ width: "100%" }}>
                  {settings.show_grid ? "Hide Grid" : "Show Grid"}
                </button>
                <div style={{ height: 10 }} />
                <button className="btn btnDanger" onClick={resetDetectors} style={{ width: "100%" }}>
                  Clear Canvas
                </button>
              </div>
            </div>
          </div>
        </aside>

        {/* CENTER */}
        <main className="center">
          <div className="canvasFrame">
            {settings.show_grid ? <div className="canvasGrid" /> : null}
            <div className="canvasInner">
              {!canRender ? (
                <div style={{ padding: 18 }}>
                  <div style={{ fontWeight: 900, letterSpacing: "-0.01em" }}>Upload a DXF/DWG to get started</div>
                  <div style={{ marginTop: 8, color: "rgba(255,255,255,0.65)", lineHeight: 1.5 }}>
                    Then click <span className="kbd">Auto-Placement</span> to render the preview and generate detectors.
                  </div>
                  <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button className="btn btnPrimary" onClick={runPipeline} disabled={!!busyMsg || !project?.files?.input}>
                      <IconBolt /> Auto-Placement
                    </button>
                    <button className="btn" onClick={refresh} disabled={!!busyMsg}>
                      <IconRefresh /> Refresh
                    </button>
                  </div>
                </div>
              ) : (
                <Editor
                  renderUrl={`${API}${project!.files.render_png}`}
                  mapping={mapping!}
                  detectors={detectors}
                  projectId={projectId}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onChanged={refresh}
                  setToast={setToast}
                  setBusy={setBusyMsg}
                  gridSnapM={settings.grid_snap_m}
                />
              )}
            </div>

            <div className="hintRow">
              <span className="kbd">Click to select</span>
              <span className="kbd">Drag to move</span>
              <span className="kbd">Double-click to add</span>
              <span className="kbd">Right-click to delete</span>
            </div>
          </div>
        </main>

        {/* RIGHT */}
        <aside className="sideRight">
          <div className="sideScroll">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="warnIcon"><IconBot /></div>
                <div>
                  <div style={{ fontWeight: 900 }}>FireCAD AI Assistant</div>
                  <div style={{ color: "rgba(255,255,255,0.60)", fontSize: 12, marginTop: 3 }}>UI preview — connect backend later</div>
                </div>
              </div>
            </div>

            <div style={{ height: 12 }} />

            <div className="card">
              <div className="cardInner">
                <div className="toggleRow">
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", fontWeight: 800 }}>
                    Auto-detect room boundaries
                  </div>
                  <Switch value={aiEnabled} onChange={setAiEnabled} ariaLabel="auto detect boundaries" />
                </div>
                <div style={{ height: 10 }} />
                <div className="toggleRow">
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", fontWeight: 800 }}>
                    Real-time Code Compliance Check
                  </div>
                  <Switch value={rtCheck} onChange={setRtCheck} ariaLabel="realtime check" />
                </div>
              </div>
            </div>

            <div style={{ height: 12 }} />

            <div className="warning">
              <div className="warnIcon"><IconWarn /></div>
              <div>
                <div style={{ fontWeight: 900 }}>Coverage Warning</div>
                <div style={{ marginTop: 6, color: "rgba(255,255,255,0.70)" }}>
                  Elevator shafts A & B lack overlap (example). Run Auto-Placement and review.
                </div>
                <div style={{ marginTop: 10 }}>
                  <button className="btn" onClick={runPipeline} disabled={!!busyMsg || !project?.files?.input}>
                    Fix Issue Automatically
                  </button>
                </div>
              </div>
            </div>

            <div style={{ height: 12 }} />

            <div className="card">
              <div className="cardInner">
                <div className="msgList">
                  {chat.map((m, idx) => (
                    <div key={idx} className={m.from === "user" ? "bubble bubbleUser" : "bubble"}>
                      {m.text}
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
                  <input
                    className="input"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask FireCAD AI to analyze or modify…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") pushChat(chatInput);
                    }}
                  />
                  <button className="btn btnPrimary" onClick={() => pushChat(chatInput)} title="Send">
                    ↗
                  </button>
                </div>

                <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
                  AI can make mistakes. Verify CAD placement.
                </div>
              </div>
            </div>

          </div>
        </aside>
      </div>

      <Toast open={!!toast} tone={toast?.tone || "info"} title={toast?.title || ""} message={toast?.message} onClose={() => setToast(null)} />
    </div>
  );
}

async function toggleLock(
  d: Detector,
  setBusy: (s: string | null) => void,
  setToast: (t: any) => void,
  projectId: string,
  refresh: () => void
) {
  setBusy("Updating detector…");
  try {
    const r = await fetch(`${API}/api/detectors/${d.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: d.x, y: d.y, z: d.z, locked: !d.locked }),
    });
    if (!r.ok) throw new Error(`Update failed (${r.status})`);
    setToast({ tone: "good", title: d.locked ? "Unlocked" : "Locked" });
    await refresh();
  } catch (e: any) {
    setToast({ tone: "bad", title: "Update failed", message: e?.message || "Unknown error" });
  } finally {
    setBusy(null);
  }
}

async function deleteDetector(
  detId: string,
  setBusy: (s: string | null) => void,
  setToast: (t: any) => void,
  refresh: () => void,
  onDone?: () => void
) {
  setBusy("Deleting…");
  try {
    const r = await fetch(`${API}/api/detectors/${detId}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`Delete failed (${r.status})`);
    setToast({ tone: "good", title: "Deleted" });
    await refresh();
    onDone?.();
  } catch (e: any) {
    setToast({ tone: "bad", title: "Delete failed", message: e?.message || "Unknown error" });
  } finally {
    setBusy(null);
  }
}

function Editor({
  renderUrl,
  mapping,
  detectors,
  projectId,
  selectedId,
  onSelect,
  onChanged,
  setToast,
  setBusy,
  gridSnapM,
}: {
  renderUrl: string;
  mapping: Mapping;
  detectors: Detector[];
  projectId: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  setToast: (t: any) => void;
  setBusy: (s: string | null) => void;
  gridSnapM: number;
}) {
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  function onImageLoad(e: any) {
    const img = e.target as HTMLImageElement;
    setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
  }

  function snap(v: number) {
    if (!gridSnapM || gridSnapM <= 0) return v;
    return Math.round(v / gridSnapM) * gridSnapM;
  }

  async function addDetectorAt(px: number, py: number) {
    const w = pixelToWorld(mapping, px, py);
    setBusy("Adding detector…");
    try {
      const r = await fetch(`${API}/api/projects/${projectId}/detectors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: w.x, y: w.y, z: 0, dtype: "smoke" }),
      });
      if (!r.ok) throw new Error(`Add failed (${r.status})`);
      setToast({ tone: "good", title: "Added detector" });
      await onChanged();
    } catch (e: any) {
      setToast({ tone: "bad", title: "Add failed", message: e?.message || "Unknown error" });
    } finally {
      setBusy(null);
    }
  }

  async function moveDetectorTo(detId: string, px: number, py: number) {
    const det = detectors.find((d) => d.id === detId);
    if (!det) return;
    if (det.locked) {
      setToast({ tone: "warn", title: "Locked", message: "Unlock this detector to move it." });
      return;
    }

    const w = pixelToWorld(mapping, px, py);
    const xs = snap(w.x);
    const ys = snap(w.y);

    setBusy("Moving…");
    try {
      const r = await fetch(`${API}/api/detectors/${detId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: xs, y: ys, z: 0 }),
      });
      if (!r.ok) throw new Error(`Move failed (${r.status})`);
      await onChanged();
    } catch (e: any) {
      setToast({ tone: "bad", title: "Move failed", message: e?.message || "Unknown error" });
    } finally {
      setBusy(null);
    }
  }

  async function deleteDetectorAt(detId: string) {
    await deleteDetector(detId, setBusy, setToast, onChanged, () => {
      if (selectedId === detId) onSelect(null);
    });
  }

  function hitTest(px: number, py: number): string | null {
    const R2 = 14 * 14;
    for (const d of detectors) {
      const p = worldToPixel(mapping, d.x, d.y);
      const dx = p.px - px;
      const dy = p.py - py;
      if (dx * dx + dy * dy <= R2) return d.id;
    }
    return null;
  }

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <TransformWrapper wheel={{ step: 0.12 }} doubleClick={{ disabled: true }}>
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }}>
              <div style={{ position: "relative", display: "inline-block" }}>
                <img
                  src={renderUrl}
                  onLoad={onImageLoad}
                  style={{ display: "block", userSelect: "none", pointerEvents: "none" }}
                />

                {imgDims ? (
                  <svg
                    width={imgDims.w}
                    height={imgDims.h}
                    viewBox={`0 0 ${imgDims.w} ${imgDims.h}`}
                    style={{ position: "absolute", left: 0, top: 0 }}
                    onMouseDown={(e) => {
                      const rect = (e.currentTarget as any).getBoundingClientRect();
                      const px = ((e.clientX - rect.left) / rect.width) * imgDims.w;
                      const py = ((e.clientY - rect.top) / rect.height) * imgDims.h;
                      const id = hitTest(px, py);
                      if (id) {
                        onSelect(id);
                        setDragId(id);
                      } else {
                        onSelect(null);
                      }
                    }}
                    onMouseUp={(e) => {
                      if (!dragId) return;
                      const rect = (e.currentTarget as any).getBoundingClientRect();
                      const px = ((e.clientX - rect.left) / rect.width) * imgDims.w;
                      const py = ((e.clientY - rect.top) / rect.height) * imgDims.h;
                      moveDetectorTo(dragId, px, py).finally(() => setDragId(null));
                    }}
                    onDoubleClick={(e) => {
                      const rect = (e.currentTarget as any).getBoundingClientRect();
                      const px = ((e.clientX - rect.left) / rect.width) * imgDims.w;
                      const py = ((e.clientY - rect.top) / rect.height) * imgDims.h;
                      addDetectorAt(px, py);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const rect = (e.currentTarget as any).getBoundingClientRect();
                      const px = ((e.clientX - rect.left) / rect.width) * imgDims.w;
                      const py = ((e.clientY - rect.top) / rect.height) * imgDims.h;
                      const id = hitTest(px, py);
                      if (id) deleteDetectorAt(id);
                    }}
                  >
                    {detectors.map((d) => {
                      const p = worldToPixel(mapping, d.x, d.y);
                      const isSel = d.id === selectedId;
                      const isSmoke = d.dtype === "smoke";
                      const core = isSmoke ? "#ff3b30" : "#0a84ff";
                      const ring = isSmoke ? "rgba(255,59,48,0.20)" : "rgba(10,132,255,0.20)";
                      return (
                        <g key={d.id}>
                          {/* coverage ring (visual only) */}
                          <circle cx={p.px} cy={p.py} r={70} fill={ring} opacity={0.6} />
                          {isSel ? <circle cx={p.px} cy={p.py} r={18} fill={core} opacity={0.22} /> : null}
                          <circle cx={p.px} cy={p.py} r={10} fill={core} opacity={0.95} />
                          <circle cx={p.px} cy={p.py} r={10} fill="none" stroke="#ffffff" strokeWidth={2} opacity={0.95} />
                          {d.locked ? <circle cx={p.px} cy={p.py} r={4} fill="#ffffff" opacity={0.9} /> : null}
                        </g>
                      );
                    })}
                  </svg>
                ) : null}
              </div>
            </TransformComponent>

            <div className="zoomPad">
              <button className="zoomBtn" onClick={() => zoomIn()} title="Zoom in">+</button>
              <button className="zoomBtn" onClick={() => zoomOut()} title="Zoom out">−</button>
              <button className="zoomBtn" onClick={() => resetTransform()} title="Reset">⤢</button>
            </div>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}
