"use client";

import { use, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { getToken } from "../../lib/auth";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");

function resolveApiBase() {
  if (API_BASE) return API_BASE;
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:8000";
    }
  }
  return "";
}

const apiUrl = (path: string) => `${resolveApiBase()}${path}`;

const NETWORK_PENDING_EVENT = "firecad-network-pending";
let networkPendingCount = 0;

function emitNetworkPending() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<number>(NETWORK_PENDING_EVENT, { detail: networkPendingCount }));
}

function beginNetworkActivity() {
  networkPendingCount += 1;
  emitNetworkPending();
}

function endNetworkActivity() {
  networkPendingCount = Math.max(0, networkPendingCount - 1);
  emitNetworkPending();
}

function getNetworkPendingCount() {
  return networkPendingCount;
}

async function trackedFetch(url: string, init?: RequestInit) {
  beginNetworkActivity();
  try {
    return await fetch(url, init);
  } finally {
    endNetworkActivity();
  }
}

const WORLD_TO_M_BY_UNIT: Record<string, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1.0,
  inch: 0.0254,
  in: 0.0254,
  ft: 0.3048,
};

function deriveWorldToMFromUnits(units: string) {
  const key = (units || "").trim().toLowerCase();
  return WORLD_TO_M_BY_UNIT[key] ?? 0.001;
}

