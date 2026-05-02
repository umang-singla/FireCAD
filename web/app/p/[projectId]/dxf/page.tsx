"use client";

import { use, useEffect, useRef, useState } from "react";
import { getToken, getTenantRole } from "../../../lib/auth";

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

const FONTS = [
  "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-400-normal.ttf",
  "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-700-normal.ttf",
];

type LayerInfo = { name: string; displayName: string; color: number; visible: boolean };
type BlockInfo = { name: string; count: number; insertions: Array<{ x: number; y: number }> };
type FloorPlanInfo = {
  id: string;
  block_index: number;
  status: string;
  world_bbox: { xmin: number; ymin: number; xmax: number; ymax: number } | null;
};

type Detector = {
  id: string;
  project_id?: string;
  x: number;
  y: number;
  z?: number;
  rotation_deg?: number;
  dtype: string;
  locked?: boolean;
  floor_plan_id?: string | null;
};

type EditTool = "pan" | "select" | "add" | "erase" | "draw-pipe";
type RibbonTab = "home" | "insert" | "automation" | "view";

type PointerInfo = {
  clientX: number;
  clientY: number;
};

type PipeSegment = {
  from: [number, number];
  to: [number, number];
  diameter: string;
};

type PipeSource = { x: number; y: number };

type PipesData = {
  pipes: PipeSegment[];
  sources: PipeSource[];
};

const EQUIPMENT_BUTTONS: { key: string; label: string; color: string }[] = [
  { key: "smoke",      label: "Smoke Detectors", color: "#ef4444" },
  { key: "sprinkler",  label: "Sprinkler",       color: "#ef4444" },
  { key: "fire_hose",  label: "External Hydrant",color: "#ef4444" },
  { key: "mcp_hooter", label: "MCP + Hooter",    color: "#a855f7" },
];

const ADD_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "smoke", label: "Smoke" },
  { value: "sprinkler", label: "Sprinkler" },
  { value: "fire_hose", label: "External Hydrant" },
  { value: "internal_hydrant", label: "Internal Hydrant" },
  { value: "beam_detector", label: "Beam Det." },
  { value: "reflector", label: "Reflector" },
  { value: "mcb", label: "MCP" },
  { value: "hooter", label: "Hooter" },
  { value: "panel", label: "Panel" },
];

const DTYPE_COLORS: Record<string, string> = {
  smoke:      "#ef4444",
  sprinkler:  "#ef4444",
  fire_hose:  "#ef4444",
  internal_hydrant: "#d946ef",
  beam_detector: "#ff00cc",
  reflector: "#2563eb",
  mcb:        "#a855f7",
  hooter:     "#ec4899",
  panel:      "#14b8a6",
};

// Real-world symbol radius (meters) per detector type. Converted to drawing
// units at render time using the project's world_to_m (from settings).
// Smoke/MCP/hooter symbols are small (~1 cm), while a sprinkler's circle
// represents its coverage radius (~1.8 m) as is standard on fire plans.
const DTYPE_RADIUS_M: Record<string, number> = {
  smoke:            0.10,
  sprinkler:        0.40,
  fire_hose:        0.50,
  internal_hydrant: 0.50,
  beam_detector:    0.50,
  reflector:        0.50,
  mcb:              0.50,
  hooter:           0.50,
  panel:            0.50,
};
const DEFAULT_RADIUS_M = 0.05;

const PIPE_DIAMETERS_MM = [20, 25, 32, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300, 350, 400] as const;

function normalizePipeDiameter(diameter?: string) {
  const raw = (diameter || "25mm").toLowerCase().trim();
  const mm = Number.parseInt(raw.replace("mm", ""), 10);
  return PIPE_DIAMETERS_MM.includes(mm as (typeof PIPE_DIAMETERS_MM)[number]) ? mm : 25;
}

function pipeStrokeWidthPx(diameter?: string) {
  const mm = normalizePipeDiameter(diameter);
  if (mm <= 20) return 1.6;
  if (mm <= 25) return 2;
  if (mm <= 32) return 2.6;
  if (mm <= 40) return 3.2;
  if (mm <= 50) return 3.8;
  if (mm <= 65) return 4.6;
  if (mm <= 80) return 5.2;
  if (mm <= 100) return 6;
  if (mm <= 125) return 6.8;
  if (mm <= 150) return 7.4;
  if (mm <= 200) return 8.3;
  if (mm <= 250) return 9;
  if (mm <= 300) return 9.6;
  if (mm <= 350) return 10.2;
  return 10.8;
}

const UNIT_TO_M: Record<string, number> = {
  mm: 0.001, cm: 0.01, m: 1.0, inch: 0.0254, in: 0.0254, ft: 0.3048,
};

function resolveWorldToM(settings: any): number {
  const w = Number(settings?.world_to_m);
  if (Number.isFinite(w) && w > 0) return w;
  const d = Number(settings?.dxf_to_world);
  if (Number.isFinite(d) && d > 0) return d;
  const key = String(settings?.unit || settings?.units || "mm").trim().toLowerCase();
  return UNIT_TO_M[key] ?? 0.001;
}

