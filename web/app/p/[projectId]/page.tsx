"use client";

import { use, useEffect, useMemo, useState } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";

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
  world_bbox: { xmin:number; xmax:number; ymin:number; ymax:number };
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
  return { x: xmin + u*(xmax-xmin), y: ymax - v*(ymax-ymin) };
}

export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [detectors, setDetectors] = useState<Detector[]>([]);
  const [mapping, setMapping] = useState<Mapping | null>(null);

  const [settings, setSettings] = useState<any>({
    detector_spacing_m: 5.0,
    wall_buffer_m: 0.5,
    target_long_side_px: 12000,
    gemini_model: "gemini-2.5-flash-image",
    building_type: "residential",
    has_false_ceiling: false,
    units: "mm",

  });

  async function refresh() {
    const p: Project = await (await fetch(`${API}/api/projects/${projectId}`)).json();
    setProject(p);

    const d: Detector[] = await (await fetch(`${API}/api/projects/${projectId}/detectors`)).json();
    setDetectors(d);

    if (p.files?.mapping_json) {
      const mj: Mapping = await (await fetch(`${API}${p.files.mapping_json}`)).json();
      setMapping(mj);
    } else {
      setMapping(null);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function saveSettings() {
    await fetch(`${API}/api/projects/${projectId}/settings`, {
      method:"POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ settings })
    });
    await refresh();
  }

  async function runPipeline() {
    await saveSettings();
    await fetch(`${API}/api/projects/${projectId}/run`, { method:"POST" });
    await refresh();
  }

  return (
    <div style={{ height: "100vh", display:"flex" }}>
      <div style={{ width: 360, borderRight:"1px solid #eee", padding: 12, overflow:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <strong>{project?.name || "Loading..."}</strong>
          <button onClick={refresh} style={{ padding:"6px 10px", borderRadius: 10, border:"1px solid #ddd" }}>Refresh</button>
        </div>

        <div style={{ marginTop: 8, fontSize: 13, opacity: 0.85 }}>
          Status: <b>{project?.status || "-"}</b>
        </div>

        {project?.error ? (
          <pre style={{ marginTop: 8, whiteSpace:"pre-wrap", background:"#fff7f7", border:"1px solid #ffd0d0", padding: 8, borderRadius: 10, fontSize: 12 }}>
{project.error}
          </pre>
        ) : null}

        <div style={{ marginTop: 14 }}>
          <label style={{ display:"block", fontSize: 12, opacity: 0.75 }}>Upload DWG/DXF</label>
          <input type="file" accept=".dxf,.dwg" onChange={(e)=>uploadFile(projectId, e, refresh)} />
        </div>

        <hr style={{ margin:"16px 0" }} />

        <h4 style={{ margin:"6px 0" }}>Project questions</h4>

        <Field label="Building type">
          <select value={settings.building_type} onChange={(e)=>setSettings({...settings, building_type: e.target.value})}>
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
            <option value="industrial">Industrial</option>
            <option value="hospital">Hospital</option>
            <option value="school">School</option>
          </select>
        </Field>

<Field label="Drawing units">
  <select value={settings.units} onChange={(e)=>setSettings({...settings, units: e.target.value})}>
    <option value="mm">mm</option>
    <option value="cm">cm</option>
    <option value="m">m</option>
    <option value="inch">inch</option>
    <option value="ft">ft</option>
  </select>
</Field>

        <Field label="Detector spacing (meters)">
          <input type="number" step="0.1" value={settings.detector_spacing_m}
            onChange={(e)=>setSettings({...settings, detector_spacing_m: Number(e.target.value)})}/>
        </Field>

        <Field label="Min distance from wall (meters)">
          <input type="number" step="0.1" value={settings.wall_buffer_m}
            onChange={(e)=>setSettings({...settings, wall_buffer_m: Number(e.target.value)})}/>
        </Field>

        <Field label="Render long side (px)">
          <input type="number" step="500" value={settings.target_long_side_px}
            onChange={(e)=>setSettings({...settings, target_long_side_px: Number(e.target.value)})}/>
        </Field>

        <Field label="Gemini image model">
          <input value={settings.gemini_model}
            onChange={(e)=>setSettings({...settings, gemini_model: e.target.value})}/>
          <div style={{ fontSize: 12, opacity:0.65, marginTop: 4 }}>
            Requires GEMINI_API_KEY on server
          </div>
        </Field>

        <div style={{ display:"flex", gap: 8, marginTop: 10 }}>
          <button onClick={saveSettings} style={btn()}>Save</button>
          <button onClick={runPipeline} style={btn(true)}>Run Auto-Placement</button>
        </div>

        <div style={{ marginTop: 12, display:"flex", gap: 8 }}>
          {project?.files?.output_dxf ? (
            <a href={`${API}${project.files.output_dxf}`} style={{ ...btn(true), textDecoration:"none", display:"inline-flex", alignItems:"center", justifyContent:"center" }}>
              Download output DXF
            </a>
          ) : null}
        </div>

        <hr style={{ margin:"16px 0" }} />
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          <b>Editing:</b> drag to move • double-click to add • right-click to delete
        </div>
      </div>

      <div style={{ flex: 1, position:"relative", background:"#fafafa" }}>
        {!project?.files?.render_png || !mapping ? (
          <div style={{ padding: 20, opacity: 0.75 }}>
            Upload a DXF/DWG, then run pipeline to render preview.
          </div>
        ) : (
          <Editor
            renderUrl={`${API}${project.files.render_png}`}
            mapping={mapping}
            detectors={detectors}
            projectId={projectId}
            onChanged={refresh}
          />
        )}
      </div>
    </div>
  );
}

function btn(primary=false): React.CSSProperties {
  return {
    padding:"10px 12px",
    borderRadius: 12,
    border: primary ? "1px solid #111" : "1px solid #ddd",
    background: primary ? "#111" : "#fff",
    color: primary ? "#fff" : "#111",
    cursor:"pointer",
    flex: 1,
    textAlign:"center",
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>{label}</div>
      <div style={{ display:"flex", gap: 8 }}>{children}</div>
    </div>
  );
}

async function uploadFile(projectId: string, e: any, refresh: ()=>void) {
  const f: File | undefined = e.target.files?.[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  await fetch(`${API}/api/projects/${projectId}/upload`, { method:"POST", body: fd });
  await refresh();
}

function Editor({
  renderUrl, mapping, detectors, projectId, onChanged
}: {
  renderUrl: string;
  mapping: Mapping;
  detectors: Detector[];
  projectId: string;
  onChanged: ()=>void;
}) {
  const [imgDims, setImgDims] = useState<{w:number;h:number}|null>(null);
  const [dragId, setDragId] = useState<string|null>(null);

  function onImageLoad(e: any) {
    const img = e.target as HTMLImageElement;
    setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
  }

  async function addDetectorAt(px: number, py: number) {
    const w = pixelToWorld(mapping, px, py);
    await fetch(`${API}/api/projects/${projectId}/detectors`, {
      method:"POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ x: w.x, y: w.y, z: 0, dtype:"smoke" })
    });
    onChanged();
  }

  async function moveDetectorTo(detId: string, px: number, py: number) {
    const w = pixelToWorld(mapping, px, py);
    await fetch(`${API}/api/detectors/${detId}`, {
      method:"PATCH",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ x: w.x, y: w.y, z: 0 })
    });
    onChanged();
  }

  async function deleteDetector(detId: string) {
    await fetch(`${API}/api/detectors/${detId}`, { method:"DELETE" });
    onChanged();
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
    <div style={{ position:"absolute", inset: 0 }}>
      <TransformWrapper wheel={{ step: 0.12 }} doubleClick={{ disabled: true }}>
        <TransformComponent wrapperStyle={{ width:"100%", height:"100%" }}>
          <div style={{ position:"relative", display:"inline-block" }}>
            <img src={renderUrl} onLoad={onImageLoad} style={{ display:"block", userSelect:"none", pointerEvents:"none" }} />

            {/* Overlay SVG uses image pixel coordinates */}
            {imgDims ? (
              <svg
                width={imgDims.w}
                height={imgDims.h}
                viewBox={`0 0 ${imgDims.w} ${imgDims.h}`}
                style={{ position:"absolute", left:0, top:0 }}
                onMouseDown={(e)=> {
                  const rect = (e.currentTarget as any).getBoundingClientRect();
                  const px = ((e.clientX - rect.left) / rect.width) * imgDims.w;
                  const py = ((e.clientY - rect.top) / rect.height) * imgDims.h;
                  const id = hitTest(px, py);
                  if (id) setDragId(id);
                }}
                onMouseMove={(e)=> {
                  if (!dragId) return;
                  // live preview could be added here; MVP keeps it simple
                }}
                onMouseUp={(e)=> {
                  if (!dragId) return;
                  const rect = (e.currentTarget as any).getBoundingClientRect();
                  const px = ((e.clientX - rect.left) / rect.width) * imgDims.w;
                  const py = ((e.clientY - rect.top) / rect.height) * imgDims.h;
                  moveDetectorTo(dragId, px, py).finally(()=>setDragId(null));
                }}
                onDoubleClick={(e)=> {
                  const rect = (e.currentTarget as any).getBoundingClientRect();
                  const px = ((e.clientX - rect.left) / rect.width) * imgDims.w;
                  const py = ((e.clientY - rect.top) / rect.height) * imgDims.h;
                  addDetectorAt(px, py);
                }}
                onContextMenu={(e)=> {
                  e.preventDefault();
                  const rect = (e.currentTarget as any).getBoundingClientRect();
                  const px = ((e.clientX - rect.left) / rect.width) * imgDims.w;
                  const py = ((e.clientY - rect.top) / rect.height) * imgDims.h;
                  const id = hitTest(px, py);
                  if (id) deleteDetector(id);
                }}
              >
                {detectors.map((d)=> {
                  const p = worldToPixel(mapping, d.x, d.y);
                  return (
                    <g key={d.id}>
                      <circle cx={p.px} cy={p.py} r={10} fill={d.dtype==="smoke" ? "#ff3b30" : "#0a84ff"} opacity={0.95} />
                      <circle cx={p.px} cy={p.py} r={10} fill="none" stroke="#ffffff" strokeWidth={2} />
                    </g>
                  );
                })}
              </svg>
            ) : null}
          </div>
        </TransformComponent>
      </TransformWrapper>
    </div>
  );
}