async function authFetch(path: string, init?: RequestInit) {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };

  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  if (!isFormData && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  beginNetworkActivity();
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...init, headers });
  } finally {
    endNetworkActivity();
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed (${res.status})`);
  }
  return res;
}

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

type ObjectType = "smoke" | "panel" | "hooter" | "mcb";

const OBJECT_TYPES: ObjectType[] = ["smoke", "panel", "hooter", "mcb"];

type Mapping = {
  width_px: number;
  height_px: number;
  world_bbox: { xmin:number; xmax:number; ymin:number; ymax:number };
  pixel_fit?: {
    mode?: string;
    scale: number;
    offset_x: number;
    offset_y: number;
    draw_width?: number;
    draw_height?: number;
  };
};

function worldToPixel(m: Mapping, x: number, y: number) {
  const { xmin, xmax, ymin, ymax } = m.world_bbox;
  const fit = m.pixel_fit;
  if (fit && Number.isFinite(fit.scale) && fit.scale > 0) {
    return {
      px: fit.offset_x + (x - xmin) * fit.scale,
      py: fit.offset_y + (ymax - y) * fit.scale,
    };
  }
  const u = (x - xmin) / (xmax - xmin);
  const v = (ymax - y) / (ymax - ymin);
  return { px: u * m.width_px, py: v * m.height_px };
}
function pixelToWorld(m: Mapping, px: number, py: number) {
  const { xmin, xmax, ymin, ymax } = m.world_bbox;
  const fit = m.pixel_fit;
  if (fit && Number.isFinite(fit.scale) && fit.scale > 0) {
    return {
      x: xmin + (px - fit.offset_x) / fit.scale,
      y: ymax - (py - fit.offset_y) / fit.scale,
    };
  }
  const u = px / m.width_px;
  const v = py / m.height_px;
  return { x: xmin + u*(xmax-xmin), y: ymax - v*(ymax-ymin) };
}

export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [detectors, setDetectors] = useState<Detector[]>([]);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [networkPending, setNetworkPending] = useState(0);
  const [wizardStep, setWizardStep] = useState(1);

  const [settings, setSettings] = useState<any>({
    detector_spacing_m: 5.0,
    wall_buffer_m: 0.5,
    target_long_side_px: 12000,
    gemini_model: "gemini-3.1-flash-image-preview",
    building_type: "residential",
    has_false_ceiling: false,
    units: "mm",
    typical_ceiling_height: 3.0,
    ceiling_height_unit: "m",

  });

  async function refresh() {
    const p: Project = await (await authFetch(`/api/projects/${projectId}`)).json();
    setProject(p);

    const d: Detector[] = await (await authFetch(`/api/projects/${projectId}/detectors`)).json();
    setDetectors(d);

    const mappingUrl = p.files?.mapping_json || p.files?.output_preview_mapping;
    if (mappingUrl) {
      const mj: Mapping = await (await trackedFetch(apiUrl(mappingUrl), { cache: "no-store" })).json();
      setMapping(mj);
    } else {
      setMapping(null);
    }
  }

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    setNetworkPending(getNetworkPendingCount());
    const handler = (event: Event) => {
      const next = (event as CustomEvent<number>).detail;
      setNetworkPending(Number.isFinite(next) ? next : getNetworkPendingCount());
    };
    window.addEventListener(NETWORK_PENDING_EVENT, handler as EventListener);
    return () => window.removeEventListener(NETWORK_PENDING_EVENT, handler as EventListener);
  }, []);

  useEffect(() => {
    if (!project) return;
    if (!project.files?.input) {
      setWizardStep(1);
      return;
    }
    setWizardStep((current) => {
      if (current < 2) return 2;
      return current;
    });
  }, [project]);

  async function saveSettings() {
    const normalizedSettings = {
      ...settings,
      world_to_m: deriveWorldToMFromUnits(String(settings.units || "mm")),
    };

    await authFetch(`/api/projects/${projectId}/settings`, {
      method:"POST",
      body: JSON.stringify({ settings: normalizedSettings })
    });
    setSettings(normalizedSettings);
    await refresh();
  }

  async function runPipeline() {
    await saveSettings();
    await authFetch(`/api/projects/${projectId}/run`, { method:"POST" });
    await refresh();
  }

  const isReady = project?.status === "ready";
  const isAwaitingAlignmentReview = project?.status === "awaiting_alignment_review";
  const isRunning = project?.status === "running";
  const isQuestionnaireMode = !isReady && !isAwaitingAlignmentReview && !isRunning;
  const showGlobalLoader = project === null || networkPending > 0;

  async function saveLayout() {
    await authFetch(`/api/projects/${projectId}/save`, { method:"POST" });
    await refresh();
  }

  async function continuePipelineAfterAlignment(adjustedMaskBlob?: Blob) {
    if (adjustedMaskBlob) {
      const fd = new FormData();
      fd.append("file", adjustedMaskBlob, "mask_aligned_adjusted.png");
      await authFetch(`/api/projects/${projectId}/aligned_mask`, { method:"POST", body: fd });
    }
    await authFetch(`/api/projects/${projectId}/continue`, { method:"POST" });
    await refresh();
  }

  async function uploadAlignedMaskFile(e: any) {
    const f: File | undefined = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    await authFetch(`/api/projects/${projectId}/aligned_mask`, { method:"POST", body: fd });
    await refresh();
  }

  return (
    <main
      style={{
        ...styles.workspace,
        gridTemplateColumns: "1fr"
      }}
    >
      <div style={styles.bgGlowTop} />
      <div style={styles.bgGlowBottom} />

      {isQuestionnaireMode ? (
        <section style={styles.questionnaireCenterWrap}>
          <div style={styles.questionnaireCard}>
            <div style={styles.sidebarTopRow}>
              <div>
                <div style={styles.sidebarLabel}>Project</div>
                <strong style={styles.projectTitle}>{project?.name || "Loading..."}</strong>
              </div>
              <button onClick={refresh} style={btn(false, true)}>Refresh</button>
            </div>

            <div style={styles.statusRow}>
              <span>Status</span>
              <span style={styles.statusValue}>{project?.status || "-"}</span>
            </div>

            {project?.error ? (
              <pre style={styles.errorBox}>
{project.error}
              </pre>
            ) : null}

            <h4 style={{ ...styles.sectionTitle, marginTop: 16 }}>Setup questionnaire</h4>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
              Step {wizardStep} of 4
            </div>

            <div key={`wizard-step-${wizardStep}`} className="wizardStepPanel">
              {wizardStep === 1 ? (
                <>
                  <Field label="Input DWG/DXF drawing">
                    <input
                      type="file"
                      accept=".dxf,.dwg"
                      onChange={async (e) => {
                        await uploadFile(projectId, e, refresh);
                        setWizardStep(2);
                      }}
                    />
                  </Field>
                  <div style={{ display:"flex", gap: 10, marginTop: 14 }}>
                    <button
                      onClick={() => setWizardStep(2)}
                      disabled={!project?.files?.input}
                      style={btn(true)}
                    >
                      Continue
                    </button>
                  </div>
                </>
              ) : null}

              {wizardStep === 2 ? (
                <>
                  <Field label="What type of building is this?">
                    <select value={settings.building_type} onChange={(e)=>setSettings({...settings, building_type: e.target.value})}>
                      <option value="residential">Residential</option>
                      <option value="commercial">Commercial</option>
                      <option value="industrial">Industrial</option>
                      <option value="hospital">Hospital</option>
                      <option value="school">School</option>
                    </select>
                  </Field>
                  <div style={{ display:"flex", gap: 10, marginTop: 14 }}>
                    <button onClick={() => setWizardStep(1)} style={btn(false)}>Back</button>
                    <button onClick={() => setWizardStep(3)} style={btn(true)}>Next</button>
                  </div>
                </>
              ) : null}

              {wizardStep === 3 ? (
                <>
                  <Field label="What units is this drawing in?">
                    <select value={settings.units} onChange={(e)=>setSettings({...settings, units: e.target.value})}>
                      <option value="mm">mm</option>
                      <option value="cm">cm</option>
                      <option value="m">m</option>
                      <option value="inch">inch</option>
                      <option value="ft">ft</option>
                    </select>
                  </Field>
                  <div style={{ display:"flex", gap: 10, marginTop: 14 }}>
                    <button onClick={() => setWizardStep(2)} style={btn(false)}>Back</button>
                    <button onClick={() => setWizardStep(4)} style={btn(true)}>Next</button>
                  </div>
                </>
              ) : null}

              {wizardStep === 4 ? (
                <>
                  <Field label="What’s the typical ceiling height?">
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        type="number"
                        min={0}
                        step="0.1"
                        value={settings.typical_ceiling_height}
                        onChange={(e)=>setSettings({...settings, typical_ceiling_height: Number(e.target.value)})}
                      />
                      <select
                        value={settings.ceiling_height_unit}
                        onChange={(e)=>setSettings({...settings, ceiling_height_unit: e.target.value})}
                        style={{ width: 92 }}
                      >
                        <option value="m">m</option>
                        <option value="ft">ft</option>
                      </select>
                    </div>
                  </Field>
                  <div style={{ display:"flex", gap: 10, marginTop: 14 }}>
                    <button onClick={() => setWizardStep(3)} style={btn(false)}>Back</button>
                    <button onClick={runPipeline} style={btn(true)}>Run Auto-Placement</button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {isRunning ? (
      <section style={styles.questionnaireCenterWrap}>
        <div style={styles.runningCard}>
          <div className="runningOrb" />
          <div className="runningRing" />
          <h3 style={{ margin: "0 0 8px 0", fontSize: 24 }}>Processing your drawing</h3>
          <p style={{ margin: 0, opacity: 0.8, textAlign: "center", maxWidth: 460 }}>
            Pipeline is running. We’re extracting rooms, placing detectors, and preparing outputs. This usually takes a moment.
          </p>
          <div style={{ marginTop: 14, fontSize: 12, opacity: 0.75 }}>
            Status: {project?.status || "running"}
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 10 }}>
            <button onClick={refresh} style={btn(false, true)}>Refresh status</button>
          </div>
        </div>
      </section>
      ) : null}

      {!isQuestionnaireMode && !isRunning ? (
      <section style={styles.canvasPanel}>
        {isAwaitingAlignmentReview ? (
          project?.files?.aligned_mask && project?.files?.render_png ? (
            <AlignmentReview
              originalUrl={apiUrl(project.files.render_png)}
              alignedUrl={apiUrl(project.files.aligned_mask)}
              onContinue={continuePipelineAfterAlignment}
              onUploadAlignedMask={uploadAlignedMaskFile}
              onRefresh={refresh}
            />
          ) : (
            <div style={styles.emptyState}>
              <h3 style={styles.emptyTitle}>Aligned mask not available</h3>
              <p style={styles.emptySubtitle}>Upload an aligned mask from the sidebar to continue.</p>
            </div>
          )
        ) : !project?.files?.render_png || !mapping ? (
          <div style={styles.emptyState}>
            <h3 style={styles.emptyTitle}>No preview yet</h3>
            <p style={styles.emptySubtitle}>Upload a DXF/DWG and run auto-placement to generate your interactive view.</p>
          </div>
        ) : (
          <Editor
            renderUrl={apiUrl(project.files.render_png)}
            mapping={mapping}
            detectors={detectors}
            projectId={projectId}
            isReady={isReady}
            exportDxfUrl={project?.files?.output_dxf ? apiUrl(project.files.output_dxf) : null}
            exportPngUrl={project?.files?.output_preview_png ? apiUrl(project.files.output_preview_png) : null}
            onSave={saveLayout}
            onChanged={refresh}
          />
        )}
      </section>
      ) : null}

      {showGlobalLoader ? (
        <div style={styles.globalLoaderOverlay}>
          <div style={styles.globalLoaderCard}>
            <div className="globalLoaderSpinner" />
            <div style={{ fontSize: 16, fontWeight: 600 }}>Loading</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Please wait while we complete your request...</div>
          </div>
        </div>
      ) : null}

      <style jsx>{`
        input,
        select,
        button {
          font: inherit;
        }

        input[type="text"],
        input[type="number"],
        select {
          width: 100%;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          background: rgba(14, 19, 36, 0.85);
          color: #f4f7ff;
          padding: 10px 12px;
          outline: none;
        }

        input[type="file"] {
          width: 100%;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          background: rgba(14, 19, 36, 0.7);
          color: #d9e2ff;
          padding: 8px;
        }

        option {
          color: #111827;
          background: #ffffff;
        }

        .wizardStepPanel {
          animation: wizardFadeSlide 260ms ease;
        }

        .runningOrb {
          width: 58px;
          height: 58px;
          border-radius: 999px;
          background: radial-gradient(circle at 35% 35%, #9fb4ff 0%, #6f86ff 45%, #4f63de 100%);
          box-shadow: 0 10px 28px rgba(99, 122, 255, 0.55);
          animation: pulseOrb 1.6s ease-in-out infinite;
          z-index: 2;
          margin-bottom: 12px;
        }

        .runningRing {
          position: absolute;
          top: 58px;
          left: 50%;
          width: 126px;
          height: 126px;
          border-radius: 999px;
          border: 2px solid rgba(133, 157, 255, 0.45);
          border-top-color: rgba(255, 255, 255, 0.95);
          transform: translateX(-50%);
          animation: spinRing 1.2s linear infinite;
          pointer-events: none;
        }

        .globalLoaderSpinner {
          width: 44px;
          height: 44px;
          border-radius: 999px;
          border: 3px solid rgba(190, 205, 255, 0.38);
          border-top-color: rgba(255, 255, 255, 0.98);
          animation: spinRing 0.9s linear infinite;
          margin-bottom: 8px;
        }

        @keyframes wizardFadeSlide {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes spinRing {
          from {
            transform: translateX(-50%) rotate(0deg);
          }
          to {
            transform: translateX(-50%) rotate(360deg);
          }
        }

        @keyframes pulseOrb {
          0%,
          100% {
            transform: scale(1);
            opacity: 0.95;
          }
          50% {
            transform: scale(1.08);
            opacity: 1;
          }
        }
      `}</style>
    </main>
  );
}

function AlignmentReview({
  originalUrl,
  alignedUrl,
  onContinue,
  onUploadAlignedMask,
  onRefresh,
}: {
  originalUrl: string;
  alignedUrl: string;
  onContinue: (adjustedMaskBlob: Blob) => Promise<void>;
  onUploadAlignedMask: (e: any) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [origDims, setOrigDims] = useState<{w:number; h:number} | null>(null);
  const [maskDims, setMaskDims] = useState<{w:number; h:number} | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [scale, setScale] = useState(1);
  const [viewZoom, setViewZoom] = useState(1);
  const [boxScaleX, setBoxScaleX] = useState(1);
  const [boxScaleY, setBoxScaleY] = useState(1);
  const [opacity, setOpacity] = useState(55);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{
    sx: number;
    sy: number;
    dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
    cx: number;
    cy: number;
    bw: number;
    bh: number;
  } | null>(null);

  const displayedMaskWidth = maskDims ? Math.max(16, maskDims.w * scale * boxScaleX) : 0;
  const displayedMaskHeight = maskDims ? Math.max(16, maskDims.h * scale * boxScaleY) : 0;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (resizeRef.current && maskDims) {
        const dx = (e.clientX - resizeRef.current.sx) / Math.max(0.1, viewZoom);
        const dy = (e.clientY - resizeRef.current.sy) / Math.max(0.1, viewZoom);

        const startLeft = resizeRef.current.cx - resizeRef.current.bw / 2;
        const startRight = resizeRef.current.cx + resizeRef.current.bw / 2;
        const startTop = resizeRef.current.cy - resizeRef.current.bh / 2;
        const startBottom = resizeRef.current.cy + resizeRef.current.bh / 2;

        let left = startLeft;
        let right = startRight;
        let top = startTop;
        let bottom = startBottom;

        const dir = resizeRef.current.dir;
        if (dir.includes("e")) right = startRight + dx;
        if (dir.includes("w")) left = startLeft + dx;
        if (dir.includes("s")) bottom = startBottom + dy;
        if (dir.includes("n")) top = startTop + dy;

        const minW = 20;
        const minH = 20;
        if (right - left < minW) {
          if (dir.includes("w")) left = right - minW;
          else right = left + minW;
        }
        if (bottom - top < minH) {
          if (dir.includes("n")) top = bottom - minH;
          else bottom = top + minH;
        }

        const nextWidth = right - left;
        const nextHeight = bottom - top;
        const nextCx = (left + right) / 2;
        const nextCy = (top + bottom) / 2;
        const baseWidth = Math.max(1, maskDims.w * scale);
        const baseHeight = Math.max(1, maskDims.h * scale);

        setOffsetX(nextCx);
        setOffsetY(nextCy);
        setBoxScaleX(nextWidth / baseWidth);
        setBoxScaleY(nextHeight / baseHeight);
        return;
      }
      if (!dragRef.current) return;
      const dx = (e.clientX - dragRef.current.sx) / Math.max(0.1, viewZoom);
      const dy = (e.clientY - dragRef.current.sy) / Math.max(0.1, viewZoom);
      setOffsetX(dragRef.current.ox + dx);
      setOffsetY(dragRef.current.oy + dy);
    };

    const onUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
      setIsDragging(false);
      setIsResizing(false);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [maskDims, scale, viewZoom]);

  function startResize(
    e: React.MouseEvent<HTMLDivElement>,
    dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"
  ) {
    e.stopPropagation();
    resizeRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      dir,
      cx: offsetX,
      cy: offsetY,
      bw: displayedMaskWidth,
      bh: displayedMaskHeight,
    };
    setIsResizing(true);
  }

  async function continueWithAdjustedMask() {
    if (!origDims || !maskDims) return;
    setIsContinuing(true);
    try {
      const exportMaskWidth = Math.max(16, maskDims.w * boxScaleX);
      const exportMaskHeight = Math.max(16, maskDims.h * boxScaleY);

      const canvas = document.createElement("canvas");
      canvas.width = origDims.w;
      canvas.height = origDims.h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, origDims.w, origDims.h);

      const maskResp = await fetch(alignedUrl, { cache: "no-store" });
      if (!maskResp.ok) throw new Error(`Failed to fetch aligned mask (${maskResp.status})`);
      const maskBlob = await maskResp.blob();
      const maskBitmap = await createImageBitmap(maskBlob);

      ctx.save();
      ctx.translate(origDims.w / 2 + offsetX, origDims.h / 2 + offsetY);
      ctx.scale(scale, scale);
      ctx.drawImage(maskBitmap, -exportMaskWidth / 2, -exportMaskHeight / 2, exportMaskWidth, exportMaskHeight);
      ctx.restore();
      maskBitmap.close();

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) return;
      await onContinue(blob);
    } finally {
      setIsContinuing(false);
    }
  }

  return (
    <div style={{ position:"absolute", inset: 0, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.14)",
          background: "rgba(9, 14, 27, 0.78)",
          padding: "10px 12px",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, color: "#dbe4ff" }}>Opacity</span>
        <input
          type="range"
          min={0}
          max={100}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          style={{ width: 120 }}
        />
        <span style={{ fontSize: 12, color: "#dbe4ff" }}>{opacity}%</span>

        <span style={{ fontSize: 12, color: "#dbe4ff", marginLeft: 12 }}>Scale</span>
        <input
          type="range"
          min={50}
          max={200}
          value={Math.round(scale * 100)}
          onChange={(e) => setScale(Number(e.target.value) / 100)}
          style={{ width: 120 }}
        />
        <span style={{ fontSize: 12, color: "#dbe4ff" }}>{Math.round(scale * 100)}%</span>

        <span style={{ fontSize: 12, color: "#dbe4ff", marginLeft: 12 }}>View</span>
        <button onClick={() => setViewZoom((v) => Math.max(0.25, v - 0.1))} style={zoomBtn}>−</button>
        <input
          type="range"
          min={25}
          max={300}
          value={Math.round(viewZoom * 100)}
          onChange={(e) => setViewZoom(Number(e.target.value) / 100)}
          style={{ width: 120 }}
        />
        <button onClick={() => setViewZoom((v) => Math.min(3, v + 0.1))} style={zoomBtn}>+</button>
        <span style={{ fontSize: 12, color: "#dbe4ff" }}>{Math.round(viewZoom * 100)}%</span>

        <button onClick={() => { setOffsetX(0); setOffsetY(0); setScale(1); setViewZoom(1); setBoxScaleX(1); setBoxScaleY(1); }} style={toolBtn(false)}>Reset</button>
        <label style={{ fontSize: 12, color: "#dbe4ff", marginLeft: 6 }}>Replace mask</label>
        <input
          type="file"
          accept=".png,.jpg,.jpeg,.webp"
          onChange={onUploadAlignedMask}
          style={{ width: 220 }}
        />
        <button onClick={onRefresh} style={toolBtn(false)}>Refresh</button>
        <button onClick={continueWithAdjustedMask} style={toolBtn(true)} disabled={isContinuing}>
          {isContinuing ? "Continuing..." : "Continue Pipeline"}
        </button>
      </div>

      <div
        style={{
          position:"relative",
          flex: 1,
          overflow: "auto",
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.14)",
          background: "rgba(4, 8, 18, 0.48)",
          padding: 10,
        }}
      >
        {origDims ? (
          <div style={{ position: "relative", width: origDims.w * viewZoom, height: origDims.h * viewZoom }}>
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: origDims.w,
                height: origDims.h,
                transform: `scale(${viewZoom})`,
                transformOrigin: "top left",
              }}
            >
            <img
              src={originalUrl}
              alt="Original render"
              onLoad={(e) => {
                const img = e.currentTarget;
                setOrigDims({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              style={{ position:"absolute", inset:0, width: origDims.w, height: origDims.h, display:"block" }}
            />

            <div
              onMouseDown={(e) => {
                dragRef.current = { sx: e.clientX, sy: e.clientY, ox: offsetX, oy: offsetY };
                setIsDragging(true);
              }}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: `translate(-50%, -50%) translate(${offsetX}px, ${offsetY}px)`,
                width: displayedMaskWidth,
                height: displayedMaskHeight,
                cursor: isDragging ? "grabbing" : "grab",
                userSelect: "none",
                pointerEvents: "auto",
              }}
            >
              <img
                src={alignedUrl}
                alt="Aligned mask overlay"
                onLoad={(e) => {
                  const img = e.currentTarget;
                  setMaskDims({ w: img.naturalWidth, h: img.naturalHeight });
                }}
                draggable={false}
                style={{
                  width: "100%",
                  height: "100%",
                  opacity: opacity / 100,
                  display: "block",
                  pointerEvents: "none",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  border: "2px dashed rgba(143, 210, 255, 0.8)",
                  pointerEvents: "none",
                  borderRadius: 4,
                }}
              />
              <div
                onMouseDown={(e) => startResize(e, "se")}
                style={{
                  position: "absolute",
                  right: -7,
                  bottom: -7,
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  border: "1px solid rgba(255,255,255,0.9)",
                  background: isResizing ? "#8fd2ff" : "#5bb9ff",
                  cursor: "nwse-resize",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
                }}
                title="Resize mask box"
              />

              <div
                onMouseDown={(e) => startResize(e, "n")}
                style={{ position: "absolute", left: "50%", top: -6, transform: "translateX(-50%)", width: 12, height: 12, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#5bb9ff", cursor: "ns-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize top"
              />
              <div
                onMouseDown={(e) => startResize(e, "s")}
                style={{ position: "absolute", left: "50%", bottom: -6, transform: "translateX(-50%)", width: 12, height: 12, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#5bb9ff", cursor: "ns-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize bottom"
              />
              <div
                onMouseDown={(e) => startResize(e, "e")}
                style={{ position: "absolute", right: -6, top: "50%", transform: "translateY(-50%)", width: 12, height: 12, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#5bb9ff", cursor: "ew-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize right"
              />
              <div
                onMouseDown={(e) => startResize(e, "w")}
                style={{ position: "absolute", left: -6, top: "50%", transform: "translateY(-50%)", width: 12, height: 12, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#5bb9ff", cursor: "ew-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize left"
              />
              <div
                onMouseDown={(e) => startResize(e, "nw")}
                style={{ position: "absolute", left: -7, top: -7, width: 14, height: 14, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#5bb9ff", cursor: "nwse-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize top-left"
              />
              <div
                onMouseDown={(e) => startResize(e, "ne")}
                style={{ position: "absolute", right: -7, top: -7, width: 14, height: 14, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#5bb9ff", cursor: "nesw-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize top-right"
              />
              <div
                onMouseDown={(e) => startResize(e, "sw")}
                style={{ position: "absolute", left: -7, bottom: -7, width: 14, height: 14, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#5bb9ff", cursor: "nesw-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize bottom-left"
              />
            </div>
            </div>
          </div>
        ) : (
          <img
            src={originalUrl}
            alt="Original render"
            onLoad={(e) => {
              const img = e.currentTarget;
              setOrigDims({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            style={{ maxWidth: "100%", display: "block" }}
          />
        )}
      </div>
    </div>
  );
}

function btn(primary=false, compact=false): CSSProperties {
  return {
    padding: compact ? "8px 12px" : "10px 12px",
    borderRadius: 12,
    border: primary ? "1px solid rgba(127, 148, 255, 0.75)" : "1px solid rgba(255,255,255,0.2)",
    background: primary
      ? "linear-gradient(180deg, #697bff 0%, #5668f1 100%)"
      : "rgba(14, 19, 36, 0.86)",
    color: "#f4f7ff",
    cursor:"pointer",
    flex: 1,
    textAlign:"center",
    boxShadow: primary ? "0 10px 24px rgba(93, 109, 241, 0.42)" : undefined,
  };
}

const styles: Record<string, CSSProperties> = {
  workspace: {
    minHeight: "100vh",
    display: "grid",
    gridTemplateColumns: "380px 1fr",
    gap: "14px",
    padding: "14px",
    background:
      "radial-gradient(circle at 8% 18%, rgba(89, 110, 255, 0.22) 0%, transparent 35%), radial-gradient(circle at 82% 86%, rgba(33, 190, 170, 0.16) 0%, transparent 34%), linear-gradient(130deg, #090d17 0%, #0f1628 45%, #141c31 100%)",
    position: "relative",
    overflow: "hidden"
  },
  bgGlowTop: {
    position: "absolute",
    top: "-170px",
    right: "-140px",
    width: "420px",
    height: "420px",
    borderRadius: "999px",
    background: "rgba(112, 126, 255, 0.24)",
    filter: "blur(90px)",
    pointerEvents: "none"
  },
  bgGlowBottom: {
    position: "absolute",
    bottom: "-190px",
    left: "-140px",
    width: "460px",
    height: "460px",
    borderRadius: "999px",
    background: "rgba(68, 224, 199, 0.18)",
    filter: "blur(96px)",
    pointerEvents: "none"
  },
  sidebar: {
    zIndex: 1,
    borderRadius: "20px",
    border: "1px solid rgba(255,255,255,0.18)",
    background: "linear-gradient(160deg, rgba(255,255,255,0.13), rgba(255,255,255,0.05))",
    backdropFilter: "blur(10px)",
    boxShadow: "0 20px 56px rgba(0,0,0,0.34)",
    padding: "14px",
    overflow: "auto"
  },
  sidebarTopRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "8px"
  },
  sidebarLabel: {
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "rgba(244, 247, 255, 0.66)",
    marginBottom: "4px"
  },
  projectTitle: {
    display: "block",
    fontSize: "18px",
    lineHeight: 1.25
  },
  statusRow: {
    marginTop: "10px",
    fontSize: "12px",
    color: "rgba(244, 247, 255, 0.78)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px",
    borderRadius: "10px",
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.12)"
  },
  statusValue: {
    fontWeight: 600,
    color: "#dbe4ff"
  },
  errorBox: {
    marginTop: "10px",
    whiteSpace: "pre-wrap",
    background: "rgba(255, 102, 102, 0.12)",
    border: "1px solid rgba(255, 136, 136, 0.35)",
    color: "#ffd7d7",
    padding: "10px",
    borderRadius: "12px",
    fontSize: "12px"
  },
  uploadSection: {
    marginTop: "14px"
  },
  sectionTitle: {
    margin: "8px 0",
    fontSize: "14px",
    fontWeight: 600,
    color: "#f4f7ff"
  },
  divider: {
    margin: "16px 0",
    border: 0,
    borderTop: "1px solid rgba(255,255,255,0.16)"
  },
  fieldLabel: {
    display: "block",
    fontSize: "12px",
    color: "rgba(244, 247, 255, 0.76)",
    marginBottom: "6px"
  },
  helpText: {
    fontSize: "12px",
    color: "rgba(244, 247, 255, 0.76)",
    lineHeight: 1.45
  },
  canvasPanel: {
    position: "relative",
    zIndex: 1,
    borderRadius: "20px",
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(10, 14, 26, 0.7)",
    backdropFilter: "blur(8px)",
    boxShadow: "0 20px 56px rgba(0,0,0,0.34)",
    overflow: "hidden",
    minHeight: 0
  },
  questionnaireCenterWrap: {
    zIndex: 1,
    minHeight: "calc(100vh - 28px)",
    display: "grid",
    placeItems: "center",
    padding: "14px"
  },
  questionnaireCard: {
    width: "min(680px, 100%)",
    borderRadius: "20px",
    border: "1px solid rgba(255,255,255,0.18)",
    background: "linear-gradient(160deg, rgba(255,255,255,0.13), rgba(255,255,255,0.05))",
    backdropFilter: "blur(10px)",
    boxShadow: "0 20px 56px rgba(0,0,0,0.34)",
    padding: "18px"
  },
  runningCard: {
    width: "min(620px, 100%)",
    borderRadius: "22px",
    border: "1px solid rgba(255,255,255,0.2)",
    background: "linear-gradient(160deg, rgba(255,255,255,0.14), rgba(255,255,255,0.06))",
    backdropFilter: "blur(12px)",
    boxShadow: "0 26px 64px rgba(0,0,0,0.36)",
    padding: "30px 22px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    position: "relative",
    overflow: "hidden"
  },
  globalLoaderOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 30,
    background: "rgba(6, 10, 20, 0.45)",
    backdropFilter: "blur(6px)",
    display: "grid",
    placeItems: "center",
    pointerEvents: "all"
  },
  globalLoaderCard: {
    width: "min(320px, calc(100% - 32px))",
    borderRadius: "16px",
    border: "1px solid rgba(255,255,255,0.2)",
    background: "linear-gradient(160deg, rgba(255,255,255,0.13), rgba(255,255,255,0.06))",
    boxShadow: "0 20px 50px rgba(0,0,0,0.32)",
    padding: "16px 18px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4
  },
  emptyState: {
    height: "100%",
    display: "grid",
    placeItems: "center",
    textAlign: "center",
    color: "rgba(244, 247, 255, 0.8)",
    padding: "24px"
  },
  emptyTitle: {
    margin: 0,
    marginBottom: "6px",
    fontSize: "24px"
  },
  emptySubtitle: {
    margin: 0,
    maxWidth: "520px",
    lineHeight: 1.5,
    color: "rgba(244, 247, 255, 0.72)"
  }
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={styles.fieldLabel}>{label}</div>
      <div style={{ display:"block" }}>{children}</div>
    </div>
  );
}

async function uploadFile(projectId: string, e: any, refresh: ()=>void) {
  const f: File | undefined = e.target.files?.[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  await authFetch(`/api/projects/${projectId}/upload`, { method:"POST", body: fd });
  await refresh();
}

function Editor({
  renderUrl, mapping, detectors, projectId, isReady, exportDxfUrl, exportPngUrl, onSave, onChanged
}: {
  renderUrl: string;
  mapping: Mapping;
  detectors: Detector[];
  projectId: string;
  isReady: boolean;
  exportDxfUrl: string | null;
  exportPngUrl: string | null;
  onSave: ()=>void;
  onChanged: ()=>void;
}) {
  const [imgDims, setImgDims] = useState<{w:number;h:number}|null>(null);
  const [tool, setTool] = useState<"select"|"add"|"erase"|"pan">("select");
  const [addType, setAddType] = useState<ObjectType>("smoke");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{sx:number; sy:number; ex:number; ey:number} | null>(null);
  const [groupDrag, setGroupDrag] = useState<{
    ids: string[];
    start: { px: number; py: number };
    origins: Record<string, { px: number; py: number }>;
  } | null>(null);
  const [groupPreview, setGroupPreview] = useState<Record<string, { px: number; py: number }> | null>(null);
  const [hoverPoint, setHoverPoint] = useState<{px:number; py:number} | null>(null);
  const [transformState, setTransformState] = useState({ scale: 0.18, positionX: 0, positionY: 0 });
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState<null | "dxf" | "png">(null);

  function onImageLoad(e: any) {
    const img = e.target as HTMLImageElement;
    setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
  }

  async function addDetectorAt(px: number, py: number) {
    const w = pixelToWorld(mapping, px, py);
    await authFetch(`/api/projects/${projectId}/detectors`, {
      method:"POST",
      body: JSON.stringify({ x: w.x, y: w.y, z: 0, dtype:addType })
    });
    onChanged();
  }
  async function saveEdits() {
    setIsSaving(true);
    try {
      await onSave();
    } finally {
      setIsSaving(false);
    }
  }

  async function downloadFresh(url: string, filename: string) {
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetch(`${url}${sep}ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async function exportLatest(kind: "dxf" | "png") {
    setIsExporting(kind);
    try {
      if (kind === "png") {
        if (!imgDims) return;
        await exportPngFromCanvas();
        return;
      }

      const url = exportDxfUrl;
      if (!url) return;
      await saveEdits();
      await downloadFresh(url, `project_${projectId}_${Date.now()}.dxf`);
    } finally {
      setIsExporting(null);
    }
  }

  async function exportPngFromCanvas() {
    if (!imgDims) return;

    const canvas = document.createElement("canvas");
    canvas.width = imgDims.w;
    canvas.height = imgDims.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const sep = renderUrl.includes("?") ? "&" : "?";
    const baseRes = await fetch(`${renderUrl}${sep}ts=${Date.now()}`, { cache: "no-store" });
    if (!baseRes.ok) throw new Error(`Base image fetch failed (${baseRes.status})`);
    const baseBlob = await baseRes.blob();
    const baseBitmap = await createImageBitmap(baseBlob);

    ctx.drawImage(baseBitmap, 0, 0, imgDims.w, imgDims.h);
    baseBitmap.close();

    for (const d of detectors) {
      const p = worldToPixel(mapping, d.x, d.y);
      drawPlacedObjectOnCanvas(ctx, d.dtype, p.px, p.py);
      ctx.beginPath();
      ctx.arc(p.px, p.py, 11, 0, Math.PI * 2);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG generation failed");

    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `project_${projectId}_${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }


  async function patchDetectorTo(detId: string, px: number, py: number) {
    const w = pixelToWorld(mapping, px, py);
    await authFetch(`/api/detectors/${detId}`, {
      method:"PATCH",
      body: JSON.stringify({ x: w.x, y: w.y, z: 0 })
    });
  }

  async function moveDetectorTo(detId: string, px: number, py: number) {
    await patchDetectorTo(detId, px, py);
    onChanged();
  }

  async function moveDetectorsToMany(nextPxById: Record<string, {px:number; py:number}>) {
    const entries = Object.entries(nextPxById);
    if (!entries.length) return;
    await Promise.all(entries.map(([detId, pt]) => patchDetectorTo(detId, pt.px, pt.py)));
    onChanged();
  }

  async function deleteDetector(detId: string) {
    await authFetch(`/api/detectors/${detId}`, { method:"DELETE" });
    onChanged();
  }

  function toImagePoint(e: any): { px: number; py: number } | null {
    if (!imgDims) return null;
    const rect = (e.currentTarget as any).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * imgDims.w;
    const py = ((e.clientY - rect.top) / rect.height) * imgDims.h;
    return { px, py };
  }

  function canvasCursor() {
    if (tool === "pan") return "grab";
    if (tool === "add") return "crosshair";
    if (tool === "erase") return "not-allowed";
    if (groupDrag) return "grabbing";
    return "default";
  }

  function rectFromPoints(a: {px:number; py:number}, b: {px:number; py:number}) {
    const left = Math.min(a.px, b.px);
    const right = Math.max(a.px, b.px);
    const top = Math.min(a.py, b.py);
    const bottom = Math.max(a.py, b.py);
    return { left, right, top, bottom };
  }

  function idsInRect(rect: {left:number; right:number; top:number; bottom:number}) {
    const ids: string[] = [];
    for (const d of detectors) {
      const p = worldToPixel(mapping, d.x, d.y);
      if (p.px >= rect.left && p.px <= rect.right && p.py >= rect.top && p.py <= rect.bottom) {
        ids.push(d.id);
      }
    }
    return ids;
  }

  function beginGroupDrag(ids: string[], at: {px:number; py:number}) {
    if (!ids.length) return;
    const origins: Record<string, { px: number; py: number }> = {};
    for (const d of detectors) {
      if (!ids.includes(d.id)) continue;
      origins[d.id] = worldToPixel(mapping, d.x, d.y);
    }
    setGroupDrag({ ids, start: at, origins });
    setGroupPreview(origins);
  }

  function hitTest(px: number, py: number): string | null {
    // 12px radius in image space
    const R2 = 12*12;
    for (const d of detectors) {
      const p = worldToPixel(mapping, d.x, d.y);
      const dx = p.px - px;
      const dy = p.py - py;
      if (dx*dx + dy*dy <= R2) return d.id;
    }
    return null;
  }

  return (
    <div style={{ position:"absolute", inset: 0, padding: "10px" }}>
      <TransformWrapper
        minScale={0.02}
        maxScale={24}
        initialScale={0.18}
        centerOnInit
        limitToBounds={false}
        panning={{ disabled: tool !== "pan" }}
        wheel={{ step: 0.08 }}
        doubleClick={{ disabled: true }}
        onTransformed={(_ref: unknown, state: any) => {
          setTransformState({
            scale: typeof state?.scale === "number" ? state.scale : 0.18,
            positionX: typeof state?.positionX === "number" ? state.positionX : 0,
            positionY: typeof state?.positionY === "number" ? state.positionY : 0
          });
        }}
      >
        {({ zoomIn, zoomOut, resetTransform, setTransform }) => (
          <>
            <div
              style={{
                position: "absolute",
                top: 20,
                left: 20,
                zIndex: 3,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(9, 14, 27, 0.78)",
                backdropFilter: "blur(8px)"
              }}
            >
              <button onClick={() => setTool("select")} style={toolBtn(tool === "select")}>Select</button>
              <button onClick={() => setTool("add")} style={toolBtn(tool === "add")}>Add</button>
              <button onClick={() => setTool("erase")} style={toolBtn(tool === "erase")}>Erase</button>
              <button onClick={() => setTool("pan")} style={toolBtn(tool === "pan")}>Pan</button>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 2 }}>
                {OBJECT_TYPES.map((otype) => {
                  const active = addType === otype;
                  return (
                    <button
                      key={otype}
                      onClick={() => {
                        setAddType(otype);
                        setTool("add");
                      }}
                      style={objectToolBtn(active)}
                      title={`Place ${objectLabel(otype)}`}
                    >
                      {renderObjectIcon(otype)}
                      <span style={{ fontSize: 11 }}>{objectLabel(otype)}</span>
                    </button>
                  );
                })}
              </div>
              <span style={{ fontSize: 12, color: "#dbe4ff", marginLeft: 2 }}>
                Selected: {selectedIds.length}
              </span>
              {selectedIds.length > 0 ? (
                <button onClick={() => setSelectedIds([])} style={toolBtn(false)}>Clear</button>
              ) : null}
              {isReady ? (
                <>
                  <button onClick={saveEdits} style={toolBtn(true)} disabled={isSaving}>
                    {isSaving ? "Saving..." : "Save"}
                  </button>
                  {exportDxfUrl ? (
                    <button
                      onClick={() => exportLatest("dxf")}
                      disabled={isSaving || isExporting !== null}
                      style={{ ...toolBtn(false), textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    >
                      {isExporting === "dxf" ? "Exporting DXF..." : "Export DXF"}
                    </button>
                  ) : null}
                  {exportPngUrl ? (
                    <button
                      onClick={() => exportLatest("png")}
                      disabled={isSaving || isExporting !== null}
                      style={{ ...toolBtn(false), textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    >
                      {isExporting === "png" ? "Exporting PNG..." : "Export PNG"}
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>

            <div
              style={{
                position: "absolute",
                top: 20,
                right: 20,
                zIndex: 3,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(9, 14, 27, 0.78)",
                backdropFilter: "blur(8px)"
              }}
            >
              <button onClick={() => zoomOut()} style={zoomBtn}>−</button>
              <input
                type="range"
                min={2}
                max={2400}
                value={Math.max(2, Math.min(2400, Math.round(transformState.scale * 100)))}
                onChange={(e) => {
                  const nextScale = Number(e.target.value) / 100;
                  setTransform(transformState.positionX, transformState.positionY, nextScale, 100);
                }}
                style={{ width: 140 }}
              />
              <button onClick={() => zoomIn()} style={zoomBtn}>+</button>
              <button onClick={() => resetTransform()} style={zoomBtn}>Fit</button>
              <span style={{ fontSize: 12, color: "#dbe4ff", minWidth: 44, textAlign: "right" }}>
                {Math.round(transformState.scale * 100)}%
              </span>
            </div>

            <TransformComponent
              wrapperStyle={{
                width:"100%",
                height:"100%",
                borderRadius: "14px",
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(4, 8, 18, 0.48)"
              }}
            >
              <div style={{ position:"relative", display:"inline-block" }}>
                <img src={renderUrl} onLoad={onImageLoad} style={{ display:"block", userSelect:"none", pointerEvents:"none", borderRadius: "8px" }} />

                {imgDims ? (
                  <svg
                    width={imgDims.w}
                    height={imgDims.h}
                    viewBox={`0 0 ${imgDims.w} ${imgDims.h}`}
                    style={{ position:"absolute", left:0, top:0, cursor: canvasCursor() }}
                    onMouseDown={(e)=> {
                      const point = toImagePoint(e);
                      if (!point) return;
                      const { px, py } = point;
                      const id = hitTest(px, py);
                      if (tool === "select") {
                        if (id) {
                          if (selectedIds.includes(id)) {
                            beginGroupDrag(selectedIds, point);
                          } else {
                            setSelectedIds([id]);
                            beginGroupDrag([id], point);
                          }
                        } else {
                          setMarquee({ sx: px, sy: py, ex: px, ey: py });
                        }
                        return;
                      }
                      if (tool === "add") {
                        addDetectorAt(px, py);
                        return;
                      }
                      if (tool === "erase" && id) {
                        deleteDetector(id);
                      }
                    }}
                    onMouseMove={(e)=> {
                      const point = toImagePoint(e);
                      if (!point) return;
                      setHoverPoint(point);
                      if (tool !== "select") return;
                      if (marquee) {
                        setMarquee({ ...marquee, ex: point.px, ey: point.py });
                        return;
                      }
                      if (!groupDrag) return;
                      const dx = point.px - groupDrag.start.px;
                      const dy = point.py - groupDrag.start.py;
                      const next: Record<string, { px: number; py: number }> = {};
                      for (const detId of groupDrag.ids) {
                        const base = groupDrag.origins[detId];
                        if (!base) continue;
                        next[detId] = { px: base.px + dx, py: base.py + dy };
                      }
                      setGroupPreview(next);
                    }}
                    onMouseUp={(e)=> {
                      if (tool !== "select") return;
                      if (marquee) {
                        const p1 = { px: marquee.sx, py: marquee.sy };
                        const p2 = { px: marquee.ex, py: marquee.ey };
                        const rect = rectFromPoints(p1, p2);
                        setSelectedIds(idsInRect(rect));
                        setMarquee(null);
                        return;
                      }
                      if (!groupDrag || !groupPreview) return;
                      moveDetectorsToMany(groupPreview).finally(() => {
                        setGroupDrag(null);
                        setGroupPreview(null);
                      });
                    }}
                    onMouseLeave={()=> {
                      setHoverPoint(null);
                      if (marquee) setMarquee(null);
                      if (groupDrag) setGroupDrag(null);
                      if (groupPreview) setGroupPreview(null);
                    }}
                    onContextMenu={(e)=> {
                      e.preventDefault();
                      const point = toImagePoint(e);
                      if (!point) return;
                      const { px, py } = point;
                      const id = hitTest(px, py);
                      if (id) deleteDetector(id);
                    }}
                  >
                    {detectors.map((d)=> {
                      const p = groupPreview?.[d.id] || worldToPixel(mapping, d.x, d.y);
                      const isSelected = selectedIds.includes(d.id);
                      return (
                        <g key={d.id}>
                          {isSelected ? (
                            <>
                              <circle cx={p.px} cy={p.py} r={16} fill="rgba(255, 229, 143, 0.20)" />
                              <circle cx={p.px} cy={p.py} r={15} fill="none" stroke="#ffe58f" strokeWidth={3} strokeDasharray="6 4" />
                            </>
                          ) : null}
                          {renderPlacedObject(d.dtype, p.px, p.py)}
                          <circle cx={p.px} cy={p.py} r={11} fill="none" stroke={isSelected ? "#ffe58f" : "#ffffff"} strokeWidth={isSelected ? 3 : 2} />
                          {isSelected ? (
                            <circle cx={p.px} cy={p.py} r={3} fill="#fff7d1" />
                          ) : null}
                        </g>
                      );
                    })}
                    {marquee ? (() => {
                      const rect = rectFromPoints({ px: marquee.sx, py: marquee.sy }, { px: marquee.ex, py: marquee.ey });
                      return (
                        <rect
                          x={rect.left}
                          y={rect.top}
                          width={Math.max(1, rect.right - rect.left)}
                          height={Math.max(1, rect.bottom - rect.top)}
                          fill="rgba(143, 210, 255, 0.15)"
                          stroke="#8fd2ff"
                          strokeWidth={2}
                          strokeDasharray="6 4"
                        />
                      );
                    })() : null}
                    {tool === "add" && hoverPoint ? (
                      <g>
                        <circle cx={hoverPoint.px} cy={hoverPoint.py} r={13} fill="none" stroke="#8fd2ff" strokeWidth={2} strokeDasharray="5 4" />
                        <line x1={hoverPoint.px - 9} y1={hoverPoint.py} x2={hoverPoint.px + 9} y2={hoverPoint.py} stroke="#8fd2ff" strokeWidth={2} />
                        <line x1={hoverPoint.px} y1={hoverPoint.py - 9} x2={hoverPoint.px} y2={hoverPoint.py + 9} stroke="#8fd2ff" strokeWidth={2} />
                      </g>
                    ) : null}
                  </svg>
                ) : null}
              </div>
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}

const zoomBtn: CSSProperties = {
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.2)",
  background: "rgba(18, 24, 44, 0.9)",
  color: "#f4f7ff",
  height: 30,
  minWidth: 34,
  padding: "0 10px",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600
};

function toolBtn(active: boolean): CSSProperties {
  return {
    borderRadius: 10,
    border: active ? "1px solid rgba(127, 148, 255, 0.82)" : "1px solid rgba(255,255,255,0.2)",
    background: active ? "linear-gradient(180deg, #697bff 0%, #5668f1 100%)" : "rgba(18, 24, 44, 0.9)",
    color: "#f4f7ff",
    height: 30,
    minWidth: 56,
    padding: "0 10px",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600
  };
}

function objectFill(dtype: string): string {
  const key = (dtype || "").toLowerCase();
  if (key === "panel") return "#ffd166";
  if (key === "hooter") return "#c77dff";
  if (key === "mcb") return "#4ecdc4";
  return "#ff5a7e";
}

function renderPlacedObject(dtype: string, cx: number, cy: number) {
  const key = (dtype || "").toLowerCase();

  if (key === "panel") {
    return (
      <>
        <rect x={cx - 9} y={cy - 9} width={18} height={18} rx={3} fill="#ffd166" opacity={0.96} />
        <rect x={cx - 5.5} y={cy - 5.5} width={11} height={11} rx={2} fill="#e8b347" />
        <circle cx={cx} cy={cy} r={2} fill="#7a5300" />
      </>
    );
  }

  if (key === "hooter") {
    return (
      <>
        <polygon points={`${cx - 7},${cy + 1} ${cx - 1},${cy - 3} ${cx - 1},${cy + 5}`} fill="#c77dff" opacity={0.96} />
        <path d={`M ${cx + 1} ${cy - 2} Q ${cx + 6} ${cy} ${cx + 1} ${cy + 2}`} stroke="#f3e7ff" strokeWidth={1.6} fill="none" />
        <path d={`M ${cx + 3} ${cy - 4} Q ${cx + 10} ${cy} ${cx + 3} ${cy + 4}`} stroke="#f3e7ff" strokeWidth={1.6} fill="none" />
      </>
    );
  }

  if (key === "mcb") {
    return (
      <>
        <rect x={cx - 8} y={cy - 9} width={16} height={18} rx={2.5} fill="#4ecdc4" opacity={0.96} />
        <rect x={cx - 3.5} y={cy - 5.5} width={7} height={11} rx={1.4} fill="#0f4f4a" />
        <circle cx={cx} cy={cy + 3.5} r={1.2} fill="#9ff3eb" />
      </>
    );
  }

  return <circle cx={cx} cy={cy} r={9} fill="#ff5a7e" opacity={0.96} />;
}

function drawPlacedObjectOnCanvas(ctx: CanvasRenderingContext2D, dtype: string, cx: number, cy: number) {
  const key = (dtype || "").toLowerCase();

  if (key === "panel") {
    ctx.fillStyle = "#ffd166";
    ctx.fillRect(cx - 9, cy - 9, 18, 18);
    ctx.fillStyle = "#e8b347";
    ctx.fillRect(cx - 5.5, cy - 5.5, 11, 11);
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = "#7a5300";
    ctx.fill();
    return;
  }

  if (key === "hooter") {
    ctx.beginPath();
    ctx.moveTo(cx - 7, cy + 1);
    ctx.lineTo(cx - 1, cy - 3);
    ctx.lineTo(cx - 1, cy + 5);
    ctx.closePath();
    ctx.fillStyle = "#c77dff";
    ctx.fill();

    ctx.strokeStyle = "#f3e7ff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.quadraticCurveTo(cx + 6, cy, cx + 1, cy + 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 3, cy - 4);
    ctx.quadraticCurveTo(cx + 10, cy, cx + 3, cy + 4);
    ctx.stroke();
    return;
  }

  if (key === "mcb") {
    ctx.fillStyle = "#4ecdc4";
    ctx.fillRect(cx - 8, cy - 9, 16, 18);
    ctx.fillStyle = "#0f4f4a";
    ctx.fillRect(cx - 3.5, cy - 5.5, 7, 11);
    ctx.beginPath();
    ctx.arc(cx, cy + 3.5, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = "#9ff3eb";
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.fillStyle = "#ff5a7e";
  ctx.fill();
}

function objectLabel(dtype: ObjectType): string {
  if (dtype === "mcb") return "MCB";
  return dtype.charAt(0).toUpperCase() + dtype.slice(1);
}

function objectToolBtn(active: boolean): CSSProperties {
  return {
    borderRadius: 10,
    border: active ? "1px solid rgba(127, 148, 255, 0.82)" : "1px solid rgba(255,255,255,0.2)",
    background: active ? "linear-gradient(180deg, #697bff 0%, #5668f1 100%)" : "rgba(18, 24, 44, 0.9)",
    color: "#f4f7ff",
    height: 30,
    minWidth: 74,
    padding: "0 8px",
    cursor: "pointer",
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  };
}

function renderObjectIcon(dtype: ObjectType) {
  if (dtype === "panel") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <rect x="2" y="2" width="10" height="10" rx="2" fill="#ffd166" stroke="#fff" strokeWidth="1" />
        <circle cx="7" cy="7" r="1.3" fill="#7a5300" />
      </svg>
    );
  }
  if (dtype === "hooter") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <polygon points="3,8 6,6 6,10" fill="#c77dff" stroke="#fff" strokeWidth="0.8" />
        <path d="M8 6.2 Q10 7 8 7.8" stroke="#fff" strokeWidth="1" fill="none" />
        <path d="M9.2 5.4 Q12 7 9.2 8.6" stroke="#fff" strokeWidth="1" fill="none" />
      </svg>
    );
  }
  if (dtype === "mcb") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <rect x="2" y="2" width="10" height="10" rx="1.8" fill="#4ecdc4" stroke="#fff" strokeWidth="1" />
        <rect x="5.4" y="4" width="3.2" height="6" rx="0.8" fill="#0f4f4a" />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="4.2" fill="#ff5a7e" stroke="#fff" strokeWidth="1" />
    </svg>
  );
}