export default function DxfViewerPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);
  const threeRef = useRef<any>(null);
  const highlightGroupRef = useRef<any>(null);
  const detectorsGroupRef = useRef<any>(null);
  const pipesGroupRef = useRef<any>(null);

  const [dxfUrl, setDxfUrl] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ phase: string; pct: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [showLayers, setShowLayers] = useState(false);
  const [blocks, setBlocks] = useState<BlockInfo[]>([]);
  const [showBlocks, setShowBlocks] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [floorPlans, setFloorPlans] = useState<FloorPlanInfo[]>([]);
  const [showFloors, setShowFloors] = useState(true);
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [floorOpacity, setFloorOpacity] = useState<number>(0.28);
  const [detectors, setDetectors] = useState<Detector[]>([]);
  const [tool, setTool] = useState<EditTool>("pan");
  const [addType, setAddType] = useState<string>("smoke");
  const [selectedDetectorId, setSelectedDetectorId] = useState<string | null>(null);
  const [selectedDetectorIds, setSelectedDetectorIds] = useState<string[]>([]);
  const [draggingDetectorId, setDraggingDetectorId] = useState<string | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const groupDragRef = useRef<{ ids: string[]; startWorld: { x: number; y: number }; startById: Record<string, { x: number; y: number }> } | null>(null);
  const marqueeRef = useRef<{ startX: number; startY: number; additive: boolean } | null>(null);
  const [isSavingEdits, setIsSavingEdits] = useState(false);
  const [manualEditMsg, setManualEditMsg] = useState<string | null>(null);
  const [hasManualChanges, setHasManualChanges] = useState(false);
  const [isAutoPlacing, setIsAutoPlacing] = useState<string | null>(null);
  const [autoPlaceMsg, setAutoPlaceMsg] = useState<string | null>(null);
  const [worldToM, setWorldToM] = useState<number>(0.001);
  const [bgIdx, setBgIdx] = useState(0);
  const [pipesData, setPipesData] = useState<PipesData | null>(null);
  const [showPipes, setShowPipes] = useState(true);
  const [isRoutingPipes, setIsRoutingPipes] = useState(false);
  const [isDetectingSources, setIsDetectingSources] = useState(false);
  const [sourceSelectMode, setSourceSelectMode] = useState(false);
  const [detectedSources, setDetectedSources] = useState<PipeSource[]>([]);
  const [chosenSource, setChosenSource] = useState<PipeSource | null>(null);
  const [isClearingPipes, setIsClearingPipes] = useState(false);
  const [pipeMsg, setPipeMsg] = useState<string | null>(null);
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>("home");
  // Manual pipe drawing
  const [pipeDrawDiameter, setPipeDrawDiameter] = useState<number>(25);
  const [pipeDrawStart, setPipeDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [pipeDrawPreview, setPipeDrawPreview] = useState<{ x: number; y: number } | null>(null);
  const [manualPipes, setManualPipes] = useState<{ from: [number, number]; to: [number, number]; diameter: string }[]>([]);
  // Selected pipe (kind: "auto" → backend-routed, "manual" → drawn locally)
  const [selectedPipe, setSelectedPipe] = useState<{ kind: "auto" | "manual"; index: number } | null>(null);
  // Tracks whether the user has edited (deleted/resized) auto-routed pipes since last save.
  const [pipesModified, setPipesModified] = useState<boolean>(false);
  // Export
  const [isExportingDxf, setIsExportingDxf] = useState(false);
  // Equipment-layer visibility (virtual layers for detector dtypes + pipes).
  // Keys are detector dtype values (smoke, sprinkler, ...) plus the special
  // key "pipes" for sprinkler pipe routing. Defaults to all visible.
  const [equipmentLayerVisibility, setEquipmentLayerVisibility] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = { pipes: true };
    for (const opt of ADD_TYPE_OPTIONS) init[opt.value] = true;
    return init;
  });
  const canEdit = getTenantRole() !== "viewer";
  const hasPipeData = !!(pipesData && ((pipesData.pipes?.length || 0) > 0 || (pipesData.sources?.length || 0) > 0));

  const bgColors = ["#2d2d2d", "#ffffff", "#181825", "#000000"];

  async function fetchPipesData(floorPlanId?: string | null) {
    const token = getToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const pipesUrl = floorPlanId
      ? `/api/projects/${projectId}/floor_plans/${floorPlanId}/sprinkler_pipes`
      : `/api/projects/${projectId}/sprinkler_pipes`;
    const res = await fetch(apiUrl(pipesUrl), { headers, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as PipesData;
  }

  async function loadPipesData(floorPlanId?: string | null) {
    try {
      const pd = await fetchPipesData(floorPlanId);
      setPipesData(pd);
    } catch {
      setPipesData(null);
    }
  }

  // Fetch project and determine input DXF URL
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = getToken();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(apiUrl(`/api/projects/${projectId}`), { headers });
        if (!res.ok) throw new Error(`Project fetch failed (${res.status})`);
        const proj = await res.json();
        if (cancelled) return;

        setProjectName(proj?.name || "");

        // Resolve world_to_m from project settings/units so equipment radii
        // drawn on screen reflect true physical sizes.
        try {
          setWorldToM(resolveWorldToM(proj?.settings || {}));
        } catch { /* keep default */ }

        const inputDxf = proj?.files?.dxf;
        if (!inputDxf) {
          throw new Error("This project has no input DXF.");
        }
        setDxfUrl(apiUrl(inputDxf));

        // Fetch pipeline-extracted floor plan blocks (if any).
        if (proj?.floor_plans_count && proj.floor_plans_count > 0) {
          try {
            const fpRes = await fetch(apiUrl(`/api/projects/${projectId}/floor_plans`), { headers });
            if (fpRes.ok) {
              const fps = await fpRes.json();
              if (!cancelled && Array.isArray(fps)) {
                setFloorPlans(
                  fps.map((fp: any) => ({
                    id: String(fp.id),
                    block_index: Number(fp.block_index) || 0,
                    status: String(fp.status || ""),
                    world_bbox: fp.world_bbox || null,
                  })),
                );
              }
            }
          } catch { /* non-fatal */ }
        }

        // Fetch any already-placed detectors so they're drawn on first load.
        try {
          const detRes = await fetch(apiUrl(`/api/projects/${projectId}/detectors`), { headers });
          if (detRes.ok) {
            const ds = await detRes.json();
            if (!cancelled && Array.isArray(ds)) {
              setDetectors(ds as Detector[]);
            }
          }
        } catch { /* non-fatal */ }

        // Fetch sprinkler pipes for current context (project-level at first load)
        try {
          const pd = await fetchPipesData(null);
          if (!cancelled) setPipesData(pd);
        } catch { /* non-fatal */ }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Failed to load project.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Create viewer and load DXF when URL becomes available
  useEffect(() => {
    if (!dxfUrl) return;
    let cancelled = false;
    (async () => {
      if (!containerRef.current) return;
      setError(null);
      setProgress({ phase: "Fetching…", pct: 0 });

      // IMPORTANT: dxf-viewer bundles its own nested copy of three (^0.161)
      // while the app depends on three ^0.181. If we create objects from the
      // app's three and add them to the viewer's scene, they render as
      // invisible black geometry (different class identities / shader pipeline).
      // Import three from dxf-viewer's nested copy so all objects share the
      // exact same three instance the viewer uses.
      const [{ DxfViewer }, three] = await Promise.all([
        import("dxf-viewer"),
        import("dxf-viewer/node_modules/three"),
      ]);
      if (cancelled || !containerRef.current) return;
      threeRef.current = three;

      if (viewerRef.current) {
        try { viewerRef.current.Destroy?.(); } catch {}
        viewerRef.current = null;
      }

      const viewer = new (DxfViewer as any)(containerRef.current, {
        clearColor: new three.Color(bgColors[bgIdx]),
        autoResize: true,
        colorCorrection: true,
        blackWhiteInversion: true,
        antialias: true,
        // Required so GetDxf() returns the parsed DXF (blocks, entities, …).
        // Without this the Blocks panel always reports 0.
        retainParsedDxf: true,
        sceneOptions: {
          wireframeMesh: true,
          suppressPaperSpace: false,
        },
      });
      viewerRef.current = viewer;

      viewer.Subscribe("loaded", () => {
        const raw = viewer.GetLayers?.();
        if (raw && Array.isArray(raw)) {
          const sorted = [...raw].sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
          const next: LayerInfo[] = sorted.map((l: any) => ({
            name: String(l.name),
            displayName: String(l.displayName || l.name),
            color: Number(l.color) || 0xffffff,
            visible: true,
          }));
          setLayers(next);
        } else {
          setLayers([]);
        }

        // Extract block definitions and gather all INSERT positions across the DXF.
        try {
          const dxf = viewer.GetDxf?.();
          const blockDefs: Record<string, any> = dxf?.blocks || {};
          const topEntities: any[] = Array.isArray(dxf?.entities) ? dxf.entities : [];

          // Recursively walk entities collecting INSERTs by block name, resolving
          // nested block references so we get world-space positions for each leaf.
          const byName = new Map<string, { x: number; y: number }[]>();
          const visited = new Set<string>();

          function addInsert(name: string, x: number, y: number) {
            if (!name) return;
            const arr = byName.get(name) || [];
            arr.push({ x, y });
            byName.set(name, arr);
          }

          function walk(entities: any[], ox: number, oy: number, depth: number) {
            if (!entities || depth > 8) return;
            for (const e of entities) {
              if (!e || typeof e !== "object") continue;
              const type = String(e.type || "").toUpperCase();
              if (type === "INSERT" && e.name && e.position) {
                const ix = (Number(e.position.x) || 0) + ox;
                const iy = (Number(e.position.y) || 0) + oy;
                addInsert(String(e.name), ix, iy);
                // Recurse into referenced block so nested INSERTs inside it also count.
                const def = blockDefs[e.name];
                if (def && Array.isArray(def.entities) && !visited.has(e.name)) {
                  visited.add(e.name);
                  walk(def.entities, ix, iy, depth + 1);
                  visited.delete(e.name);
                }
              }
            }
          }

          walk(topEntities, 0, 0, 0);

          // Build list from all known block definitions so blocks with zero
          // top-level inserts still appear (e.g. nested-only or unused blocks).
          const names = new Set<string>([
            ...Object.keys(blockDefs),
            ...byName.keys(),
          ]);
          const list: BlockInfo[] = [...names]
            .filter((n) => !!n && !n.startsWith("*"))
            .map((name) => {
              const insertions = byName.get(name) || [];
              return { name, count: insertions.length, insertions };
            })
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
          setBlocks(list);
        } catch {
          setBlocks([]);
        }
        setSelectedBlock(null);

        const bounds = viewer.GetBounds?.();
        const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
        if (bounds) {
          // FitView expects scene-local coordinates (origin already subtracted).
          viewer.FitView?.(
            bounds.minX - origin.x, bounds.maxX - origin.x,
            bounds.minY - origin.y, bounds.maxY - origin.y,
            0.08,
          );
        }
      });

      viewer.Subscribe("message", (e: any) => {
        if (e?.level === "warn" || e?.level === "error") {
          console.warn("[dxf-viewer]", e?.message || e);
        }
      });

      try {
        await viewer.Load({
          url: dxfUrl,
          fonts: FONTS,
          progressCbk: (phase: string, processed: number, total: number) => {
            if (cancelled) return;
            const label =
              phase === "fetch" ? "Fetching…" :
              phase === "parse" ? "Parsing…" :
              phase === "prepare" ? "Preparing…" :
              phase === "font" ? "Loading fonts…" : phase;
            const pct = total && total > 0 ? Math.round((processed / total) * 100) : 100;
            setProgress({ phase: label, pct });
          },
          workerFactory: null,
        });
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Failed to load DXF.");
      } finally {
        if (!cancelled) setProgress(null);
      }
    })();
    return () => {
      cancelled = true;
      if (viewerRef.current) {
        try { viewerRef.current.Destroy?.(); } catch {}
        viewerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dxfUrl]);

  // Background color
  useEffect(() => {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return;
    const renderer = viewer.GetRenderer?.();
    if (renderer) {
      renderer.setClearColor(new three.Color(bgColors[bgIdx]));
      viewer.Render?.();
    }
  }, [bgIdx]);

  // Lock viewer navigation while editing/selecting so drag only affects markers.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const navigationEnabled = (tool === "pan") && !sourceSelectMode;
    const controls = (viewer.GetControls?.() ?? (viewer as any).controls ?? (viewer as any)._controls) as any;
    if (controls) {
      if ("enabled" in controls) controls.enabled = navigationEnabled;
      if ("enablePan" in controls) controls.enablePan = navigationEnabled;
      if ("enableRotate" in controls) controls.enableRotate = navigationEnabled;
      if ("enableDamping" in controls && !navigationEnabled) controls.enableDamping = false;
    }
  }, [tool, sourceSelectMode]);

  function fitView() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const bounds = viewer.GetBounds?.();
    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
    if (bounds) {
      viewer.FitView?.(
        bounds.minX - origin.x, bounds.maxX - origin.x,
        bounds.minY - origin.y, bounds.maxY - origin.y,
        0.08,
      );
    }
  }

  // Live-update floor-plan highlight opacity when the slider changes.
  useEffect(() => {
    const viewer = viewerRef.current;
    const group = highlightGroupRef.current;
    if (!viewer || !group) return;
    try {
      group.traverse?.((obj: any) => {
        if (obj?.userData?.kind === "floor-fill" && obj.material && !obj.material.disposed) {
          obj.material.opacity = floorOpacity;
          obj.material.transparent = true;
        }
      });
      viewer.Render?.();
    } catch (err) {
      // Ignore transient errors (e.g. group disposed mid-update).
      console.warn("[dxf-viewer] opacity update skipped:", err);
    }
  }, [floorOpacity]);

  function toggleLayer(name: string, visible: boolean) {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.ShowLayer?.(name, visible);
    setLayers((prev) => prev.map((l) => (l.name === name ? { ...l, visible } : l)));
  }

  function clearHighlight() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const scene = viewer.GetScene?.();
    const group = highlightGroupRef.current;
    if (group && scene) {
      scene.remove(group);
      group.traverse((obj: any) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
    }
    highlightGroupRef.current = null;
    viewer.Render?.();
  }

  function highlightBlock(blockName: string) {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return;
    const block = blocks.find((b) => b.name === blockName);
    if (!block) return;

    clearHighlight();

    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
    const bounds = viewer.GetBounds?.();
    let radius = 50;
    if (bounds) {
      const dx = bounds.maxX - bounds.minX;
      const dy = bounds.maxY - bounds.minY;
      radius = Math.max(dx, dy) * 0.008;
    }

    // Fall back to the block definition's own entities if there are no INSERTs
    // (happens when the viewer flattens/inlines blocks).
    let points = block.insertions;
    if (points.length === 0) {
      try {
        const dxf = viewer.GetDxf?.();
        const def = dxf?.blocks?.[block.name];
        const xs: number[] = [];
        const ys: number[] = [];
        const push = (x: any, y: any) => {
          const nx = Number(x); const ny = Number(y);
          if (Number.isFinite(nx) && Number.isFinite(ny)) { xs.push(nx); ys.push(ny); }
        };
        const visit = (ents: any[]) => {
          if (!Array.isArray(ents)) return;
          for (const e of ents) {
            if (!e) continue;
            if (e.position) push(e.position.x, e.position.y);
            if (e.startPoint) push(e.startPoint.x, e.startPoint.y);
            if (e.endPoint) push(e.endPoint.x, e.endPoint.y);
            if (e.center) push(e.center.x, e.center.y);
            if (Array.isArray(e.vertices)) {
              for (const v of e.vertices) push(v.x, v.y);
            }
          }
        };
        visit(def?.entities);
        if (xs.length) {
          const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
          const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
          const bx = Number(def?.position?.x) || 0;
          const by = Number(def?.position?.y) || 0;
          points = [{ x: cx + bx, y: cy + by }];
        }
      } catch {}
    }

    if (points.length === 0) return;

    const group = new three.Group();
    const color = new three.Color("#ff3b30");

    for (const ins of points) {
      const x = ins.x - origin.x;
      const y = ins.y - origin.y;

      const disc = new three.Mesh(
        new three.CircleGeometry(radius, 48),
        new three.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthTest: false }),
      );
      disc.position.set(x, y, 0);
      disc.renderOrder = 999;
      group.add(disc);

      const ringGeom = new three.RingGeometry(radius * 0.95, radius * 1.1, 48);
      const ring = new three.Mesh(
        ringGeom,
        new three.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }),
      );
      ring.position.set(x, y, 0);
      ring.renderOrder = 1000;
      group.add(ring);
    }

    const scene = viewer.GetScene?.();
    if (scene) scene.add(group);
    highlightGroupRef.current = group;
    viewer.Render?.();
  }

  function selectBlock(name: string) {
    if (selectedBlock === name) {
      setSelectedBlock(null);
      clearHighlight();
    } else {
      setSelectedFloorId(null);
      setSelectedBlock(name);
      highlightBlock(name);
    }
  }

  function highlightFloorPlan(fp: FloorPlanInfo) {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return;
    const bb = fp.world_bbox;
    if (!bb) return;

    clearHighlight();

    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
    const x0 = bb.xmin - origin.x;
    const y0 = bb.ymin - origin.y;
    const x1 = bb.xmax - origin.x;
    const y1 = bb.ymax - origin.y;
    const w = x1 - x0;
    const h = y1 - y0;
    if (!(w > 0 && h > 0)) return;

    const group = new three.Group();
    const color = new three.Color("#22d3ee");

    // Translucent filled rectangle. Use DoubleSide so it shows regardless of
    // the camera orientation, and push it slightly in +Z so it sits on top of
    // the drawing geometry.
    const fill = new three.Mesh(
      new three.PlaneGeometry(w, h),
      new three.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: floorOpacity,
        depthTest: false,
        depthWrite: false,
        side: three.DoubleSide,
      }),
    );
    fill.position.set(x0 + w / 2, y0 + h / 2, 0.5);
    fill.renderOrder = 999;
    (fill as any).userData = { kind: "floor-fill" };
    group.add(fill);

    // Outline (thicker / brighter for visibility).
    const outlineGeom = new three.BufferGeometry().setFromPoints([
      new three.Vector3(x0, y0, 0.6),
      new three.Vector3(x1, y0, 0.6),
      new three.Vector3(x1, y1, 0.6),
      new three.Vector3(x0, y1, 0.6),
      new three.Vector3(x0, y0, 0.6),
    ]);
    const outline = new three.Line(
      outlineGeom,
      new three.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 1.0,
        depthTest: false,
        depthWrite: false,
        linewidth: 3,
      }),
    );
    outline.renderOrder = 1000;
    group.add(outline);

    const scene = viewer.GetScene?.();
    if (scene) scene.add(group);
    highlightGroupRef.current = group;

    // Zoom to the block with a small padding. FitView expects scene-local
    // coordinates (origin already subtracted).
    viewer.FitView?.(
      bb.xmin - origin.x, bb.xmax - origin.x,
      bb.ymin - origin.y, bb.ymax - origin.y,
      0.1,
    );
    viewer.Render?.();
  }

  function selectFloorPlan(fp: FloorPlanInfo) {
    if (selectedFloorId === fp.id) {
      setSelectedFloorId(null);
      clearHighlight();
      void loadPipesData(null);
      return;
    }
    setSelectedBlock(null);
    setSelectedFloorId(fp.id);
    highlightFloorPlan(fp);
    void loadPipesData(fp.id);
  }

  // ── Detector rendering ──

  function clearDetectorMarkers() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const scene = viewer.GetScene?.();
    const group = detectorsGroupRef.current;
    if (group && scene) {
      scene.remove(group);
      group.traverse?.((obj: any) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
    }
    detectorsGroupRef.current = null;
  }

  function clearPipeMarkers() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const scene = viewer.GetScene?.();
    const group = pipesGroupRef.current;
    if (group && scene) {
      scene.remove(group);
      group.traverse?.((obj: any) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
    }
    pipesGroupRef.current = null;
  }

  function renderPipes() {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return;

    clearPipeMarkers();
    const hasSelectionOverlay = sourceSelectMode && (detectedSources.length > 0 || !!chosenSource);
    const hasManualPipes = manualPipes.length > 0 || !!pipeDrawStart;
    if ((!pipesData || !showPipes) && !hasSelectionOverlay && !hasManualPipes) return;

    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
    const scene = viewer.GetScene?.();
    if (!scene) return;
    const group = new three.Group();

    // Compute dot radius matching smoke detector size (uses worldToM from closure)
    const _wtm = Number.isFinite(worldToM) && worldToM > 0 ? worldToM : 1.0;
    const _upm = 1.0 / _wtm;
    const dotR = Math.max((DTYPE_RADIUS_M["smoke"] ?? 0.10) * _upm * 0.85, _upm * 0.08);

    // Helper: build a solid-red rectangle mesh between two points sized by diameter.
    function buildPipeMesh(
      ax: number, ay: number, bx: number, by: number,
      diameter: string | undefined, z: number, renderOrder: number,
    ): any | null {
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) return null;

      const mm = normalizePipeDiameter(diameter);
      // World-space thickness scaled by diameter and drawing scale (_upm = units per meter).
      // Floor: ~0.05m equivalent so 25mm pipes are visible but not overpowering.
      // 25mm  → 0.075 m
      // 100mm → 0.300 m
      // 400mm → 1.200 m
      const thicknessM = Math.max(0.05, mm * 0.003);
      const thickness = Math.max(1, thicknessM * _upm);

      // Perpendicular (normalized)
      const px = -dy / len;
      const py = dx / len;
      const half = thickness / 2;

      const positions = new Float32Array([
        ax + px * half, ay + py * half, z, // 0
        ax - px * half, ay - py * half, z, // 1
        bx - px * half, by - py * half, z, // 2
        bx + px * half, by + py * half, z, // 3
      ]);
      const geom = new three.BufferGeometry();
      geom.setAttribute("position", new three.BufferAttribute(positions, 3));
      geom.setIndex([0, 1, 2, 0, 2, 3]);
      const mesh = new three.Mesh(
        geom,
        new three.MeshBasicMaterial({
          color: new three.Color(0xDC2626), // solid red
          transparent: false,
          opacity: 1,
          depthTest: false,
          depthWrite: false,
          side: three.DoubleSide,
        }),
      );
      mesh.renderOrder = renderOrder;
      return mesh;
    }

    // Render auto-routed pipes as solid-red rectangles
    if (
      pipesData?.pipes &&
      pipesData.pipes.length > 0 &&
      equipmentLayerVisibility.pipes !== false
    ) {
      for (let i = 0; i < pipesData.pipes.length; i++) {
        const pipe = pipesData.pipes[i];
        const fx = pipe.from[0] - origin.x;
        const fy = pipe.from[1] - origin.y;
        const tx = pipe.to[0] - origin.x;
        const ty = pipe.to[1] - origin.y;
        const mesh = buildPipeMesh(fx, fy, tx, ty, pipe.diameter, 0.5, 1000);
        if (mesh) {
          if (selectedPipe && selectedPipe.kind === "auto" && selectedPipe.index === i) {
            (mesh.material as any).color = new three.Color(0xFACC15); // yellow highlight
          }
          group.add(mesh);
        }
      }
    }

    // Render pipe sources
    if (pipesData?.sources && pipesData.sources.length > 0) {
      for (const src of pipesData.sources) {
        const p = [src.x - origin.x, src.y - origin.y];

        // Red square: 14x14 units
        const boxGeom = new three.BufferGeometry().setFromPoints([
          new three.Vector3(p[0] - 7, p[1] - 7, 0.51),
          new three.Vector3(p[0] + 7, p[1] - 7, 0.51),
          new three.Vector3(p[0] + 7, p[1] + 7, 0.51),
          new three.Vector3(p[0] - 7, p[1] + 7, 0.51),
          new three.Vector3(p[0] - 7, p[1] - 7, 0.51),
        ]);
        const box = new three.Line(
          boxGeom,
          new three.LineBasicMaterial({
            color: new three.Color(0xB91C1C), // darker red
            transparent: true,
            opacity: 0.85,
            depthTest: false,
            depthWrite: false,
            linewidth: 1.8,
          }),
        );
        box.renderOrder = 1001;
        group.add(box);

        // White cross in center
        const crossH = [
          new three.Vector3(p[0] - 4, p[1], 0.52),
          new three.Vector3(p[0] + 4, p[1], 0.52),
        ];
        const crossV = [
          new three.Vector3(p[0], p[1] - 4, 0.52),
          new three.Vector3(p[0], p[1] + 4, 0.52),
        ];
        const hLine = new three.Line(
          new three.BufferGeometry().setFromPoints(crossH),
          new three.LineBasicMaterial({
            color: new three.Color(0xffffff),
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false,
            linewidth: 1.8,
          }),
        );
        const vLine = new three.Line(
          new three.BufferGeometry().setFromPoints(crossV),
          new three.LineBasicMaterial({
            color: new three.Color(0xffffff),
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false,
            linewidth: 1.8,
          }),
        );
        hLine.renderOrder = 1001;
        vLine.renderOrder = 1001;
        group.add(hLine);
        group.add(vLine);
      }
    }

    // Render source candidates while selecting a source.
    if (sourceSelectMode && detectedSources.length > 0) {
      for (const src of detectedSources) {
        const p = [src.x - origin.x, src.y - origin.y];
        const isChosen = !!chosenSource && Math.abs(chosenSource.x - src.x) < 1 && Math.abs(chosenSource.y - src.y) < 1;
        const color = isChosen ? 0x16A34A : 0xF59E0B;
        const half = isChosen ? 9 : 8;
        const boxGeom = new three.BufferGeometry().setFromPoints([
          new three.Vector3(p[0] - half, p[1] - half, 0.53),
          new three.Vector3(p[0] + half, p[1] - half, 0.53),
          new three.Vector3(p[0] + half, p[1] + half, 0.53),
          new three.Vector3(p[0] - half, p[1] + half, 0.53),
          new three.Vector3(p[0] - half, p[1] - half, 0.53),
        ]);
        const box = new three.Line(
          boxGeom,
          new three.LineBasicMaterial({
            color: new three.Color(color),
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false,
            linewidth: 2.2,
          }),
        );
        box.renderOrder = 1002;
        group.add(box);

        // Bright filled dot for the chosen detected source.
        if (isChosen) {
          const dot = new three.Mesh(
              new three.CircleGeometry(dotR, 20),
            new three.MeshBasicMaterial({
                color: new three.Color(0xFDE047),
              transparent: true,
              opacity: 1,
              depthTest: false,
              depthWrite: false,
              side: three.DoubleSide,
            }),
          );
          dot.position.set(p[0], p[1], 0.56);
          dot.renderOrder = 1004;
          group.add(dot);

          // Bright white halo ring around dot.
          const halo = new three.Mesh(
              new three.RingGeometry(dotR, dotR * 1.5, 24),
            new three.MeshBasicMaterial({
              color: new three.Color(0xffffff),
              transparent: true,
              opacity: 0.9,
              depthTest: false,
              depthWrite: false,
              side: three.DoubleSide,
            }),
          );
          halo.position.set(p[0], p[1], 0.57);
          halo.renderOrder = 1005;
          group.add(halo);
        }
      }
    }

    if (
      sourceSelectMode &&
      chosenSource &&
      !detectedSources.some((src) => Math.abs(src.x - chosenSource.x) < 1 && Math.abs(src.y - chosenSource.y) < 1)
    ) {
      const p = [chosenSource.x - origin.x, chosenSource.y - origin.y];
      const boxGeom = new three.BufferGeometry().setFromPoints([
        new three.Vector3(p[0] - 10, p[1] - 10, 0.54),
        new three.Vector3(p[0] + 10, p[1] - 10, 0.54),
        new three.Vector3(p[0] + 10, p[1] + 10, 0.54),
        new three.Vector3(p[0] - 10, p[1] + 10, 0.54),
        new three.Vector3(p[0] - 10, p[1] - 10, 0.54),
      ]);
      const box = new three.Line(
        boxGeom,
        new three.LineBasicMaterial({
          color: new three.Color(0x16A34A),
          transparent: true,
          opacity: 0.98,
          depthTest: false,
          depthWrite: false,
          linewidth: 2.4,
        }),
      );
      box.renderOrder = 1003;
      group.add(box);

      const crossH = [
        new three.Vector3(p[0] - 5, p[1], 0.55),
        new three.Vector3(p[0] + 5, p[1], 0.55),
      ];
      const crossV = [
        new three.Vector3(p[0], p[1] - 5, 0.55),
        new three.Vector3(p[0], p[1] + 5, 0.55),
      ];
      const hLine = new three.Line(
        new three.BufferGeometry().setFromPoints(crossH),
        new three.LineBasicMaterial({
          color: new three.Color(0x16A34A),
          transparent: true,
          opacity: 0.98,
          depthTest: false,
          depthWrite: false,
          linewidth: 2.2,
        }),
      );
      const vLine = new three.Line(
        new three.BufferGeometry().setFromPoints(crossV),
        new three.LineBasicMaterial({
          color: new three.Color(0x16A34A),
          transparent: true,
          opacity: 0.98,
          depthTest: false,
          depthWrite: false,
          linewidth: 2.2,
        }),
      );
      hLine.renderOrder = 1003;
      vLine.renderOrder = 1003;
      group.add(hLine);
      group.add(vLine);

      // Bright filled dot for the custom-placed source.
      const dot = new three.Mesh(
          new three.CircleGeometry(dotR, 20),
        new three.MeshBasicMaterial({
            color: new three.Color(0xFDE047),
          transparent: true,
          opacity: 1,
          depthTest: false,
          depthWrite: false,
          side: three.DoubleSide,
        }),
      );
      dot.position.set(p[0], p[1], 0.56);
      dot.renderOrder = 1004;
      group.add(dot);

      const halo = new three.Mesh(
          new three.RingGeometry(dotR, dotR * 1.5, 24),
        new three.MeshBasicMaterial({
          color: new three.Color(0xffffff),
          transparent: true,
          opacity: 0.9,
          depthTest: false,
          depthWrite: false,
          side: three.DoubleSide,
        }),
      );
      halo.position.set(p[0], p[1], 0.57);
      halo.renderOrder = 1005;
      group.add(halo);
    }

    // ── Render manually drawn pipes as solid-red rectangles ──
    if (equipmentLayerVisibility.pipes !== false) {
      for (let i = 0; i < manualPipes.length; i++) {
        const mp = manualPipes[i];
        const fx = mp.from[0] - origin.x;
        const fy = mp.from[1] - origin.y;
        const tx = mp.to[0] - origin.x;
        const ty = mp.to[1] - origin.y;
        const mesh = buildPipeMesh(fx, fy, tx, ty, mp.diameter, 0.5, 1000);
        if (mesh) {
          if (selectedPipe && selectedPipe.kind === "manual" && selectedPipe.index === i) {
            (mesh.material as any).color = new three.Color(0xFACC15); // yellow highlight
          }
          group.add(mesh);
        }
      }
    }

    // ── Draw preview rectangle while placing a pipe ──
    if (pipeDrawStart && pipeDrawPreview) {
      const fs = [pipeDrawStart.x - origin.x, pipeDrawStart.y - origin.y];
      const tp = [pipeDrawPreview.x - origin.x, pipeDrawPreview.y - origin.y];
      const previewMesh = buildPipeMesh(
        fs[0], fs[1], tp[0], tp[1],
        `${pipeDrawDiameter || 25}mm`,
        0.52,
        1006,
      );
      if (previewMesh) {
        // Slightly lighter red for preview to distinguish from committed pipes.
        (previewMesh.material as any).color = new three.Color(0xF87171);
        (previewMesh.material as any).transparent = true;
        (previewMesh.material as any).opacity = 0.75;
        group.add(previewMesh);
      }

      // Dot at start anchor
      const anchorDot = new three.Mesh(
        new three.CircleGeometry(dotR * 0.5, 16),
        new three.MeshBasicMaterial({
          color: new three.Color(0x3b82f6), transparent: true, opacity: 1,
          depthTest: false, depthWrite: false, side: three.DoubleSide,
        }),
      );
      anchorDot.position.set(fs[0], fs[1], 0.53);
      anchorDot.renderOrder = 1007;
      group.add(anchorDot);
    }

    scene.add(group);
    pipesGroupRef.current = group;
  }

  function renderDetectors() {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return;

    clearDetectorMarkers();
    if (detectors.length === 0) {
      renderPipes();
      viewer.Render?.();
      return;
    }

    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };

    // Use the project's configured scale directly:
    //   drawing_units × world_to_m = meters  ⇒  units_per_m = 1 / world_to_m
    // e.g. world_to_m = 1   (meters)      → 1 unit/m
    //      world_to_m = 0.001 (mm)        → 1000 units/m
    const wtm = Number.isFinite(worldToM) && worldToM > 0 ? worldToM : 1.0;
    const unitsPerMeter = 1.0 / wtm;

    function radiusFor(dtype: string): number {
      const rMeters = DTYPE_RADIUS_M[dtype] ?? DEFAULT_RADIUS_M;
      return rMeters * unitsPerMeter;
    }

    const group = new three.Group();

    function addPolyline(
      points: Array<{ x: number; y: number }>,
      colorHex: string,
      z: number,
      width = 1,
      close = false,
    ) {
      if (!points.length) return;
      const pts = points.map((p) => new three.Vector3(p.x, p.y, z));
      if (close && points.length > 1) {
        pts.push(new three.Vector3(points[0].x, points[0].y, z));
      }
      const line = new three.Line(
        new three.BufferGeometry().setFromPoints(pts),
        new three.LineBasicMaterial({
          color: new three.Color(colorHex),
          transparent: true,
          opacity: 0.95,
          depthTest: false,
          depthWrite: false,
          linewidth: width,
        }),
      );
      line.renderOrder = 1102;
      group.add(line);
    }

    for (const d of detectors) {
      const x = Number(d.x) - origin.x;
      const y = Number(d.y) - origin.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      // Honor virtual equipment-layer visibility from the Layers panel.
      if (equipmentLayerVisibility[d.dtype] === false) continue;

      const radius = radiusFor(d.dtype);
      const color = new three.Color(DTYPE_COLORS[d.dtype] || "#22d3ee");
      const dtype = String(d.dtype || "").toLowerCase();
      const smokeSymbolRadius = Math.max(radiusFor("smoke") * 0.85, unitsPerMeter * 0.08);

      const isSelected = selectedDetectorIds.includes(d.id) || d.id === selectedDetectorId;

      // Sprinkler symbol: circle with a plus touching the rim.
      if (dtype === "sprinkler") {
        const s = smokeSymbolRadius;

        const ringPts: any[] = [];
        for (let i = 0; i <= 48; i++) {
          const t = (i / 48) * Math.PI * 2;
          ringPts.push(new three.Vector3(x + s * Math.cos(t), y + s * Math.sin(t), 0.71));
        }
        const ring = new three.Line(
          new three.BufferGeometry().setFromPoints(ringPts),
          new three.LineBasicMaterial({
            color,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false,
          }),
        );
        ring.renderOrder = 1101;
        group.add(ring);

        addPolyline([
          { x: x - s, y },
          { x: x + s, y },
        ], DTYPE_COLORS.sprinkler, 0.72, 1, false);
        addPolyline([
          { x, y: y - s },
          { x, y: y + s },
        ], DTYPE_COLORS.sprinkler, 0.72, 1, false);

        if (isSelected) {
          const selectedPts: any[] = [];
          const selectedR = s * 1.35;
          for (let i = 0; i <= 64; i++) {
            const t = (i / 64) * Math.PI * 2;
            selectedPts.push(new three.Vector3(x + selectedR * Math.cos(t), y + selectedR * Math.sin(t), 0.72));
          }
          const selectedGeom = new three.BufferGeometry().setFromPoints(selectedPts);
          const selected = new three.Line(
            selectedGeom,
            new three.LineBasicMaterial({
              color: new three.Color("#ffffff"), transparent: true, opacity: 1,
              depthTest: false, depthWrite: false,
            }),
          );
          selected.renderOrder = 1102;
          group.add(selected);
        }
        continue;
      }

      // Smoke detector symbol: circle with an "S" inside.
      if (dtype === "smoke") {
        const s = smokeSymbolRadius;

        const ringPts: any[] = [];
        for (let i = 0; i <= 48; i++) {
          const t = (i / 48) * Math.PI * 2;
          ringPts.push(new three.Vector3(x + s * Math.cos(t), y + s * Math.sin(t), 0.71));
        }
        const ring = new three.Line(
          new three.BufferGeometry().setFromPoints(ringPts),
          new three.LineBasicMaterial({
            color,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false,
          }),
        );
        ring.renderOrder = 1101;
        group.add(ring);

        const sCurvePts: Array<{ x: number; y: number }> = [];
        const steps = 24;
        for (let i = 0; i <= steps; i++) {
          const t = -1 + (2 * i) / steps;
          sCurvePts.push({
            x: x - Math.sin(Math.PI * t) * (s * 0.34),
            y: y + t * (s * 0.56),
          });
        }
        addPolyline(sCurvePts, DTYPE_COLORS.smoke || "#ef4444", 0.72, 1, false);

        if (isSelected) {
          const selectedPts: any[] = [];
          const selectedR = s * 1.35;
          for (let i = 0; i <= 64; i++) {
            const t = (i / 64) * Math.PI * 2;
            selectedPts.push(new three.Vector3(x + selectedR * Math.cos(t), y + selectedR * Math.sin(t), 0.72));
          }
          const selectedGeom = new three.BufferGeometry().setFromPoints(selectedPts);
          const selected = new three.Line(
            selectedGeom,
            new three.LineBasicMaterial({
              color: new three.Color("#ffffff"), transparent: true, opacity: 1,
              depthTest: false, depthWrite: false,
            }),
          );
          selected.renderOrder = 1102;
          group.add(selected);
        }
        continue;
      }

      // Custom symbol glyphs for key fire-safety equipment used in plans.
      if (dtype === "fire_hose" || dtype === "internal_hydrant" || dtype === "beam_detector" || dtype === "reflector" || dtype === "mcb" || dtype === "hooter" || dtype === "panel") {
        const s = (dtype === "mcb" || dtype === "hooter" || dtype === "panel")
          ? smokeSymbolRadius
          : Math.max(radius * 0.85, unitsPerMeter * 0.08);
        const colorHex = DTYPE_COLORS[dtype] || "#22d3ee";

        if (dtype === "panel") {
          addPolyline([
            { x: x - s * 0.86, y: y - s * 0.62 },
            { x: x + s * 0.86, y: y - s * 0.62 },
            { x: x + s * 0.86, y: y + s * 0.62 },
            { x: x - s * 0.86, y: y + s * 0.62 },
          ], colorHex, 0.72, 1, true);
          addPolyline([
            { x: x - s * 0.62, y: y },
            { x: x + s * 0.62, y: y },
          ], colorHex, 0.72, 1, false);

          const indicator = new three.Mesh(
            new three.CircleGeometry(s * 0.10, 12),
            new three.MeshBasicMaterial({
              color: new three.Color(colorHex),
              transparent: true,
              opacity: 1,
              depthTest: false,
              depthWrite: false,
              side: three.DoubleSide,
            }),
          );
          indicator.position.set(x, y + s * 0.28, 0.72);
          indicator.renderOrder = 1102;
          group.add(indicator);
        }

        if (dtype === "mcb") {
          addPolyline([
            { x: x - s * 0.78, y: y - s * 0.78 },
            { x: x + s * 0.78, y: y - s * 0.78 },
            { x: x + s * 0.78, y: y + s * 0.78 },
            { x: x - s * 0.78, y: y + s * 0.78 },
          ], colorHex, 0.72, 1, true);

          const core = new three.Mesh(
            new three.CircleGeometry(s * 0.24, 20),
            new three.MeshBasicMaterial({
              color: new three.Color(colorHex),
              transparent: true,
              opacity: 1,
              depthTest: false,
              depthWrite: false,
              side: three.DoubleSide,
            }),
          );
          core.position.set(x, y, 0.72);
          core.renderOrder = 1102;
          group.add(core);
        }

        if (dtype === "hooter") {
          // Alarm bell symbol.
          addPolyline([
            { x: x - s * 0.46, y: y + s * 0.52 },
            { x: x - s * 0.46, y: y + s * 0.06 },
            { x: x - s * 0.38, y: y - s * 0.24 },
            { x: x - s * 0.22, y: y - s * 0.46 },
            { x: x, y: y - s * 0.54 },
            { x: x + s * 0.22, y: y - s * 0.46 },
            { x: x + s * 0.38, y: y - s * 0.24 },
            { x: x + s * 0.46, y: y + s * 0.06 },
            { x: x + s * 0.46, y: y + s * 0.52 },
          ], colorHex, 0.72, 1, false);
          addPolyline([
            { x: x - s * 0.58, y: y + s * 0.52 },
            { x: x + s * 0.58, y: y + s * 0.52 },
          ], colorHex, 0.72, 1, false);
          addPolyline([
            { x, y: y + s * 0.52 },
            { x, y: y + s * 0.70 },
          ], colorHex, 0.72, 1, false);
          addPolyline([
            { x: x - s * 0.82, y: y + s * 0.12 },
            { x: x - s * 0.98, y: y - s * 0.02 },
          ], colorHex, 0.72, 1, false);
          addPolyline([
            { x: x + s * 0.82, y: y + s * 0.12 },
            { x: x + s * 0.98, y: y - s * 0.02 },
          ], colorHex, 0.72, 1, false);
        }

        if (dtype === "fire_hose") {
          addPolyline([
            { x: x - s * 0.95, y: y - s * 0.28 },
            { x: x - s * 0.45, y: y - s * 0.28 },
            { x: x - s * 0.45, y: y + s * 0.28 },
            { x: x - s * 0.95, y: y + s * 0.28 },
          ], colorHex, 0.72, 1, true);
          addPolyline([
            { x: x - s * 0.70, y: y },
            { x: x - s * 0.05, y: y },
          ], "#ffffff", 0.73, 1, false);
          addPolyline([
            { x: x - s * 0.50, y: y - s * 0.62 },
            { x: x - s * 0.50, y: y + s * 0.62 },
          ], colorHex, 0.72, 1, false);

          const ring = new three.LineLoop(
            new three.CircleGeometry(s * 0.42, 28),
            new three.LineBasicMaterial({ color: new three.Color(colorHex), transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }),
          );
          ring.position.set(x + s * 0.18, y, 0.72);
          ring.renderOrder = 1102;
          group.add(ring);

          addPolyline([
            { x: x + s * 0.58, y: y - s * 0.34 },
            { x: x + s * 0.76, y: y },
            { x: x + s * 0.58, y: y + s * 0.34 },
          ], colorHex, 0.72, 1, false);
          addPolyline([
            { x: x + s * 0.80, y: y - s * 0.30 },
            { x: x + s * 0.80, y: y + s * 0.30 },
          ], colorHex, 0.72, 1, false);
        }

        if (dtype === "internal_hydrant") {
          addPolyline([
            { x: x - s * 0.88, y: y - s * 0.58 },
            { x: x + s * 0.88, y: y - s * 0.58 },
            { x: x + s * 0.88, y: y + s * 0.58 },
            { x: x - s * 0.88, y: y + s * 0.58 },
          ], colorHex, 0.72, 1, true);
          addPolyline([
            { x: x - s * 0.78, y: y + s * 0.50 },
            { x: x - s * 0.78, y: y - s * 0.50 },
            { x: x + s * 0.58, y: y + s * 0.50 },
          ], colorHex, 0.72, 1, false);
          addPolyline([
            { x: x - s * 0.44, y: y - s * 0.24 },
            { x: x - s * 0.22, y: y - s * 0.11 },
            { x: x, y: y + s * 0.03 },
            { x: x + s * 0.22, y: y + s * 0.17 },
            { x: x + s * 0.44, y: y + s * 0.30 },
          ], colorHex, 0.72, 1, false);
        }

        if (dtype === "beam_detector" || dtype === "reflector") {
          addPolyline([
            { x: x - s * 1.05, y: y - s * 0.62 },
            { x: x + s * 1.05, y: y - s * 0.62 },
            { x: x + s * 1.05, y: y + s * 0.62 },
            { x: x - s * 1.05, y: y + s * 0.62 },
          ], colorHex, 0.72, 1, true);
          addPolyline([
            { x: x - s * 0.88, y: y + s * 0.62 },
            { x: x, y: y + s * 0.10 },
            { x: x + s * 0.88, y: y + s * 0.62 },
          ], colorHex, 0.72, 1, false);
          if (dtype === "reflector") {
            addPolyline([
              { x: x, y: y + s * 0.10 },
              { x: x, y: y + s * 0.62 },
            ], colorHex, 0.72, 1, false);
          } else {
            addPolyline([
              { x: x - s * 0.28, y: y - s * 0.10 },
              { x: x - s * 0.28, y: y + s * 0.26 },
              { x: x + s * 0.05, y: y + s * 0.16 },
              { x: x - s * 0.28, y: y + s * 0.06 },
            ], colorHex, 0.72, 1, false);
          }
        }

        if (isSelected) {
          const selected = new three.Mesh(
            new three.RingGeometry(radius * 1.25, radius * 1.45, 32),
            new three.MeshBasicMaterial({
              color: new three.Color("#ffffff"),
              transparent: true,
              opacity: 0.95,
              depthTest: false,
              depthWrite: false,
              side: three.DoubleSide,
            }),
          );
          selected.position.set(x, y, 0.72);
          selected.renderOrder = 1102;
          group.add(selected);
        }
        continue;
      }

      // Other dtypes: solid disc at physical size + white ring outline.
      const disc = new three.Mesh(
        new three.CircleGeometry(radius, 32),
        new three.MeshBasicMaterial({
          color, transparent: true, opacity: 0.9,
          depthTest: false, depthWrite: false, side: three.DoubleSide,
        }),
      );
      disc.position.set(x, y, 0.7);
      disc.renderOrder = 1100;
      group.add(disc);

      const ring = new three.Mesh(
        new three.RingGeometry(radius, radius * 1.2, 32),
        new three.MeshBasicMaterial({
          color: new three.Color("#ffffff"),
          transparent: true, opacity: 0.9,
          depthTest: false, depthWrite: false, side: three.DoubleSide,
        }),
      );
      ring.position.set(x, y, 0.71);
      ring.renderOrder = 1101;
      group.add(ring);

      if (isSelected) {
        const selected = new three.Mesh(
          new three.RingGeometry(radius * 1.25, radius * 1.45, 32),
          new three.MeshBasicMaterial({
            color: new three.Color("#ffffff"),
            transparent: true, opacity: 0.95,
            depthTest: false, depthWrite: false, side: three.DoubleSide,
          }),
        );
        selected.position.set(x, y, 0.72);
        selected.renderOrder = 1102;
        group.add(selected);
      }
    }

    const scene = viewer.GetScene?.();
    if (scene) scene.add(group);
    detectorsGroupRef.current = group;
    renderPipes();
    viewer.Render?.();
  }

  // Re-render detector markers whenever the list or scale changes.
  useEffect(() => {
    renderDetectors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectors, dxfUrl, worldToM, selectedDetectorId, selectedDetectorIds, pipesData, showPipes, sourceSelectMode, detectedSources, chosenSource, manualPipes, pipeDrawStart, pipeDrawPreview, equipmentLayerVisibility, selectedPipe]);

  function worldPointFromPointer(pointer: PointerInfo): { x: number; y: number } | null {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return null;
    const renderer = viewer.GetRenderer?.();
    const camera = viewer.GetCamera?.();
    const dom = renderer?.domElement as HTMLCanvasElement | undefined;
    if (!renderer || !camera || !dom) return null;

    const rect = dom.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const ndcX = ((pointer.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((pointer.clientY - rect.top) / rect.height) * 2 + 1;
    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };

    if ((camera as any).isOrthographicCamera) {
      const v = new three.Vector3(ndcX, ndcY, 0).unproject(camera);
      return { x: v.x + origin.x, y: v.y + origin.y };
    }

    const raycaster = new three.Raycaster();
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    const hit = new three.Vector3();
    const ok = raycaster.ray.intersectPlane(new three.Plane(new three.Vector3(0, 0, 1), 0), hit);
    if (!ok) return null;
    return { x: hit.x + origin.x, y: hit.y + origin.y };
  }

  function screenPointForDetector(det: Detector): { x: number; y: number } | null {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return null;
    const renderer = viewer.GetRenderer?.();
    const camera = viewer.GetCamera?.();
    const dom = renderer?.domElement as HTMLCanvasElement | undefined;
    if (!renderer || !camera || !dom) return null;

    const rect = dom.getBoundingClientRect();
    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
    const p = new three.Vector3(det.x - origin.x, det.y - origin.y, 0.72).project(camera);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return {
      x: rect.left + ((p.x + 1) * 0.5) * rect.width,
      y: rect.top + ((1 - p.y) * 0.5) * rect.height,
    };
  }

  function screenPointForWorld(x: number, y: number, z = 0.72): { x: number; y: number } | null {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return null;
    const renderer = viewer.GetRenderer?.();
    const camera = viewer.GetCamera?.();
    const dom = renderer?.domElement as HTMLCanvasElement | undefined;
    if (!renderer || !camera || !dom) return null;

    const rect = dom.getBoundingClientRect();
    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
    const p = new three.Vector3(x - origin.x, y - origin.y, z).project(camera);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return {
      x: rect.left + ((p.x + 1) * 0.5) * rect.width,
      y: rect.top + ((1 - p.y) * 0.5) * rect.height,
    };
  }

  function nearestDetectedSource(pointer: PointerInfo): PipeSource | null {
    let best: PipeSource | null = null;
    let bestDist2 = Number.POSITIVE_INFINITY;
    for (const src of detectedSources) {
      const p = screenPointForWorld(src.x, src.y, 0.53);
      if (!p) continue;
      const dx = p.x - pointer.clientX;
      const dy = p.y - pointer.clientY;
      const dist2 = dx * dx + dy * dy;
      if (dist2 < bestDist2) {
        bestDist2 = dist2;
        best = src;
      }
    }
    return bestDist2 <= 22 * 22 ? best : null;
  }

  function nearestDetectorId(pointer: PointerInfo): string | null {
    const candidates = selectedFloorId
      ? detectors.filter((d) => d.floor_plan_id === selectedFloorId)
      : detectors;
    let bestId: string | null = null;
    let bestDist2 = Number.POSITIVE_INFINITY;
    for (const d of candidates) {
      const p = screenPointForDetector(d);
      if (!p) continue;
      const dx = p.x - pointer.clientX;
      const dy = p.y - pointer.clientY;
      const dist2 = dx * dx + dy * dy;
      if (dist2 < bestDist2) {
        bestDist2 = dist2;
        bestId = d.id;
      }
    }
    return bestDist2 <= 16 * 16 ? bestId : null;
  }

  function detectorsInClientRect(x1: number, y1: number, x2: number, y2: number): string[] {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    const candidates = selectedFloorId
      ? detectors.filter((d) => d.floor_plan_id === selectedFloorId)
      : detectors;
    const out: string[] = [];
    for (const d of candidates) {
      const p = screenPointForDetector(d);
      if (!p) continue;
      if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
        out.push(d.id);
      }
    }
    return out;
  }

  function applySelectedIds(ids: string[]) {
    const uniq = Array.from(new Set(ids));
    setSelectedDetectorIds(uniq);
    setSelectedDetectorId(uniq[0] ?? null);
  }

  function addDetectorAtPointer(pointer: PointerInfo) {
    const world = worldPointFromPointer(pointer);
    if (!world) return;
    const created: Detector = {
      id: crypto.randomUUID(),
      project_id: projectId,
      x: world.x,
      y: world.y,
      z: 0,
      rotation_deg: 0,
      dtype: addType,
      locked: false,
      floor_plan_id: selectedFloorId || null,
    };
    setDetectors((prev) => [...prev, created]);
    applySelectedIds([created.id]);
    setHasManualChanges(true);
    setManualEditMsg(`Added ${addType} marker.`);
  }

  function deleteDetectorsMany(ids: string[]) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setDetectors((prev) => prev.filter((d) => !idSet.has(d.id)));
    applySelectedIds([]);
    setHasManualChanges(true);
    setManualEditMsg(ids.length === 1 ? "Marker deleted." : `${ids.length} markers deleted.`);
  }

  function deleteDetectorById(id: string) {
    deleteDetectorsMany([id]);
  }

  // ── Pipe selection + edit helpers ──
  function nearestPipe(pointer: PointerInfo): { kind: "auto" | "manual"; index: number } | null {
    let bestKey: { kind: "auto" | "manual"; index: number } | null = null;
    let bestDist2 = Number.POSITIVE_INFINITY;
    const HIT_THRESHOLD_PX = 10;

    function distPxToSegment(ax: number, ay: number, bx: number, by: number): number {
      const sa = screenPointForWorld(ax, ay, 0.5);
      const sb = screenPointForWorld(bx, by, 0.5);
      if (!sa || !sb) return Number.POSITIVE_INFINITY;
      const px = pointer.clientX;
      const py = pointer.clientY;
      const dx = sb.x - sa.x;
      const dy = sb.y - sa.y;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) {
        const ex = px - sa.x;
        const ey = py - sa.y;
        return ex * ex + ey * ey;
      }
      let t = ((px - sa.x) * dx + (py - sa.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = sa.x + t * dx;
      const cy = sa.y + t * dy;
      const ex = px - cx;
      const ey = py - cy;
      return ex * ex + ey * ey;
    }

    if (pipesData?.pipes) {
      for (let i = 0; i < pipesData.pipes.length; i++) {
        const pipe = pipesData.pipes[i];
        const d2 = distPxToSegment(pipe.from[0], pipe.from[1], pipe.to[0], pipe.to[1]);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestKey = { kind: "auto", index: i };
        }
      }
    }
    for (let i = 0; i < manualPipes.length; i++) {
      const mp = manualPipes[i];
      const d2 = distPxToSegment(mp.from[0], mp.from[1], mp.to[0], mp.to[1]);
      if (d2 < bestDist2) {
        bestDist2 = d2;
        bestKey = { kind: "manual", index: i };
      }
    }
    return bestDist2 <= HIT_THRESHOLD_PX * HIT_THRESHOLD_PX ? bestKey : null;
  }

  function deleteSelectedPipe() {
    if (!selectedPipe) return;
    if (selectedPipe.kind === "manual") {
      setManualPipes((prev) => prev.filter((_, i) => i !== selectedPipe.index));
    } else {
      setPipesData((prev) => {
        if (!prev) return prev;
        const nextPipes = prev.pipes.filter((_, i) => i !== selectedPipe.index);
        return { ...prev, pipes: nextPipes };
      });
      setHasManualChanges(true);
      setPipesModified(true);
    }
    setSelectedPipe(null);
    setManualEditMsg("Pipe deleted.");
  }

  function changeSelectedPipeDiameter(diameterMm: number) {
    if (!selectedPipe) return;
    const dia = `${diameterMm}mm`;
    if (selectedPipe.kind === "manual") {
      setManualPipes((prev) =>
        prev.map((p, i) => (i === selectedPipe.index ? { ...p, diameter: dia } : p)),
      );
    } else {
      setPipesData((prev) => {
        if (!prev) return prev;
        const nextPipes = prev.pipes.map((p, i) =>
          i === selectedPipe.index ? { ...p, diameter: dia } : p,
        );
        return { ...prev, pipes: nextPipes };
      });
      setHasManualChanges(true);
      setPipesModified(true);
    }
  }

  function getSelectedPipeData(): { from: [number, number]; to: [number, number]; diameter: string } | null {
    if (!selectedPipe) return null;
    if (selectedPipe.kind === "manual") return manualPipes[selectedPipe.index] ?? null;
    const p = pipesData?.pipes?.[selectedPipe.index];
    return p ? { from: p.from, to: p.to, diameter: p.diameter } : null;
  }

  async function saveManualEdits() {
    if (!canEdit) return;
    setIsSavingEdits(true);
    setManualEditMsg(null);
    try {
      const token = getToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(apiUrl(`/api/projects/${projectId}/bulk_save`), {
        method: "PUT",
        headers,
        body: JSON.stringify({
          detectors: detectors.map((d) => ({
            id: d.id,
            x: d.x,
            y: d.y,
            z: Number(d.z) || 0,
            rotation_deg: Number(d.rotation_deg) || 0,
            dtype: d.dtype,
            locked: !!d.locked,
            floor_plan_id: d.floor_plan_id ?? null,
          })),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Save failed (${res.status})`);
      }
      const payload = await res.json();
      if (Array.isArray(payload?.detectors)) {
        setDetectors(payload.detectors as Detector[]);
      }
      setHasManualChanges(false);
      setManualEditMsg("Manual edits saved.");
    } catch (e: any) {
      console.error("Manual save failed", e);
      setManualEditMsg(e?.message || "Failed to save manual edits.");
    } finally {
      setIsSavingEdits(false);
    }
  }

  useEffect(() => {
    if (tool === "pan") return;
    const el = containerRef.current;
    if (!el) return;

    const onPointerDown = (evt: PointerEvent) => {
      if (!canEdit) return;
      // Ignore clicks that originate inside a UI overlay (panels, dropdowns, etc.)
      const tgt = evt.target as Element | null;
      if (tgt && tgt.closest && tgt.closest("[data-ui-overlay]")) return;
      const pointer = { clientX: evt.clientX, clientY: evt.clientY };
      if (tool === "add") {
        evt.preventDefault();
        evt.stopPropagation();
        addDetectorAtPointer(pointer);
        return;
      }
      const hitId = nearestDetectorId(pointer);
      if (tool === "erase") {
        evt.preventDefault();
        evt.stopPropagation();
        if (hitId) {
          deleteDetectorById(hitId);
          return;
        }
        // No detector under cursor; try to erase a pipe instead.
        const hitPipe = nearestPipe(pointer);
        if (hitPipe) {
          if (hitPipe.kind === "manual") {
            setManualPipes((prev) => prev.filter((_, i) => i !== hitPipe.index));
          } else {
            setPipesData((prev) => {
              if (!prev) return prev;
              return { ...prev, pipes: prev.pipes.filter((_, i) => i !== hitPipe.index) };
            });
            setHasManualChanges(true);
            setPipesModified(true);
          }
          if (selectedPipe && selectedPipe.kind === hitPipe.kind && selectedPipe.index === hitPipe.index) {
            setSelectedPipe(null);
          }
          setManualEditMsg("Pipe deleted.");
        }
        return;
      }
      if (tool === "select") {
        const additive = evt.shiftKey || evt.ctrlKey || evt.metaKey;
        if (!hitId) {
          // No detector under cursor — try a pipe before falling back to marquee.
          const hitPipe = nearestPipe(pointer);
          if (hitPipe) {
            evt.preventDefault();
            evt.stopPropagation();
            applySelectedIds([]);
            setSelectedPipe(hitPipe);
            return;
          }
          evt.preventDefault();
          evt.stopPropagation();
          const rect = el.getBoundingClientRect();
          marqueeRef.current = { startX: evt.clientX, startY: evt.clientY, additive };
          setMarqueeRect({ left: evt.clientX - rect.left, top: evt.clientY - rect.top, width: 0, height: 0 });
          return;
        }
        evt.preventDefault();
        evt.stopPropagation();
        // Selecting a detector clears any selected pipe.
        setSelectedPipe(null);

        if (additive) {
          setSelectedDetectorIds((prev) => {
            const exists = prev.includes(hitId);
            const next = exists ? prev.filter((id) => id !== hitId) : [...prev, hitId];
            setSelectedDetectorId(next[0] ?? null);
            return next;
          });
          return;
        }

        const dragIds = selectedDetectorIds.includes(hitId) && selectedDetectorIds.length > 1
          ? selectedDetectorIds
          : [hitId];
        applySelectedIds(dragIds);
        setDraggingDetectorId(hitId);

        const world = worldPointFromPointer(pointer);
        if (!world) return;
        const startById: Record<string, { x: number; y: number }> = {};
        for (const d of detectors) {
          if (dragIds.includes(d.id)) {
            startById[d.id] = { x: d.x, y: d.y };
          }
        }
        groupDragRef.current = { ids: dragIds, startWorld: world, startById };
      }
    };

    const onPointerMove = (evt: PointerEvent) => {
      if (!canEdit || tool !== "select") return;

      if (marqueeRef.current) {
        evt.preventDefault();
        evt.stopPropagation();
        const rect = el.getBoundingClientRect();
        const { startX, startY } = marqueeRef.current;
        setMarqueeRect({
          left: Math.min(startX, evt.clientX) - rect.left,
          top: Math.min(startY, evt.clientY) - rect.top,
          width: Math.abs(evt.clientX - startX),
          height: Math.abs(evt.clientY - startY),
        });
        return;
      }

      if (!groupDragRef.current || !draggingDetectorId) return;
      const world = worldPointFromPointer({ clientX: evt.clientX, clientY: evt.clientY });
      if (!world) return;
      evt.preventDefault();
      evt.stopPropagation();

      const drag = groupDragRef.current;
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      setDetectors((prev) => prev.map((d) => {
        const start = drag.startById[d.id];
        return start ? { ...d, x: start.x + dx, y: start.y + dy } : d;
      }));
      setHasManualChanges(true);
    };

    const onPointerUp = (evt: PointerEvent) => {
      if (tool === "select" && marqueeRef.current) {
        const { startX, startY, additive } = marqueeRef.current;
        const width = Math.abs(evt.clientX - startX);
        const height = Math.abs(evt.clientY - startY);
        const tinyClick = width < 4 && height < 4;

        if (tinyClick) {
          if (!additive) applySelectedIds([]);
        } else {
          const picked = detectorsInClientRect(startX, startY, evt.clientX, evt.clientY);
          if (additive) {
            applySelectedIds([...selectedDetectorIds, ...picked]);
          } else {
            applySelectedIds(picked);
          }
        }

        marqueeRef.current = null;
        setMarqueeRect(null);
      }

      groupDragRef.current = null;
      setDraggingDetectorId(null);
    };

    el.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, { passive: false, capture: true });
    window.addEventListener("pointerup", onPointerUp, true);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
    };
  }, [tool, addType, draggingDetectorId, detectors, selectedFloorId, canEdit, selectedDetectorIds]);

  useEffect(() => {
    if (!sourceSelectMode) return;
    const el = containerRef.current;
    if (!el) return;

    const onPointerDown = (evt: PointerEvent) => {
      if (!canEdit || isRoutingPipes) return;
      const tgt = evt.target as Element | null;
      if (tgt && tgt.closest && tgt.closest("[data-ui-overlay]")) return;
      evt.preventDefault();
      evt.stopPropagation();

      const pointer = { clientX: evt.clientX, clientY: evt.clientY };
      const hitSource = nearestDetectedSource(pointer);
      const world = worldPointFromPointer(pointer);
      const source = hitSource || (world ? { x: world.x, y: world.y } : null);
      if (!source) {
        setPipeMsg("Unable to pick source at clicked location.");
        return;
      }
      setChosenSource(source);
      setPipeMsg(`Source selected at (${source.x.toFixed(1)}, ${source.y.toFixed(1)}). Click Route with Source.`);
    };

    el.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [sourceSelectMode, detectedSources, canEdit, isRoutingPipes, selectedFloorId]);

  useEffect(() => {
    applySelectedIds([]);
  }, [selectedFloorId]);

  useEffect(() => {
    const onKeyDown = (evt: KeyboardEvent) => {
      if (!canEdit) return;
      if (evt.key !== "Delete" && evt.key !== "Backspace") return;
      if (selectedDetectorIds.length > 0) {
        evt.preventDefault();
        deleteDetectorsMany(selectedDetectorIds);
        return;
      }
      if (selectedPipe) {
        evt.preventDefault();
        deleteSelectedPipe();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedDetectorIds, selectedPipe, manualPipes, pipesData, canEdit]);

  async function autoPlaceEquipment(dtype: string) {
    if (!selectedFloorId) {
      setAutoPlaceMsg("Select a floor plan first.");
      return;
    }
    setIsAutoPlacing(dtype);
    setAutoPlaceMsg(null);
    try {
      const token = getToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(
        apiUrl(`/api/projects/${projectId}/floor_plans/${selectedFloorId}/auto_place`),
        { method: "POST", headers, body: JSON.stringify({ equipment_type: dtype }) },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Auto-place failed (${res.status})`);
      }
      const placed: Detector[] = await res.json();

      // Merge like the editor: replace this type's detectors with the new results.
      setDetectors(prev => {
        if (dtype === "mcp_hooter") {
          return [
            ...prev.filter(d => d.dtype !== "mcb" && d.dtype !== "hooter"),
            ...placed.filter(d => d.dtype === "mcb" || d.dtype === "hooter"),
          ];
        }
        return [
          ...prev.filter(d => d.dtype !== dtype),
          ...placed.filter(d => d.dtype === dtype),
        ];
      });
      const count = dtype === "mcp_hooter"
        ? placed.filter(d => d.dtype === "mcb" || d.dtype === "hooter").length
        : placed.filter(d => d.dtype === dtype).length;
      setAutoPlaceMsg(`Placed ${count} ${dtype === "mcp_hooter" ? "MCP/Hooter" : dtype} item${count === 1 ? "" : "s"}.`);
    } catch (e: any) {
      console.error("Auto-place failed", e);
      setAutoPlaceMsg(e?.message || "Auto-place failed.");
    } finally {
      setIsAutoPlacing(null);
    }
  }

  async function routePipesFromSource(source: PipeSource | null) {
    if (!canEdit) return;
    setIsRoutingPipes(true);
    try {
      const token = getToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const routeUrl = selectedFloorId
        ? `/api/projects/${projectId}/floor_plans/${selectedFloorId}/route_pipes`
        : `/api/projects/${projectId}/route_pipes`;
      const routeRes = await fetch(apiUrl(routeUrl), {
        method: "POST",
        headers,
        body: source ? JSON.stringify({ source: { x: source.x, y: source.y } }) : undefined,
      });
      if (!routeRes.ok) {
        const text = await routeRes.text();
        throw new Error(text || `Pipe routing failed (${routeRes.status})`);
      }

      await loadPipesData(selectedFloorId || null);
      setShowPipes(true);
      setChosenSource(source);
      setSourceSelectMode(false);
      setDetectedSources([]);
      setPipeMsg("Pipes routed successfully.");
    } catch (e: any) {
      setPipeMsg(e?.message || "Failed to route pipes.");
    } finally {
      setIsRoutingPipes(false);
    }
  }

  async function routeWithSelectedSource() {
    if (!chosenSource) {
      setPipeMsg("Select a source first, then click Route with Source.");
      return;
    }
    await routePipesFromSource(chosenSource);
  }

  async function clearCurrentPipes() {
    if (!canEdit) return;
    if (!hasPipeData) {
      setPipeMsg("No pipes to clear in the current view.");
      return;
    }

    setIsClearingPipes(true);
    setPipeMsg(null);
    try {
      const token = getToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const clearUrl = selectedFloorId
        ? `/api/projects/${projectId}/floor_plans/${selectedFloorId}/sprinkler_pipes`
        : `/api/projects/${projectId}/sprinkler_pipes`;
      const res = await fetch(apiUrl(clearUrl), { method: "DELETE", headers });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Failed to clear pipes (${res.status})`);
      }

      setPipesData({ pipes: [], sources: [] });
      setSourceSelectMode(false);
      setDetectedSources([]);
      setChosenSource(null);
      setPipeMsg(selectedFloorId ? "Cleared pipes for selected block." : "Cleared project pipes.");
    } catch (e: any) {
      setPipeMsg(e?.message || "Failed to clear pipes.");
    } finally {
      setIsClearingPipes(false);
    }
  }

  async function drawSprinklerPipes() {
    if (!canEdit) return;

    if (sourceSelectMode) {
      setSourceSelectMode(false);
      setDetectedSources([]);
      setChosenSource(null);
      setPipeMsg("Source selection cancelled.");
      return;
    }

    setIsDetectingSources(true);
    setPipeMsg(null);
    try {
      const token = getToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const detectRes = await fetch(apiUrl(`/api/projects/${projectId}/detect_sources`), { headers });
      const sources: PipeSource[] = detectRes.ok ? await detectRes.json() : [];

      setDetectedSources(Array.isArray(sources) ? sources : []);
      setChosenSource(null);
      setShowPipes(true);
      setSourceSelectMode(true);

      if (sources.length === 1) {
        const only = sources[0];
        setChosenSource(only);
        setPipeMsg("One source detected and selected. Click Route with Source.");
        return;
      }

      setPipeMsg(
        sources.length > 0
          ? "Select a source on drawing, then click Route with Source."
          : "No source detected. Click anywhere on drawing to pick a custom source.",
      );
    } catch (e: any) {
      setPipeMsg(e?.message || "Failed to detect sources.");
      setSourceSelectMode(false);
      setDetectedSources([]);
    } finally {
      setIsDetectingSources(false);
    }
  }

  function colorToHex(c: number) {
    const three = threeRef.current;
    if (three) {
      return "#" + new three.Color(c).getHexString();
    }
    return "#ffffff";
  }

  // ── Export DXF ──
  // Saves any unsaved manual edits, asks the backend to regenerate the
  // output DXF (which embeds all detectors and pipes as proper DXF blocks),
  // then downloads that file.
  async function exportDxf() {
    if (!projectId) return;
    setIsExportingDxf(true);
    try {
      const token = getToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      // 1) Persist any pending manual detector edits so /save sees them.
      if (hasManualChanges) {
        const bulkRes = await fetch(apiUrl(`/api/projects/${projectId}/bulk_save`), {
          method: "PUT",
          headers,
          body: JSON.stringify({
            detectors: detectors.map((d) => ({
              id: d.id,
              x: d.x,
              y: d.y,
              z: Number(d.z) || 0,
              rotation_deg: Number(d.rotation_deg) || 0,
              dtype: d.dtype,
              locked: !!d.locked,
              floor_plan_id: d.floor_plan_id ?? null,
            })),
          }),
        });
        if (!bulkRes.ok) {
          const text = await bulkRes.text();
          throw new Error(text || `Failed to save edits (${bulkRes.status})`);
        }
        const bulkPayload = await bulkRes.json();
        if (Array.isArray(bulkPayload?.detectors)) {
          setDetectors(bulkPayload.detectors as Detector[]);
        }
        setHasManualChanges(false);
      }

      // 2) Persist manually drawn pipes (if any) so /save embeds them.
      //    Merge with any existing auto-routed pipes since the PUT replaces all.
      //    Also fire when the user edited/deleted auto pipes (pipesModified).
      if (manualPipes.length > 0 || pipesModified) {
        try {
          const mergedPipes = [
            ...((pipesData?.pipes ?? []).map((p) => ({
              from: p.from,
              to: p.to,
              diameter: p.diameter,
            }))),
            ...manualPipes.map((p) => ({
              from: p.from,
              to: p.to,
              diameter: p.diameter,
            })),
          ];
          await fetch(apiUrl(`/api/projects/${projectId}/sprinkler_pipes`), {
            method: "PUT",
            headers,
            body: JSON.stringify({
              pipes: mergedPipes,
              sources: pipesData?.sources ?? [],
            }),
          });
          setPipesModified(false);
        } catch (e) {
          // Non-fatal: continue with whatever the backend already has stored.
          console.warn("Failed to upload manual pipes prior to export:", e);
        }
      }

      // 3) Trigger backend to regenerate the output DXF with current state.
      const saveRes = await fetch(apiUrl(`/api/projects/${projectId}/save`), {
        method: "POST",
        headers,
      });
      if (!saveRes.ok) {
        const text = await saveRes.text();
        throw new Error(text || `Failed to generate output DXF (${saveRes.status})`);
      }
      const proj = await saveRes.json();
      const outputDxf = proj?.files?.output_dxf as string | undefined;
      if (!outputDxf) {
        throw new Error("Backend did not produce an output DXF.");
      }

      // 4) Download the freshly generated DXF.
      const fileRes = await fetch(apiUrl(outputDxf), { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!fileRes.ok) {
        throw new Error(`Failed to download output DXF (${fileRes.status})`);
      }
      const blob = await fileRes.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${projectName || "drawing"}_with_equipment.dxf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      console.error("DXF export failed", e);
      setManualEditMsg(e?.message || "Failed to export DXF.");
    } finally {
      setIsExportingDxf(false);
    }
  }

  // ── Manual pipe draw pointer handler ──
  useEffect(() => {
    if (tool !== "draw-pipe") return;
    const el = containerRef.current;
    if (!el) return;

    const onPointerDown = (evt: PointerEvent) => {
      if (!canEdit) return;
      const tgt = evt.target as Element | null;
      if (tgt && tgt.closest && tgt.closest("[data-ui-overlay]")) return;
      evt.preventDefault();
      evt.stopPropagation();
      const world = worldPointFromPointer({ clientX: evt.clientX, clientY: evt.clientY });
      if (!world) return;

      if (!pipeDrawStart) {
        // First click: anchor start point
        setPipeDrawStart(world);
        setPipeDrawPreview(world);
      } else {
        // Second click: commit the pipe segment
        const seg = {
          from: [pipeDrawStart.x, pipeDrawStart.y] as [number, number],
          to: [world.x, world.y] as [number, number],
          diameter: `${pipeDrawDiameter}mm`,
        };
        setManualPipes((prev) => [...prev, seg]);
        // Chain: new start is current endpoint for continuous drawing
        setPipeDrawStart(world);
        setPipeDrawPreview(world);
      }
    };

    const onPointerMove = (evt: PointerEvent) => {
      if (!pipeDrawStart) return;
      const world = worldPointFromPointer({ clientX: evt.clientX, clientY: evt.clientY });
      if (world) setPipeDrawPreview(world);
    };

    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") {
        setPipeDrawStart(null);
        setPipeDrawPreview(null);
      }
    };

    el.addEventListener("pointerdown", onPointerDown, true);
    el.addEventListener("pointermove", onPointerMove);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown, true);
      el.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [tool, pipeDrawStart, pipeDrawDiameter, canEdit]);

  return (
    <main
      style={{
        position: "fixed", inset: 0,
        display: "flex", flexDirection: "column",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        background: "#1e1e2e", color: "#cdd6f4",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          borderBottom: "1px solid #313244",
          background: "#181825",
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 16px 6px",
            borderBottom: "1px solid #242438",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <a
              href={`/p/${projectId}`}
              style={{ color: "#cba6f7", textDecoration: "none", fontSize: 13 }}
            >
              ← Back to editor
            </a>
            <h1 style={{ fontSize: 15, fontWeight: 600, color: "#cba6f7", margin: 0 }}>
              📐 DXF Editor
            </h1>
            {projectName ? (
              <span style={{ fontSize: 12, color: "#a6adc8" }}>— {projectName}</span>
            ) : null}
          </div>
          <div style={{ fontSize: 12, color: "#a6adc8" }}>
            {canEdit ? `Mode: ${tool.toUpperCase()}` : "View only"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, padding: "6px 16px 0" }}>
          <button onClick={() => setRibbonTab("home")} style={ribbonTabBtn(ribbonTab === "home")}>Home</button>
          <button onClick={() => setRibbonTab("insert")} style={ribbonTabBtn(ribbonTab === "insert")}>Insert</button>
          <button onClick={() => setRibbonTab("automation")} style={ribbonTabBtn(ribbonTab === "automation")}>Automation</button>
          <button onClick={() => setRibbonTab("view")} style={ribbonTabBtn(ribbonTab === "view")}>View</button>
        </div>

        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "stretch",
            padding: "8px 16px 10px",
            background: "#1d1d31",
            borderTop: "1px solid #242438",
          }}
        >
          {ribbonTab === "home" ? (
            <>
              {canEdit ? (
                <div style={ribbonGroupStyle}>
                  <div style={ribbonGroupTitleStyle}>Tools</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={() => setTool("pan")} style={{ ...btnStyle, background: tool === "pan" ? "#585b70" : btnStyle.background }}>Pan</button>
                    <button onClick={() => setTool("select")} style={{ ...btnStyle, background: tool === "select" ? "#585b70" : btnStyle.background }}>Select</button>
                    <button onClick={() => setTool("add")} style={{ ...btnStyle, background: tool === "add" ? "#585b70" : btnStyle.background }}>Add</button>
                    <button onClick={() => setTool("erase")} style={{ ...btnStyle, background: tool === "erase" ? "#585b70" : btnStyle.background }}>Erase</button>
                    <button
                      onClick={saveManualEdits}
                      disabled={!hasManualChanges || isSavingEdits}
                      style={{
                        ...btnStyle,
                        background: "#22c55e",
                        borderColor: "#16a34a",
                        color: "#08130b",
                        opacity: (!hasManualChanges || isSavingEdits) ? 0.6 : 1,
                        cursor: (!hasManualChanges || isSavingEdits) ? "not-allowed" : "pointer",
                      }}
                    >
                      {isSavingEdits ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              ) : null}

              {canEdit ? (
                <div style={ribbonGroupStyle}>
                  <div style={ribbonGroupTitleStyle}>Placement</div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <select
                      value={addType}
                      onChange={(e) => setAddType(e.target.value)}
                      style={{
                        background: "#313244",
                        color: "#cdd6f4",
                        border: "1px solid #45475a",
                        borderRadius: 6,
                        padding: "6px 10px",
                        fontSize: 13,
                      }}
                    >
                      {ADD_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => deleteDetectorsMany(selectedDetectorIds.length > 0 ? selectedDetectorIds : (selectedDetectorId ? [selectedDetectorId] : []))}
                      disabled={selectedDetectorIds.length === 0 && !selectedDetectorId}
                      style={{
                        ...btnStyle,
                        opacity: (selectedDetectorIds.length > 0 || !!selectedDetectorId) ? 1 : 0.5,
                        cursor: (selectedDetectorIds.length > 0 || !!selectedDetectorId) ? "pointer" : "not-allowed",
                      }}
                    >
                      Delete Selected{selectedDetectorIds.length > 1 ? ` (${selectedDetectorIds.length})` : ""}
                    </button>
                    <button
                      onClick={saveManualEdits}
                      disabled={!hasManualChanges || isSavingEdits}
                      style={{
                        ...btnStyle,
                        background: "#22c55e",
                        borderColor: "#16a34a",
                        color: "#08130b",
                        opacity: (!hasManualChanges || isSavingEdits) ? 0.6 : 1,
                        cursor: (!hasManualChanges || isSavingEdits) ? "not-allowed" : "pointer",
                      }}
                    >
                      {isSavingEdits ? "Saving..." : hasManualChanges ? "Save Edits" : "Saved"}
                    </button>
                    {selectedDetectorIds.length > 0 ? (
                      <span style={{ fontSize: 11, color: "#a6adc8" }}>Selected: {selectedDetectorIds.length}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div style={ribbonGroupStyle}>
                <div style={ribbonGroupTitleStyle}>Quick View</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button onClick={fitView} style={btnStyle}>⊡ Fit</button>
                  <button onClick={() => setShowLayers((v) => !v)} style={btnStyle}>☰ Layers ({layers.length})</button>
                </div>
              </div>

              <div style={ribbonGroupStyle}>
                <div style={ribbonGroupTitleStyle}>Export</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    onClick={exportDxf}
                    disabled={!dxfUrl || isExportingDxf}
                    style={{
                      ...btnStyle,
                      background: "#7c3aed",
                      borderColor: "#6d28d9",
                      color: "#fff",
                      opacity: (!dxfUrl || isExportingDxf) ? 0.6 : 1,
                      cursor: (!dxfUrl || isExportingDxf) ? "not-allowed" : "pointer",
                    }}
                  >
                    {isExportingDxf ? "Exporting..." : "⬇ Export DXF"}
                  </button>
                </div>
              </div>

            </>
          ) : null}

          {ribbonTab === "insert" ? (
            <>
              {canEdit ? (
                <div style={ribbonGroupStyle}>
                  <div style={ribbonGroupTitleStyle}>Insert Equipment</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 8, minWidth: 520 }}>
                    {ADD_TYPE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => {
                          setAddType(opt.value);
                          setTool("add");
                        }}
                        style={{
                          ...insertToolTileStyle,
                          borderColor: addType === opt.value ? "#89b4fa" : "#45475a",
                          background: addType === opt.value ? "#3a3a5c" : "#313244",
                        }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", height: 28, marginBottom: 4 }}>
                          {renderInsertToolPreview(opt.value)}
                        </span>
                        <span style={{ fontSize: 11, textAlign: "center", lineHeight: 1.15 }}>{opt.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={ribbonGroupStyle}>
                  <div style={ribbonGroupTitleStyle}>Insert</div>
                  <div style={{ fontSize: 12, color: "#a6adc8" }}>Viewer role cannot insert symbols.</div>
                </div>
              )}

              {canEdit ? (
                <div style={ribbonGroupStyle}>
                  <div style={ribbonGroupTitleStyle}>Draw Pipe</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 240 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12, color: "#a6adc8" }}>Diameter:</span>
                      <select
                        value={pipeDrawDiameter}
                        onChange={(e) => setPipeDrawDiameter(Number(e.target.value))}
                        style={{
                          background: "#313244", color: "#cdd6f4",
                          border: "1px solid #45475a", borderRadius: 6,
                          padding: "5px 8px", fontSize: 13,
                        }}
                      >
                        {PIPE_DIAMETERS_MM.map((d) => (
                          <option key={d} value={d}>{d} mm</option>
                        ))}
                      </select>
                      <button
                        onClick={() => {
                          if (tool === "draw-pipe") {
                            setTool("pan");
                            setPipeDrawStart(null);
                            setPipeDrawPreview(null);
                          } else {
                            setTool("draw-pipe");
                          }
                        }}
                        style={{
                          ...btnStyle,
                          background: tool === "draw-pipe" ? "#3b82f6" : btnStyle.background,
                          borderColor: tool === "draw-pipe" ? "#2563eb" : "#45475a",
                          color: tool === "draw-pipe" ? "#fff" : btnStyle.color,
                        }}
                      >
                        {tool === "draw-pipe" ? "✏ Drawing (Esc to stop)" : "✏ Draw Pipe"}
                      </button>
                    </div>
                    {tool === "draw-pipe" ? (
                      <div style={{ fontSize: 11, color: "#93c5fd", lineHeight: 1.4 }}>
                        {pipeDrawStart
                          ? "Click to end segment. Click again to chain. Esc to finish."
                          : "Click on drawing to start a pipe segment."}
                      </div>
                    ) : null}
                    {manualPipes.length > 0 ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 11, color: "#a6adc8" }}>{manualPipes.length} manual pipe{manualPipes.length !== 1 ? "s" : ""}</span>
                        <button
                          onClick={() => {
                            setManualPipes([]);
                            setPipeDrawStart(null);
                            setPipeDrawPreview(null);
                          }}
                          style={{ ...btnStyle, background: "#991b1b", borderColor: "#7f1d1d", color: "#fff", padding: "3px 8px", fontSize: 11 }}
                        >
                          Clear
                        </button>
                        <button
                          onClick={() => setManualPipes((p) => p.slice(0, -1))}
                          style={{ ...btnStyle, padding: "3px 8px", fontSize: 11 }}
                        >
                          Undo Last
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {ribbonTab === "automation" ? (
            <>
              {canEdit ? (
                <div style={ribbonGroupStyle}>
                  <div style={ribbonGroupTitleStyle}>Auto-place Equipment</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 320 }}>
                    {!selectedFloorId ? (
                      <div style={{ fontSize: 11, color: "#6c7086" }}>
                        Select a floor first to run automation.
                      </div>
                    ) : null}
                    {(() => {
                      const counts: Record<string, number> = {};
                      for (const d of detectors) {
                        if (d.floor_plan_id === selectedFloorId) {
                          counts[d.dtype] = (counts[d.dtype] || 0) + 1;
                        }
                      }
                      return EQUIPMENT_BUTTONS.map((btn) => {
                        const placed = btn.key === "mcp_hooter"
                          ? (counts.mcb || 0) + (counts.hooter || 0)
                          : (counts[btn.key] || 0);
                        const isPlacing = isAutoPlacing === btn.key;
                        const disabled = !selectedFloorId || !!isAutoPlacing;
                        return (
                          <button
                            key={btn.key}
                            onClick={() => autoPlaceEquipment(btn.key)}
                            disabled={disabled}
                            title={selectedFloorId ? `Auto-place ${btn.label}` : "Select a floor plan first"}
                            style={{
                              display: "flex", alignItems: "center", gap: 8,
                              padding: "8px 10px", fontSize: 12,
                              borderRadius: 6,
                              border: "1px solid #45475a",
                              background: isPlacing ? "#3a3a5c" : "#1e1e2e",
                              color: disabled && !isPlacing ? "#6c7086" : "#cdd6f4",
                              cursor: disabled ? "not-allowed" : "pointer",
                              opacity: disabled && !isPlacing ? 0.6 : 1,
                              textAlign: "left",
                            }}
                          >
                            <span
                              style={{
                                width: 10, height: 10, borderRadius: "50%",
                                background: btn.color, flexShrink: 0,
                              }}
                            />
                            <span style={{ flex: 1 }}>{btn.label}</span>
                            <span style={{ fontSize: 10, color: "#6c7086" }}>
                              {isPlacing ? "Placing..." : placed > 0 ? `${placed} placed` : ""}
                            </span>
                          </button>
                        );
                      });
                    })()}
                    {autoPlaceMsg ? (
                      <div style={{ fontSize: 11, color: "#a6adc8", paddingTop: 2, lineHeight: 1.4 }}>
                        {autoPlaceMsg}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div style={ribbonGroupStyle}>
                  <div style={ribbonGroupTitleStyle}>Automation</div>
                  <div style={{ fontSize: 12, color: "#a6adc8" }}>Viewer role cannot run automation.</div>
                </div>
              )}

              <div style={ribbonGroupStyle}>
                <div style={ribbonGroupTitleStyle}>Sprinkler Pipes</div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", minWidth: 260 }}>
                  <button
                    onClick={drawSprinklerPipes}
                    disabled={!canEdit || isRoutingPipes || isDetectingSources || isClearingPipes}
                    style={{
                      ...btnStyle,
                      background: sourceSelectMode ? "#f59e0b" : "#dc2626",
                      borderColor: "#b91c1c",
                      color: "#fff",
                      opacity: !canEdit || isRoutingPipes || isDetectingSources || isClearingPipes ? 0.6 : 1,
                      cursor: !canEdit || isRoutingPipes || isDetectingSources || isClearingPipes ? "not-allowed" : "pointer",
                    }}
                  >
                    {isDetectingSources ? "Detecting..." : isRoutingPipes ? "Connecting..." : sourceSelectMode ? "Cancel Source" : "Connect Pipes"}
                  </button>
                  <button
                    onClick={routeWithSelectedSource}
                    disabled={!canEdit || !sourceSelectMode || !chosenSource || isRoutingPipes || isDetectingSources || isClearingPipes}
                    style={{
                      ...btnStyle,
                      background: sourceSelectMode && chosenSource ? "#16a34a" : btnStyle.background,
                      borderColor: sourceSelectMode && chosenSource ? "#15803d" : "#45475a",
                      color: sourceSelectMode && chosenSource ? "#fff" : btnStyle.color,
                      opacity: !canEdit || !sourceSelectMode || !chosenSource || isRoutingPipes || isDetectingSources || isClearingPipes ? 0.6 : 1,
                      cursor: !canEdit || !sourceSelectMode || !chosenSource || isRoutingPipes || isDetectingSources || isClearingPipes ? "not-allowed" : "pointer",
                    }}
                  >
                    Route with Source
                  </button>
                  <button
                    onClick={clearCurrentPipes}
                    disabled={!canEdit || !hasPipeData || isRoutingPipes || isDetectingSources || isClearingPipes}
                    style={{
                      ...btnStyle,
                      background: "#991b1b",
                      borderColor: "#7f1d1d",
                      color: "#fff",
                      opacity: !canEdit || !hasPipeData || isRoutingPipes || isDetectingSources || isClearingPipes ? 0.6 : 1,
                      cursor: !canEdit || !hasPipeData || isRoutingPipes || isDetectingSources || isClearingPipes ? "not-allowed" : "pointer",
                    }}
                    title={hasPipeData ? (selectedFloorId ? "Clear pipes for selected block" : "Clear project pipes") : "No pipes to clear"}
                  >
                    {isClearingPipes ? "Clearing..." : selectedFloorId ? "Clear Pipes (Block)" : "Clear Pipes"}
                  </button>
                  <span style={{ fontSize: 11, color: "#a6adc8" }}>
                    {pipesData?.pipes?.length ? `${pipesData.pipes.length} segment${pipesData.pipes.length === 1 ? "" : "s"}` : "No pipes yet"}
                  </span>
                </div>
              </div>
            </>
          ) : null}

          {ribbonTab === "view" ? (
            <>
              <div style={ribbonGroupStyle}>
                <div style={ribbonGroupTitleStyle}>Panels</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button onClick={() => setShowLayers((v) => !v)} style={btnStyle}>☰ Layers ({layers.length})</button>
                  <button onClick={() => setShowBlocks((v) => !v)} style={btnStyle}>▦ Blocks ({blocks.length})</button>
                  {floorPlans.length > 0 ? (
                    <button
                      onClick={() => setShowFloors((v) => !v)}
                      style={{
                        ...btnStyle,
                        background: showFloors ? "#3a3a5c" : btnStyle.background,
                        borderColor: showFloors ? "#89b4fa" : "#45475a",
                      }}
                    >
                      🏢 Floors ({floorPlans.length})
                    </button>
                  ) : null}
                </div>
              </div>

              <div style={ribbonGroupStyle}>
                <div style={ribbonGroupTitleStyle}>Display</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button onClick={fitView} style={btnStyle}>⊡ Fit</button>
                  <button onClick={() => setBgIdx((i) => (i + 1) % bgColors.length)} style={btnStyle}>◑ BG</button>
                </div>
              </div>

            </>
          ) : null}
        </div>
      </header>

      <div
        ref={containerRef}
        style={{ flex: 1, position: "relative", overflow: "hidden" }}
      >

        {canEdit && (tool !== "pan" || sourceSelectMode) ? (
          <div style={{
            position: "absolute",
            top: 10,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 14,
            background: "rgba(24,24,37,0.88)",
            border: "1px solid #45475a",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12,
            color: "#cdd6f4",
            pointerEvents: "none",
          }}>
            {sourceSelectMode
              ? (chosenSource
                ? `Pipe source selected at (${chosenSource.x.toFixed(1)}, ${chosenSource.y.toFixed(1)}). Click Route with Source.`
                : "Pipe source mode: click detected source, or click anywhere to place custom source.")
              : tool === "add"
              ? `Add mode: click to place ${addType.replace("_", " ")}.`
              : tool === "erase"
                ? "Erase mode: click marker to delete."
                : tool === "draw-pipe"
                  ? (pipeDrawStart
                    ? `Drawing ${pipeDrawDiameter}mm pipe — click to set end. Click again to chain. Esc to stop.`
                    : `Draw ${pipeDrawDiameter}mm pipe — click to set start point.`)
                  : "Select mode: click to select, Ctrl/Shift+click for multi-select, drag box to select many, drag selected to move."}
          </div>
        ) : null}

        {marqueeRect ? (
          <div
            style={{
              position: "absolute",
              left: marqueeRect.left,
              top: marqueeRect.top,
              width: marqueeRect.width,
              height: marqueeRect.height,
              border: "1px dashed #f59e0b",
              background: "rgba(245, 158, 11, 0.12)",
              zIndex: 13,
              pointerEvents: "none",
            }}
          />
        ) : null}

        {/* Selected pipe properties panel */}
        {selectedPipe && (() => {
          const sel = getSelectedPipeData();
          if (!sel) return null;
          const mm = normalizePipeDiameter(sel.diameter);
          return (
            <div
              data-ui-overlay="selected-pipe"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                bottom: 16,
                left: 16,
                zIndex: 15,
                background: "rgba(24,24,37,0.96)",
                border: "1px solid #45475a",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 12,
                color: "#cdd6f4",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                minWidth: 240,
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 700, color: "#FACC15" }}>
                  Selected pipe ({selectedPipe.kind === "manual" ? "Manual" : "Auto"})
                </span>
                <button
                  onClick={() => setSelectedPipe(null)}
                  style={{
                    background: "transparent", border: "none",
                    color: "#9ca3af", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0,
                  }}
                  title="Deselect"
                >×</button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ color: "#a6adc8" }}>Diameter:</label>
                <select
                  value={mm}
                  onChange={(e) => changeSelectedPipeDiameter(Number(e.target.value))}
                  disabled={!canEdit}
                  style={{
                    background: "#313244", color: "#cdd6f4",
                    border: "1px solid #45475a", borderRadius: 6,
                    padding: "4px 8px", fontSize: 12,
                  }}
                >
                  {PIPE_DIAMETERS_MM.map((d) => (
                    <option key={d} value={d}>{d} mm</option>
                  ))}
                </select>
              </div>
              <div style={{ fontSize: 11, color: "#7f849c" }}>
                ({sel.from[0].toFixed(1)}, {sel.from[1].toFixed(1)}) → ({sel.to[0].toFixed(1)}, {sel.to[1].toFixed(1)})
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={deleteSelectedPipe}
                  disabled={!canEdit}
                  style={{
                    flex: 1,
                    background: "#991b1b", borderColor: "#7f1d1d",
                    color: "#fff", border: "1px solid #7f1d1d",
                    borderRadius: 6, padding: "5px 10px", fontSize: 12,
                    cursor: canEdit ? "pointer" : "not-allowed",
                    opacity: canEdit ? 1 : 0.5,
                  }}
                  title="Delete selected pipe (Del)"
                >
                  Delete Pipe
                </button>
              </div>
            </div>
          );
        })()}

        {pipeMsg ? (
          <div
            style={{
              position: "absolute",
              top: 50,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 14,
              background: "rgba(24,24,37,0.94)",
              border: "1px solid #45475a",
              borderRadius: 8,
              padding: "6px 10px",
              fontSize: 12,
              color: "#cdd6f4",
            }}
          >
            {pipeMsg}
          </div>
        ) : null}

        {loading ? (
          <div style={overlayStyle}>
            <div style={spinnerStyle} />
            <div style={{ marginTop: 12, fontSize: 13 }}>Loading project…</div>
          </div>
        ) : null}

        {progress ? (
          <div style={overlayStyle}>
            <div style={spinnerStyle} />
            <div style={{ marginTop: 12, fontSize: 13 }}>{progress.phase}</div>
            <div style={{ marginTop: 10, width: 280, height: 6, background: "#313244", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progress.pct}%`, background: "#cba6f7", transition: "width 0.2s" }} />
            </div>
          </div>
        ) : null}

        {error ? (
          <div
            style={{
              position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
              background: "#45273a", border: "1px solid #f38ba8", borderRadius: 8,
              padding: "8px 16px", fontSize: 13, color: "#f38ba8", zIndex: 20,
              maxWidth: "80%",
            }}
          >
            {error}
          </div>
        ) : null}

        {showLayers ? (
          <div
            style={{
              position: "absolute", top: 8, right: 8,
              background: "#181825", border: "1px solid #313244",
              borderRadius: 8, maxHeight: "70vh", overflowY: "auto",
              minWidth: 220, maxWidth: 300, zIndex: 15,
            }}
          >
            <h3 style={{
              padding: "10px 12px", fontSize: 13, color: "#cba6f7",
              borderBottom: "1px solid #313244", margin: 0,
              position: "sticky", top: 0, background: "#181825",
            }}>
              Layers
            </h3>
            {/* Equipment (virtual) layers ─ detectors per dtype + sprinkler pipes */}
            <div style={{
              padding: "6px 12px 4px", fontSize: 10, fontWeight: 700,
              color: "#a6adc8", textTransform: "uppercase", letterSpacing: 0.5,
              borderBottom: "1px solid #313244",
            }}>
              Equipment
            </div>
            <div>
              {ADD_TYPE_OPTIONS.map((opt) => {
                const visible = equipmentLayerVisibility[opt.value] !== false;
                const count = detectors.filter((d) => d.dtype === opt.value).length;
                return (
                  <label
                    key={`equip-${opt.value}`}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "5px 12px", fontSize: 12, cursor: "pointer",
                      opacity: count === 0 ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={(e) =>
                        setEquipmentLayerVisibility((prev) => ({
                          ...prev,
                          [opt.value]: e.target.checked,
                        }))
                      }
                      style={{ accentColor: "#cba6f7" }}
                    />
                    <span
                      style={{
                        width: 14, height: 14, borderRadius: 3,
                        border: "1px solid #45475a", flexShrink: 0,
                        background: DTYPE_COLORS[opt.value] || "#22d3ee",
                      }}
                    />
                    <span
                      style={{
                        overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap", color: "#cdd6f4", flex: 1,
                      }}
                      title={opt.label}
                    >
                      {opt.label}
                    </span>
                    {count > 0 ? (
                      <span style={{ fontSize: 10, color: "#7f849c" }}>{count}</span>
                    ) : null}
                  </label>
                );
              })}
              {/* Sprinkler pipes layer */}
              {(() => {
                const pipeCount = (pipesData?.pipes?.length || 0) + manualPipes.length;
                const visible = equipmentLayerVisibility.pipes !== false;
                return (
                  <label
                    key="equip-pipes"
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "5px 12px", fontSize: 12, cursor: "pointer",
                      opacity: pipeCount === 0 ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={(e) =>
                        setEquipmentLayerVisibility((prev) => ({
                          ...prev,
                          pipes: e.target.checked,
                        }))
                      }
                      style={{ accentColor: "#cba6f7" }}
                    />
                    <span
                      style={{
                        width: 14, height: 14, borderRadius: 3,
                        border: "1px solid #45475a", flexShrink: 0,
                        background: "#DC2626",
                      }}
                    />
                    <span style={{ flex: 1, color: "#cdd6f4" }} title="Sprinkler Pipes">
                      Sprinkler Pipes
                    </span>
                    {pipeCount > 0 ? (
                      <span style={{ fontSize: 10, color: "#7f849c" }}>{pipeCount}</span>
                    ) : null}
                  </label>
                );
              })()}
            </div>

            {/* DXF drawing layers (from the file) */}
            {layers.length > 0 ? (
              <div style={{
                padding: "6px 12px 4px", fontSize: 10, fontWeight: 700,
                color: "#a6adc8", textTransform: "uppercase", letterSpacing: 0.5,
                borderTop: "1px solid #313244", borderBottom: "1px solid #313244",
                marginTop: 4,
              }}>
                Drawing Layers
              </div>
            ) : null}
            <div>
              {layers.map((l) => (
                <label
                  key={l.name}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "5px 12px", fontSize: 12, cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={l.visible}
                    onChange={(e) => toggleLayer(l.name, e.target.checked)}
                    style={{ accentColor: "#cba6f7" }}
                  />
                  <span
                    style={{
                      width: 14, height: 14, borderRadius: 3,
                      border: "1px solid #45475a", flexShrink: 0,
                      background: colorToHex(l.color),
                    }}
                  />
                  <span
                    style={{
                      overflow: "hidden", textOverflow: "ellipsis",
                      whiteSpace: "nowrap", color: "#cdd6f4",
                    }}
                    title={l.displayName}
                  >
                    {l.displayName}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {showBlocks ? (
          <div
            style={{
              position: "absolute", top: 8,
              right: showLayers ? 316 : 8,
              background: "#181825", border: "1px solid #313244",
              borderRadius: 8, maxHeight: "70vh", overflowY: "auto",
              minWidth: 240, maxWidth: 320, zIndex: 15,
            }}
          >
            <div style={{
              padding: "10px 12px", fontSize: 13, color: "#cba6f7",
              borderBottom: "1px solid #313244",
              position: "sticky", top: 0, background: "#181825",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            }}>
              <span>Blocks</span>
              {selectedBlock ? (
                <button
                  onClick={() => { setSelectedBlock(null); clearHighlight(); }}
                  style={{
                    background: "transparent", color: "#f38ba8",
                    border: "1px solid #45475a", borderRadius: 4,
                    padding: "2px 8px", fontSize: 11, cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <div>
              {blocks.length === 0 ? (
                <div style={{ padding: "10px 12px", fontSize: 12, color: "#6c7086" }}>
                  No blocks defined in this drawing.
                </div>
              ) : blocks.map((b) => {
                const active = selectedBlock === b.name;
                return (
                  <button
                    key={b.name}
                    onClick={() => selectBlock(b.name)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      gap: 8, width: "100%",
                      padding: "6px 12px", fontSize: 12, cursor: "pointer",
                      background: active ? "#45475a" : "transparent",
                      color: active ? "#f9e2af" : "#cdd6f4",
                      border: "none", borderBottom: "1px solid #1e1e2e",
                      textAlign: "left",
                    }}
                    title={b.name}
                  >
                    <span style={{
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      flex: 1,
                    }}>
                      {b.name}
                    </span>
                    <span style={{
                      fontSize: 11, color: active ? "#f9e2af" : "#6c7086",
                      flexShrink: 0,
                    }}>
                      ×{b.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {showFloors && floorPlans.length > 0 ? (
          <div
            style={{
              position: "absolute", top: 8, left: 8,
              background: "#181825", border: "1px solid #313244",
              borderRadius: 8, maxHeight: "70vh", overflowY: "auto",
              minWidth: 220, maxWidth: 280, zIndex: 15,
            }}
          >
            <div style={{
              padding: "10px 12px", fontSize: 13, color: "#89b4fa",
              borderBottom: "1px solid #313244",
              position: "sticky", top: 0, background: "#181825",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            }}>
              <span>Floor Plans</span>
              {selectedFloorId ? (
                <button
                  onClick={() => { setSelectedFloorId(null); clearHighlight(); fitView(); }}
                  style={{
                    background: "transparent", color: "#f38ba8",
                    border: "1px solid #45475a", borderRadius: 4,
                    padding: "2px 8px", fontSize: 11, cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <div style={{
              padding: "8px 12px", borderBottom: "1px solid #313244",
              display: "flex", flexDirection: "column", gap: 4,
              background: "#181825",
            }}>
              <div style={{
                display: "flex", justifyContent: "space-between",
                fontSize: 11, color: "#a6adc8",
              }}>
                <span>Highlight opacity</span>
                <span style={{ color: "#89b4fa", fontVariantNumeric: "tabular-nums" }}>
                  {Math.round(floorOpacity * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={floorOpacity}
                onChange={(e) => setFloorOpacity(Number(e.target.value))}
                style={{ width: "100%", accentColor: "#89b4fa" }}
              />
            </div>
            <div>
              {floorPlans.map((fp) => {
                const active = selectedFloorId === fp.id;
                const bb = fp.world_bbox;
                const dims = bb
                  ? `${Math.round(bb.xmax - bb.xmin)} × ${Math.round(bb.ymax - bb.ymin)}`
                  : "—";
                return (
                  <button
                    key={fp.id}
                    onClick={() => selectFloorPlan(fp)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      gap: 8, width: "100%",
                      padding: "8px 12px", fontSize: 12, cursor: "pointer",
                      background: active ? "#3a3a5c" : "transparent",
                      color: active ? "#89b4fa" : "#cdd6f4",
                      border: "none", borderBottom: "1px solid #1e1e2e",
                      textAlign: "left",
                    }}
                    title={`Block ${fp.block_index + 1} — ${fp.status}`}
                  >
                    <span style={{ flex: 1, fontWeight: active ? 600 : 400 }}>
                      Block {fp.block_index + 1}
                    </span>
                    <span style={{
                      fontSize: 10, color: active ? "#89b4fa" : "#6c7086",
                      flexShrink: 0,
                    }}>
                      {dims}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Floor utilities */}
            <div style={{
              padding: "10px 12px", borderTop: "1px solid #313244",
              display: "flex", flexDirection: "column", gap: 8,
              background: "#181825",
            }}>
              {manualEditMsg ? (
                <div style={{
                  fontSize: 11,
                  color: "#89b4fa",
                  lineHeight: 1.4,
                  marginBottom: 2,
                }}>
                  {manualEditMsg}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#313244", color: "#cdd6f4",
  border: "1px solid #45475a", borderRadius: 6,
  padding: "6px 14px", fontSize: 13, cursor: "pointer",
};

const insertToolTileStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 2,
  minHeight: 70,
  border: "1px solid #45475a",
  borderRadius: 6,
  color: "#cdd6f4",
  cursor: "pointer",
  padding: "6px 4px",
};

function renderInsertToolPreview(dtype: string): React.ReactNode {
  const stroke = "#d6dbff";
  const fill = "#d6dbff";

  if (dtype === "smoke") {
    return (
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <circle cx="14" cy="14" r="10" fill="none" stroke={stroke} strokeWidth="1.5" />
        <path d="M18 8.5 C 14.5 7.8, 10.3 8.1, 10.3 11.1 C 10.3 13.5, 17.2 12.8, 17.2 16 C 17.2 18.4, 13.7 19.4, 10.1 18.7" fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  if (dtype === "sprinkler") {
    return (
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <circle cx="14" cy="14" r="10" fill="none" stroke={stroke} strokeWidth="1.5" />
        <line x1="4" y1="14" x2="24" y2="14" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
        <line x1="14" y1="4" x2="14" y2="24" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  if (dtype === "mcb") {
    return (
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <rect x="6" y="6" width="16" height="16" fill="none" stroke={stroke} strokeWidth="1.5" />
        <circle cx="14" cy="14" r="3.2" fill={fill} />
      </svg>
    );
  }

  if (dtype === "hooter") {
    return (
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <path d="M9 19.5 L9 13.5 C 9 10.2 11.2 8 14 8 C 16.8 8 19 10.2 19 13.5 L19 19.5" fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="7.5" y1="19.5" x2="20.5" y2="19.5" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
        <line x1="14" y1="19.5" x2="14" y2="22" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
        <line x1="6" y1="12.5" x2="4" y2="10.8" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
        <line x1="22" y1="12.5" x2="24" y2="10.8" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  if (dtype === "fire_hose") {
    return (
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <rect x="4.5" y="11.5" width="7" height="5" fill="none" stroke={stroke} strokeWidth="1.4" />
        <line x1="5.5" y1="14" x2="13" y2="14" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" />
        <rect x="10" y="8.5" width="3" height="11" fill={fill} />
        <circle cx="16" cy="14" r="4.2" fill="none" stroke={stroke} strokeWidth="1.4" />
        <path d="M20.4 10.6 Q 22 14 20.4 17.4" fill="none" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
        <line x1="22.2" y1="11.1" x2="22.2" y2="16.9" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }

  if (dtype === "internal_hydrant") {
    return (
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <rect x="4.5" y="7" width="19" height="14" fill="none" stroke={stroke} strokeWidth="1.4" />
        <path d="M6.2 19.6 L6.2 8.4 L19.5 19.6" fill="none" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M10 11.5 L12 12.8 L14 14 L16 15.2 L18 16.5" fill="none" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }

  if (dtype === "beam_detector") {
    return (
      <svg width="30" height="28" viewBox="0 0 30 28" aria-hidden>
        <rect x="4" y="7" width="22" height="14" fill="none" stroke={stroke} strokeWidth="1.4" />
        <path d="M6 21 L15 15 L24 21" fill="none" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M12 11 L12 16 L15 14.8 L12 13.6" fill="none" stroke={stroke} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (dtype === "reflector") {
    return (
      <svg width="30" height="28" viewBox="0 0 30 28" aria-hidden>
        <rect x="4" y="7" width="22" height="14" fill="none" stroke={stroke} strokeWidth="1.4" />
        <path d="M6 21 L15 15 L24 21" fill="none" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" />
        <line x1="15" y1="15" x2="15" y2="21" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }

  if (dtype === "panel") {
    return (
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <rect x="4.5" y="7" width="19" height="14" fill="none" stroke={stroke} strokeWidth="1.4" />
        <line x1="7.2" y1="14" x2="20.8" y2="14" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="14" cy="11" r="1.4" fill={fill} />
      </svg>
    );
  }

  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
      <rect x="7" y="7" width="14" height="14" fill="none" stroke={stroke} strokeWidth="1.4" />
    </svg>
  );
}

function ribbonTabBtn(active: boolean): React.CSSProperties {
  return {
    background: active ? "#1d1d31" : "transparent",
    color: active ? "#f5e0dc" : "#a6adc8",
    border: "1px solid #313244",
    borderBottom: active ? "1px solid #1d1d31" : "1px solid #313244",
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };
}

const ribbonGroupStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  gap: 6,
  minHeight: 56,
  padding: "6px 10px",
  border: "1px solid #313244",
  borderRadius: 8,
  background: "rgba(24,24,37,0.55)",
};

const ribbonGroupTitleStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "#a6adc8",
};

const overlayStyle: React.CSSProperties = {
  position: "absolute", inset: 0,
  display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center",
  background: "rgba(17,17,27,0.92)", zIndex: 15,
  color: "#a6adc8",
};

const spinnerStyle: React.CSSProperties = {
  width: 44, height: 44,
  border: "4px solid #313244",
  borderTopColor: "#cba6f7",
  borderRadius: "50%",
  animation: "dxfspin 0.8s linear infinite",
};

if (typeof document !== "undefined" && !document.getElementById("dxfspin-kf")) {
  const s = document.createElement("style");
  s.id = "dxfspin-kf";
  s.textContent = "@keyframes dxfspin { to { transform: rotate(360deg); } }";
  document.head.appendChild(s);
}
