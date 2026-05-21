"use client";

import { use, useEffect, useRef, useState } from "react";
import { getToken, getTenantRole } from "../../../lib/auth";
import { attachHatchOverlay, disposeHatchOverlay, syncHatchOverlayVisibility } from "../../../../lib/hatchOverlay";

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

type EditTool = "pan" | "select" | "add" | "erase" | "draw-pipe" | "measure";
type RibbonTab = "home" | "insert" | "automation" | "view";

type PointerInfo = {
  clientX: number;
  clientY: number;
};

/** Endpoint anchor — links a pipe end to a detector (sprinkler), source, or another pipe end
 *  so that moving any of those objects drags every connected joint with it. */
type PipeEndpointAnchor =
  | { kind: "detector"; id: string }
  | { kind: "source"; index: number };

type PipeSegment = {
  from: [number, number];
  to: [number, number];
  diameter: string;
  fromAnchor?: PipeEndpointAnchor;
  toAnchor?: PipeEndpointAnchor;
};

type PipeSource = { x: number; y: number };

type PipesData = {
  pipes: PipeSegment[];
  sources: PipeSource[];
};

const EQUIPMENT_BUTTONS: { key: string; label: string; color: string }[] = [
  { key: "smoke",      label: "Smoke Detectors", color: "#ef4444" },
  { key: "heat",       label: "Heat Detectors",  color: "#eab308" },
  { key: "sprinkler",  label: "Sprinkler",       color: "#ef4444" },
];

const ADD_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "smoke", label: "Smoke" },
  { value: "heat", label: "Heat" },
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
  heat:       "#eab308",
  sprinkler:  "#ef4444",
  fire_hose:  "#ef4444",
  internal_hydrant: "#d946ef",
  beam_detector: "#ff00cc",
  reflector: "#2D6A4F",
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
  heat:             0.10,
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

/** One distinct colour per standard pipe diameter. Values chosen for high contrast. */
const PIPE_DIAMETER_COLOR_HEX: Record<number, number> = {
  20:  0x8B5CF6, // violet
  25:  0xDC2626, // red
  32:  0xD97706, // amber
  40:  0x16A34A, // green
  50:  0x2563EB, // blue
  65:  0x9333EA, // purple
  80:  0xEA580C, // orange
  100: 0x0891B2, // cyan
  125: 0xDB2777, // pink
  150: 0x78716C, // stone
  200: 0x64748B, // slate
};

function pipeDiameterColor(diameter?: string): number {
  const mm = normalizePipeDiameter(diameter);
  // Walk thresholds ascending and return the first matching colour.
  for (const key of [20, 25, 32, 40, 50, 65, 80, 100, 125, 150, 200] as const) {
    if (mm <= key) return PIPE_DIAMETER_COLOR_HEX[key];
  }
  return PIPE_DIAMETER_COLOR_HEX[200];
}

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
  const hatchOverlayRef = useRef<any>(null);

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [addType, setAddType] = useState<string>("smoke");
  const [selectedDetectorId, setSelectedDetectorId] = useState<string | null>(null);
  const [selectedDetectorIds, setSelectedDetectorIds] = useState<string[]>([]);
  const [draggingDetectorId, setDraggingDetectorId] = useState<string | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  /** Drag-group context. Captured at pointerdown so every pointermove uses the original
   *  positions instead of compounding deltas. `pipeStarts` and `manualStarts` record the
   *  initial endpoints of any pipe whose end is anchored to a dragged detector or sits
   *  coincident with one — those endpoints follow the drag delta verbatim, keeping joints
   *  tight even when several pipes share the same node. */
  const groupDragRef = useRef<{
    ids: string[];
    startWorld: { x: number; y: number };
    startById: Record<string, { x: number; y: number }>;
    pipeStarts: Map<number, { from: [number, number]; to: [number, number]; followFrom: boolean; followTo: boolean }>;
    manualStarts: Map<number, { from: [number, number]; to: [number, number]; followFrom: boolean; followTo: boolean }>;
  } | null>(null);
  /** Active drag of a pipe endpoint (or joint = several coincident endpoints). Captures
   *  every pipe end at the joint as well as any detector(s) sharing the same position, so
   *  moving the joint moves all of them as one rigid unit. */
  const pipeEndpointDragRef = useRef<{
    startWorld: { x: number; y: number };
    /** Endpoint references that follow the drag. Keys for the snapshot maps are
     *  `${kind}:${index}:${end}` so a single pipe can contribute both ends if both are
     *  coincident (rare but possible for zero-length segments). */
    endpoints: Array<{ kind: "auto" | "manual"; index: number; end: "from" | "to" }>;
    /** Initial positions of every pipe involved, keyed by `${kind}:${index}`. */
    pipeStarts: Map<string, { from: [number, number]; to: [number, number] }>;
    /** Detectors coincident with the joint at grab time. */
    detectorIds: string[];
    detectorStarts: Record<string, { x: number; y: number }>;
    moved: boolean;
  } | null>(null);
  /** Active drag of an entire pipe body (translate both endpoints together). Anchors are
   *  cleared on translate since a pipe moved as a whole can no longer assume its
   *  endpoints stay glued to the original detectors. */
  const pipeBodyDragRef = useRef<{
    ref: { kind: "auto" | "manual"; index: number };
    startWorld: { x: number; y: number };
    startClient: { x: number; y: number };
    startFrom: [number, number];
    startTo: [number, number];
    moved: boolean;
  } | null>(null);
  /** Coalesces per-frame state updates during pipe drags so we don't fire setState 60+×/sec.
   *  The pending payload is applied inside a requestAnimationFrame callback; subsequent
   *  pointermove events replace `pending` until the frame runs. */
  const pipeDragRafRef = useRef<{ raf: number; pending: (() => void) | null } | null>(null);
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
  /** Anchor descriptor for the pending pipe-draw start point. Kept in a ref so onPointerDown
   *  reads the latest value without the effect re-subscribing on every change. */
  const pipeDrawStartAnchorRef = useRef<PipeEndpointAnchor | undefined>(undefined);
  const [manualPipes, setManualPipes] = useState<PipeSegment[]>([]);
  const [measureStart, setMeasureStart] = useState<{ x: number; y: number } | null>(null);
  const [measureEnd, setMeasureEnd] = useState<{ x: number; y: number } | null>(null);
  const [measurePreview, setMeasurePreview] = useState<{ x: number; y: number } | null>(null);
  // Selected pipe (kind: "auto" → backend-routed, "manual" → drawn locally)
  const [selectedPipe, setSelectedPipe] = useState<{ kind: "auto" | "manual"; index: number } | null>(null);
  /** Snap indicator(s) shown while editing pipes. A single endpoint/joint drag pushes
   *  one entry; a full pipe-body translate pushes two (one per endpoint). When `snapped`
   *  is true the dot fills solid black with a halo — same UX as the line-tool anchor.
   *  When `split` is true the indicator additionally draws a red square outline to
   *  signal a mid-segment "tee-in" snap. */
  const [pipeEditSnap, setPipeEditSnap] = useState<Array<{ x: number; y: number; snapped: boolean; split?: boolean }> | null>(null);
  // Tracks whether the user has edited (deleted/resized) auto-routed pipes since last save.
  const [pipesModified, setPipesModified] = useState<boolean>(false);
  // Export
  const [isExportingDxf, setIsExportingDxf] = useState(false);
  const [isExportingDwg, setIsExportingDwg] = useState(false);
  // Equipment-layer visibility (virtual layers for detector dtypes + pipes).
  // Keys are detector dtype values (smoke, sprinkler, ...) plus the special
  // key "pipes" for sprinkler pipe routing. Defaults to all visible.
  const [equipmentLayerVisibility, setEquipmentLayerVisibility] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = { pipes: true };
    for (const opt of ADD_TYPE_OPTIONS) init[opt.value] = true;
    return init;
  });
  // Translucent coverage-disk overlay for smoke detectors.
  // Radius comes from the backend `/api/config/defaults` (DETECTOR_SPACING_M).
  // Default to 7m as a safety fallback if the endpoint is unreachable.
  const [showCoverageDisks, setShowCoverageDisks] = useState<boolean>(false);
  const [detectorSpacingM, setDetectorSpacingM] = useState<number>(7.0);
  const [heatDetectorSpacingM, setHeatDetectorSpacingM] = useState<number>(5.0);
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

        // Pull backend-owned constants (detector spacing, etc.) so the
        // coverage-disk overlay matches the placement algorithm exactly.
        try {
          const defRes = await fetch(apiUrl(`/api/config/defaults`), { headers });
          if (defRes.ok) {
            const defs = await defRes.json();
            const sp = Number(defs?.detector_spacing_m);
            if (!cancelled && Number.isFinite(sp) && sp > 0) {
              setDetectorSpacingM(sp);
            }
            const hsp = Number(defs?.heat_detector_spacing_m);
            if (!cancelled && Number.isFinite(hsp) && hsp > 0) {
              setHeatDetectorSpacingM(hsp);
            }
          }
        } catch { /* keep fallback */ }

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
          // Cap spline-edge subdivisions inside hatch boundaries so CloudConvert
          // files (hundreds of control points per edge) don't explode to 100k+
          // boundary vertices and stall the per-line clipping pass. Combined with
          // the precomputed-edge-wrapper optimization in HatchCalculator, this
          // lets full hatch rendering complete in seconds instead of minutes.
          hatchMaxSplineSubdivisions: 64,
          hatchMaxBoundaryVertices: 5000,
          // dxf-render parity caps: per-pattern parallel-line cap (lQ=1000) +
          // running per-hatch global segment counter (st=50000). With these in
          // place the real per-line pattern code can run safely on huge files —
          // worst case is a partially-filled hatch, never a freeze.
          hatchMaxLinesPerPattern: 1000,
          hatchMaxSegmentsPerHatch: 50000,
          // Stencil flat-fill is no longer needed; let real patterns render.
          hatchStencilFill: false,
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

      // Skip font glyph tessellation for large DXFs. dxf-viewer renders text
      // by tessellating every glyph through opentype.js on the main thread,
      // which can hang for minutes (and OOM the WebGL renderer) on files with
      // thousands of MTEXT/ATTRIB/DIMENSION entities inside nested blocks.
      // For large files we pass fonts: [] so text falls back to placeholders
      // and the geometry loads in seconds.
      const DXF_FONT_SKIP_BYTES = 0; // 5 MB
      let skipFonts = false;
      try {
        const headRes = await fetch(apiUrl(dxfUrl), {
          method: "HEAD",
          headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : undefined,
        });
        const lenStr = headRes.headers.get("content-length");
        const len = lenStr ? parseInt(lenStr, 10) : 0;
        if (len && len >= DXF_FONT_SKIP_BYTES) {
          skipFonts = true;
          console.warn(
            `[dxf-viewer] DXF is ${(len / 1024 / 1024).toFixed(1)} MB — ` +
              `skipping font tessellation (text shown as placeholders).`,
          );
        }
      } catch {
        // HEAD failed (CORS, signed URL, etc.) — proceed with fonts enabled.
      }

      try {
        await viewer.Load({
          url: dxfUrl,
          fonts: skipFonts ? [] : FONTS,
          progressCbk: (phase: string, processed: number, total: number) => {
            if (cancelled) return;
            const label =
              phase === "fetch" ? "Fetching…" :
              phase === "parse" ? "Parsing…" :
              phase === "prepare" ? "Preparing…" :
              phase === "font" ? (skipFonts ? "Skipping fonts…" : "Loading fonts…") : phase;
            const pct = total && total > 0 ? Math.round((processed / total) * 100) : 100;
            setProgress({ phase: label, pct });
          },
          workerFactory: null,
        });
        /* Pattern-fill overlay: render captured hatch fills via shader-textured
         * meshes (proper visuals instead of the flat-color earcut prototype). */
        try {
          if (threeRef.current) {
            const grp = attachHatchOverlay(viewer, threeRef.current);
            hatchOverlayRef.current = grp;
          }
        } catch (overlayErr) {
          console.warn("[hatch-overlay] failed to attach", overlayErr);
        }
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
      if (hatchOverlayRef.current) {
        try { disposeHatchOverlay(hatchOverlayRef.current); } catch {}
        hatchOverlayRef.current = null;
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
  // Zoom (wheel) stays enabled in every tool so the user can always zoom in/out;
  // only pan/rotate are disabled outside pan mode (or while picking a source).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const navigationEnabled = (tool === "pan") && !sourceSelectMode;
    const controls = (viewer.GetControls?.() ?? (viewer as any).controls ?? (viewer as any)._controls) as any;
    if (controls) {
      // Keep the controls instance itself enabled so wheel-zoom always works.
      if ("enabled" in controls) controls.enabled = true;
      if ("enableZoom" in controls) controls.enableZoom = true;
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

  /* Backfill pipe-endpoint anchors so backend-routed pipes (which only carry raw {x,y}
   * endpoints) follow a sprinkler when it's dragged. Any endpoint that lands within a
   * tiny world-space tolerance of a detector position is treated as anchored to that
   * detector. Runs whenever detector or pipe data is (re)loaded; idempotent. */
  useEffect(() => {
    if (!pipesData || !detectors.length) return;
    const ANCHOR_TOL = 0.5;          // world units (DXF) — generous enough to absorb mm-level rounding
    const TOL2 = ANCHOR_TOL * ANCHOR_TOL;
    function anchorFor(end: [number, number]): PipeEndpointAnchor | undefined {
      let best: { id: string; d2: number } | null = null;
      for (const d of detectors) {
        const dx = d.x - end[0], dy = d.y - end[1];
        const d2 = dx * dx + dy * dy;
        if (d2 <= TOL2 && (!best || d2 < best.d2)) best = { id: d.id, d2 };
      }
      return best ? { kind: "detector", id: best.id } : undefined;
    }
    let changed = false;
    const nextPipes = pipesData.pipes.map((seg) => {
      const nf = seg.fromAnchor ?? anchorFor(seg.from);
      const nt = seg.toAnchor   ?? anchorFor(seg.to);
      if (nf !== seg.fromAnchor || nt !== seg.toAnchor) {
        changed = true;
        return { ...seg, fromAnchor: nf, toAnchor: nt };
      }
      return seg;
    });
    if (changed) {
      setPipesData((prev) => (prev ? { ...prev, pipes: nextPipes } : prev));
    }
    /* Same backfill for manual pipes drawn before this feature shipped. */
    let manualChanged = false;
    const nextManual = manualPipes.map((seg) => {
      const nf = seg.fromAnchor ?? anchorFor(seg.from);
      const nt = seg.toAnchor   ?? anchorFor(seg.to);
      if (nf !== seg.fromAnchor || nt !== seg.toAnchor) {
        manualChanged = true;
        return { ...seg, fromAnchor: nf, toAnchor: nt };
      }
      return seg;
    });
    if (manualChanged) {
      setManualPipes(nextManual);
    }
  }, [pipesData, detectors, manualPipes]);

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
    // Keep hatch overlay meshes (which live outside dxf-viewer's batch system)
    // in lockstep with the viewer's layer visibility.
    try { syncHatchOverlayVisibility(viewer, hatchOverlayRef.current); } catch {}
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
    const hasMeasureOverlay = !!measureStart && !!(measureEnd || measurePreview);
    if ((!pipesData || !showPipes) && !hasSelectionOverlay && !hasManualPipes && !hasMeasureOverlay) return;

    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
    const scene = viewer.GetScene?.();
    if (!scene) return;
    const group = new three.Group();

    // Compute dot radius matching smoke detector size (uses worldToM from closure)
    const _wtm = Number.isFinite(worldToM) && worldToM > 0 ? worldToM : 1.0;
    const _upm = 1.0 / _wtm;
    const dotR = Math.max((DTYPE_RADIUS_M["smoke"] ?? 0.10) * _upm * 0.85, _upm * 0.08);

    /* Pixel ↔ world conversion at the current zoom, so screen-anchored UI elements
     * (snap dots, endpoint grip badges) stay readable independent of drawing scale. */
    let worldPerPx = _upm * 0.01;  // fallback: 1cm per pixel
    try {
      const cam: any = viewer.GetCamera?.();
      const renderer: any = viewer.GetRenderer?.();
      const dom: HTMLCanvasElement | undefined = renderer?.domElement;
      if (cam?.isOrthographicCamera && dom?.clientWidth) {
        const visibleW = (cam.right - cam.left) / (cam.zoom || 1);
        if (visibleW > 0) worldPerPx = visibleW / dom.clientWidth;
      }
    } catch {}

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
          color: new three.Color(pipeDiameterColor(diameter)),
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

    /* ── Pipe-end grip handles (CAD-style joints) ────────────────────────────────
     * Always-visible markers at every pipe endpoint when the user is in select
     * mode. Each unique joint position aggregates one marker; the colour encodes
     * the joint's state:
     *   • free  (single pipe, no attachment) → blue circle
     *   • joint (≥2 pipe ends share point)   → larger solid blue circle
     *   • bound (an end is anchored to a sprinkler/source) → green circle
     * Skipped while a pipe drag is in flight to keep the frame budget tight. */
    const dragActive = !!(pipeEndpointDragRef.current || pipeBodyDragRef.current || groupDragRef.current);
    if (tool === "select" && equipmentLayerVisibility.pipes !== false && !dragActive) {
      type JointInfo = { x: number; y: number; count: number; bound: boolean };
      const joints = new Map<string, JointInfo>();
      const JOINT_KEY_PREC = 4;
      function add(end: [number, number], bound: boolean) {
        const k = `${end[0].toFixed(JOINT_KEY_PREC)},${end[1].toFixed(JOINT_KEY_PREC)}`;
        const cur = joints.get(k);
        if (cur) { cur.count++; cur.bound = cur.bound || bound; }
        else joints.set(k, { x: end[0], y: end[1], count: 1, bound });
      }
      if (pipesData?.pipes) {
        for (const seg of pipesData.pipes) {
          add(seg.from, !!seg.fromAnchor);
          add(seg.to,   !!seg.toAnchor);
        }
      }
      for (const seg of manualPipes) {
        add(seg.from, !!seg.fromAnchor);
        add(seg.to,   !!seg.toAnchor);
      }

      const baseR = Math.max(dotR * 0.55, _upm * 0.07, worldPerPx * 3.5);
      for (const j of joints.values()) {
        const px = j.x - origin.x;
        const py = j.y - origin.y;
        const isJoint = j.count >= 2;
        const color = j.bound ? 0x10B981 : (isJoint ? 0x2563EB : 0x60A5FA);
        const r = (isJoint || j.bound) ? baseR * 1.1 : baseR * 0.9;

        /* White halo for contrast on dark backgrounds. */
        const halo = new three.Mesh(
          new three.CircleGeometry(r * 1.55, 22),
          new three.MeshBasicMaterial({
            color: new three.Color(0xffffff),
            transparent: true, opacity: 0.9,
            depthTest: false, depthWrite: false, side: three.DoubleSide,
          }),
        );
        halo.position.set(px, py, 0.56);
        halo.renderOrder = 1190;
        group.add(halo);

        /* Solid coloured dot. */
        const dot = new three.Mesh(
          new three.CircleGeometry(r, 22),
          new three.MeshBasicMaterial({
            color: new three.Color(color),
            transparent: true, opacity: 1,
            depthTest: false, depthWrite: false, side: three.DoubleSide,
          }),
        );
        dot.position.set(px, py, 0.57);
        dot.renderOrder = 1191;
        group.add(dot);
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
        // Slightly transparent version of the diameter colour for the preview.
        (previewMesh.material as any).transparent = true;
        (previewMesh.material as any).opacity = 0.65;
        group.add(previewMesh);
      }


    // Draw measure line and endpoint handles.
    if (measureStart && (measureEnd || measurePreview)) {
      const end = measureEnd || measurePreview;
      if (end) {
        const sx = measureStart.x - origin.x;
        const sy = measureStart.y - origin.y;
        const ex = end.x - origin.x;
        const ey = end.y - origin.y;

        const lineGeom = new three.BufferGeometry().setFromPoints([
          new three.Vector3(sx, sy, 0.95),
          new three.Vector3(ex, ey, 0.95),
        ]);
        const line = new three.Line(
          lineGeom,
          new three.LineBasicMaterial({
            color: new three.Color(0x22D3EE),
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false,
          }),
        );
        line.renderOrder = 1200;
        group.add(line);

        const markerR = 3.2;
        const mkMat = new three.MeshBasicMaterial({
          color: new three.Color(0x67E8F9),
          transparent: true,
          opacity: 0.95,
          depthTest: false,
          depthWrite: false,
          side: three.DoubleSide,
        });
        const startMk = new three.Mesh(new three.CircleGeometry(markerR, 20), mkMat);
        startMk.position.set(sx, sy, 0.58);
        startMk.renderOrder = 1201;
        group.add(startMk);

        const endMk = new three.Mesh(new three.CircleGeometry(markerR, 20), mkMat.clone());
        endMk.position.set(ex, ey, 0.58);
        endMk.renderOrder = 1201;
        group.add(endMk);
      }
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

    /* Selected-pipe endpoint markers — when a pipe is selected draw a prominent blue
     * dot (matching the pipe-draw anchor style) at each endpoint so the user sees them
     * as grab handles they can extend/move. White halo for contrast on any background. */
    if (selectedPipe) {
      const sel = selectedPipe.kind === "auto"
        ? pipesData?.pipes?.[selectedPipe.index]
        : manualPipes[selectedPipe.index];
      if (sel) {
        const ends: Array<[number, number]> = [sel.from, sel.to];
        /* Aim for ~12 px radius on screen — large enough to read clearly at any zoom. */
        const r = Math.max(dotR * 1.0, _upm * 0.14, worldPerPx * 12);
        for (const [wx, wy] of ends) {
          const ex = wx - origin.x;
          const ey = wy - origin.y;
          /* White halo so the blue dot stays visible on any background. */
          const halo = new three.Mesh(
            new three.CircleGeometry(r * 1.5, 32),
            new three.MeshBasicMaterial({
              color: new three.Color(0xffffff),
              transparent: true, opacity: 1.0,
              depthTest: false, depthWrite: false, side: three.DoubleSide,
            }),
          );
          halo.position.set(ex, ey, 0.55);
          halo.renderOrder = 1310;
          group.add(halo);
          /* Solid blue dot — same hue as the draw-time start anchor (0x3b82f6). */
          const dot = new three.Mesh(
            new three.CircleGeometry(r, 32),
            new three.MeshBasicMaterial({
              color: new three.Color(0x3b82f6),
              transparent: true, opacity: 1.0,
              depthTest: false, depthWrite: false, side: three.DoubleSide,
            }),
          );
          dot.position.set(ex, ey, 0.55);
          dot.renderOrder = 1311;
          group.add(dot);
        }
      }
    }

    /* Pipe-edit snap indicator — mirrors the draw-time anchor dot. Filled black while
     * locked onto a snap target, hollow grey while free-floating, so the user sees the
     * same feedback as the line tool's anchor marker. */
    if (pipeEditSnap && pipeEditSnap.length > 0) {
      for (const hint of pipeEditSnap) {
        const ex = hint.x - origin.x;
        const ey = hint.y - origin.y;
        const r = Math.max(dotR * 0.9, _upm * 0.11, worldPerPx * 4);
        /* White halo so the black dot stays visible against any background. */
        const halo = new three.Mesh(
          new three.CircleGeometry(r * 1.6, 28),
          new three.MeshBasicMaterial({
            color: new three.Color(0xffffff),
            transparent: true, opacity: 0.9,
            depthTest: false, depthWrite: false, side: three.DoubleSide,
          }),
        );
        halo.position.set(ex, ey, 0.59);
        halo.renderOrder = 1209;
        group.add(halo);
        const snapDot = new three.Mesh(
          new three.CircleGeometry(r, 28),
          new three.MeshBasicMaterial({
            color: new three.Color(hint.snapped ? 0x000000 : 0x6b7280),
            transparent: true,
            opacity: hint.snapped ? 1.0 : 0.9,
            depthTest: false, depthWrite: false, side: three.DoubleSide,
          }),
        );
        snapDot.position.set(ex, ey, 0.6);
        snapDot.renderOrder = 1210;
        group.add(snapDot);
        if (hint.snapped) {
          const ring = new three.Mesh(
            new three.RingGeometry(r * 1.35, r * 1.85, 32),
            new three.MeshBasicMaterial({
              color: new three.Color(0x000000),
              transparent: true, opacity: 0.95,
              depthTest: false, depthWrite: false, side: three.DoubleSide,
            }),
          );
          ring.position.set(ex, ey, 0.61);
          ring.renderOrder = 1211;
          group.add(ring);
          /* AutoCAD-style red square "object snap" indicator. A solid red frame around
           * the black dot — extra-thick + larger when the snap is a mid-segment "tee-in"
           * that will split the target pipe on release, so the user knows it's a special
           * snap kind. */
          const half = (hint.split ? r * 2.6 : r * 2.1);
          const thick = (hint.split ? r * 0.42 : r * 0.32);
          const redColor = new three.Color(hint.split ? 0xDC2626 : 0xEF4444);
          /* White fill behind the red outline. */
          const sFill = new three.Mesh(
            new three.PlaneGeometry(half * 2, half * 2),
            new three.MeshBasicMaterial({
              color: new three.Color(0xffffff),
              transparent: true, opacity: 0.95,
              depthTest: false, depthWrite: false, side: three.DoubleSide,
            }),
          );
          sFill.position.set(ex, ey, 0.59);
          sFill.renderOrder = 1211.5;
          group.add(sFill);
          const redMat = new three.MeshBasicMaterial({
            color: redColor,
            transparent: true, opacity: 0.98,
            depthTest: false, depthWrite: false, side: three.DoubleSide,
          });
          /* 4 thin strips forming a hollow square. */
          const strips: Array<[number, number, number, number]> = [
            [ex, ey + half - thick / 2, half * 2, thick], // top
            [ex, ey - half + thick / 2, half * 2, thick], // bottom
            [ex - half + thick / 2, ey, thick, half * 2 - thick * 2], // left
            [ex + half - thick / 2, ey, thick, half * 2 - thick * 2], // right
          ];
          for (const [cx, cy, w, h] of strips) {
            const strip = new three.Mesh(new three.PlaneGeometry(w, h), redMat);
            strip.position.set(cx, cy, 0.62);
            strip.renderOrder = 1212;
            group.add(strip);
          }
        }
      }
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

      // Heat detector symbol: circle with an "H" inside (yellow).
      if (dtype === "heat") {
        const s = smokeSymbolRadius;

        // Optional translucent coverage disk (radius = HEAT_DETECTOR_SPACING_M, default 5 m).
        if (showCoverageDisks && heatDetectorSpacingM > 0) {
          const coverageR = heatDetectorSpacingM * unitsPerMeter;
          const hColorFill = DTYPE_COLORS.heat || "#eab308";
          const coverageMesh = new three.Mesh(
            new three.CircleGeometry(coverageR, 64),
            new three.MeshBasicMaterial({
              color: hColorFill,
              transparent: true,
              opacity: 0.12,
              depthTest: false,
              depthWrite: false,
            }),
          );
          coverageMesh.position.set(x, y, 0.69);
          coverageMesh.renderOrder = 1099;
          group.add(coverageMesh);

          const outlinePts: any[] = [];
          for (let i = 0; i <= 64; i++) {
            const t = (i / 64) * Math.PI * 2;
            outlinePts.push(new three.Vector3(x + coverageR * Math.cos(t), y + coverageR * Math.sin(t), 0.70));
          }
          const outline = new three.Line(
            new three.BufferGeometry().setFromPoints(outlinePts),
            new three.LineBasicMaterial({
              color: hColorFill,
              transparent: true,
              opacity: 0.45,
              depthTest: false,
              depthWrite: false,
            }),
          );
          outline.renderOrder = 1100;
          group.add(outline);
        }

        const ringPts: any[] = [];
        for (let i = 0; i <= 48; i++) {
          const t = (i / 48) * Math.PI * 2;
          ringPts.push(new three.Vector3(x + s * Math.cos(t), y + s * Math.sin(t), 0.71));
        }
        const ring = new three.Line(
          new three.BufferGeometry().setFromPoints(ringPts),
          new three.LineBasicMaterial({
            color: new three.Color(DTYPE_COLORS.heat || "#eab308"),
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false,
          }),
        );
        ring.renderOrder = 1101;
        group.add(ring);

        const hColor = DTYPE_COLORS.heat || "#eab308";
        // Letter "H": two verticals + crossbar.
        addPolyline([
          { x: x - s * 0.34, y: y - s * 0.56 },
          { x: x - s * 0.34, y: y + s * 0.56 },
        ], hColor, 0.72, 1, false);
        addPolyline([
          { x: x + s * 0.34, y: y - s * 0.56 },
          { x: x + s * 0.34, y: y + s * 0.56 },
        ], hColor, 0.72, 1, false);
        addPolyline([
          { x: x - s * 0.34, y: y },
          { x: x + s * 0.34, y: y },
        ], hColor, 0.72, 1, false);

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

        // Optional translucent coverage disk (radius = DETECTOR_SPACING_M).
        // Drawn UNDER the detector symbol so the symbol stays legible.
        if (showCoverageDisks && detectorSpacingM > 0) {
          const coverageR = detectorSpacingM * unitsPerMeter;
          const coverageMesh = new three.Mesh(
            new three.CircleGeometry(coverageR, 64),
            new three.MeshBasicMaterial({
              color,
              transparent: true,
              opacity: 0.12,
              depthTest: false,
              depthWrite: false,
            }),
          );
          coverageMesh.position.set(x, y, 0.69);
          coverageMesh.renderOrder = 1099;
          group.add(coverageMesh);

          // Thin outline so the boundary is visible even with low fill opacity.
          const outlinePts: any[] = [];
          for (let i = 0; i <= 64; i++) {
            const t = (i / 64) * Math.PI * 2;
            outlinePts.push(new three.Vector3(x + coverageR * Math.cos(t), y + coverageR * Math.sin(t), 0.70));
          }
          const outline = new three.Line(
            new three.BufferGeometry().setFromPoints(outlinePts),
            new three.LineBasicMaterial({
              color,
              transparent: true,
              opacity: 0.45,
              depthTest: false,
              depthWrite: false,
            }),
          );
          outline.renderOrder = 1100;
          group.add(outline);
        }

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
  }, [detectors, dxfUrl, worldToM, selectedDetectorId, selectedDetectorIds, pipesData, showPipes, sourceSelectMode, detectedSources, chosenSource, manualPipes, pipeDrawStart, pipeDrawPreview, equipmentLayerVisibility, selectedPipe, measureStart, measureEnd, measurePreview, showCoverageDisks, detectorSpacingM, pipeEditSnap, tool]);

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

  function nearestMeasureAnchor(pointer: PointerInfo): { x: number; y: number } | null {
    const anchors: Array<{ x: number; y: number }> = [];

    const visibleDetectors = selectedFloorId
      ? detectors.filter((d) => d.floor_plan_id === selectedFloorId)
      : detectors;
    for (const d of visibleDetectors) anchors.push({ x: d.x, y: d.y });

    if (pipesData?.pipes) {
      for (const p of pipesData.pipes) {
        anchors.push({ x: p.from[0], y: p.from[1] });
        anchors.push({ x: p.to[0], y: p.to[1] });
      }
    }
    for (const p of manualPipes) {
      anchors.push({ x: p.from[0], y: p.from[1] });
      anchors.push({ x: p.to[0], y: p.to[1] });
    }
    if (pipesData?.sources) {
      for (const s of pipesData.sources) anchors.push({ x: s.x, y: s.y });
    }
    for (const s of detectedSources) anchors.push({ x: s.x, y: s.y });
    if (chosenSource) anchors.push({ x: chosenSource.x, y: chosenSource.y });

    let best: { x: number; y: number } | null = null;
    let bestDist2 = Number.POSITIVE_INFINITY;
    for (const a of anchors) {
      const p = screenPointForWorld(a.x, a.y, 0.8);
      if (!p) continue;
      const dx = p.x - pointer.clientX;
      const dy = p.y - pointer.clientY;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        best = a;
      }
    }
    return bestDist2 <= 14 * 14 ? best : null;
  }

  /** Given a world-space point (typically a freshly-clicked pipe endpoint), find the
   *  nearest detector / source / existing pipe-end within screen-space `snapRadiusPx`
   *  and return both the snapped world coordinates and an anchor descriptor (when the
   *  snap target is a detector or pipe source). Pipe-to-pipe joints are kept tight by
   *  coordinate identity, not by an explicit anchor.
   *
   *  `exclude` lets the pipe-edit drag suppress self-snap: any detector id in
   *  `exclude.detectorIds` and any pipe endpoint key (`${kind}:${index}:${end}`) in
   *  `exclude.pipeEndpointKeys` is skipped. */
  function snapPipeEndpoint(
    world: { x: number; y: number },
    snapRadiusPx = 16,
    exclude?: { detectorIds?: Set<string>; pipeEndpointKeys?: Set<string>; pipeSegmentKeys?: Set<string> },
  ): {
    point: { x: number; y: number };
    anchor?: PipeEndpointAnchor;
    /** When the snap landed in the middle of an existing pipe (not at an endpoint), the
     *  caller should split that pipe at `t∈(0,1)` on commit so the dragged endpoint
     *  becomes a real T-junction joint. */
    splitTarget?: { pipeKind: "auto" | "manual"; pipeIndex: number; t: number };
  } {
    const screen = screenPointForWorld(world.x, world.y, 0.8);
    if (!screen) return { point: world };

    let bestDist2 = snapRadiusPx * snapRadiusPx;
    let bestPoint: { x: number; y: number } | null = null;
    let bestAnchor: PipeEndpointAnchor | undefined;

    const visibleDetectors = selectedFloorId
      ? detectors.filter((d) => d.floor_plan_id === selectedFloorId)
      : detectors;
    for (const d of visibleDetectors) {
      if (exclude?.detectorIds?.has(d.id)) continue;
      const p = screenPointForWorld(d.x, d.y, 0.8);
      if (!p) continue;
      const dx = p.x - screen.x, dy = p.y - screen.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        bestPoint = { x: d.x, y: d.y };
        bestAnchor = { kind: "detector", id: d.id };
      }
    }
    if (pipesData?.sources) {
      for (let i = 0; i < pipesData.sources.length; i++) {
        const s = pipesData.sources[i];
        const p = screenPointForWorld(s.x, s.y, 0.8);
        if (!p) continue;
        const dx = p.x - screen.x, dy = p.y - screen.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestPoint = { x: s.x, y: s.y };
          bestAnchor = { kind: "source", index: i };
        }
      }
    }
    /* Pipe ends (auto + manual) — snap to position only, joint identity preserved by coords. */
    const ends: Array<{ x: number; y: number; key: string }> = [];
    if (pipesData?.pipes) {
      for (let i = 0; i < pipesData.pipes.length; i++) {
        const seg = pipesData.pipes[i];
        ends.push({ x: seg.from[0], y: seg.from[1], key: `auto:${i}:from` });
        ends.push({ x: seg.to[0],   y: seg.to[1],   key: `auto:${i}:to`   });
      }
    }
    for (let i = 0; i < manualPipes.length; i++) {
      const seg = manualPipes[i];
      ends.push({ x: seg.from[0], y: seg.from[1], key: `manual:${i}:from` });
      ends.push({ x: seg.to[0],   y: seg.to[1],   key: `manual:${i}:to`   });
    }
    for (const e of ends) {
      if (exclude?.pipeEndpointKeys?.has(e.key)) continue;
      const p = screenPointForWorld(e.x, e.y, 0.8);
      if (!p) continue;
      const dx = p.x - screen.x, dy = p.y - screen.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        bestPoint = { x: e.x, y: e.y };
        bestAnchor = undefined;
      }
    }
    /* Mid-segment snaps — project query onto each pipe segment in screen space; if the
     * projection sits within the radius the pipe will be split at that point on commit
     * so the moved endpoint becomes a true T-junction. */
    let bestSplit: { pipeKind: "auto" | "manual"; pipeIndex: number; t: number } | undefined;
    function testSegment(pipeKind: "auto" | "manual", pipeIndex: number, ax: number, ay: number, bx: number, by: number) {
      const segKey = `${pipeKind}:${pipeIndex}`;
      if (exclude?.pipeSegmentKeys?.has(segKey)) return;
      const sa = screenPointForWorld(ax, ay, 0.8);
      const sb = screenPointForWorld(bx, by, 0.8);
      if (!sa || !sb) return;
      const sdx = sb.x - sa.x, sdy = sb.y - sa.y;
      const len2 = sdx * sdx + sdy * sdy;
      if (len2 === 0) return;
      let t = ((screen.x - sa.x) * sdx + (screen.y - sa.y) * sdy) / len2;
      /* Keep a margin away from endpoints so endpoint snap wins for true endpoint hits. */
      if (t < 0.05 || t > 0.95) return;
      t = Math.max(0, Math.min(1, t));
      const cx = sa.x + t * sdx, cy = sa.y + t * sdy;
      const dx = cx - screen.x, dy = cy - screen.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        const wx = ax + t * (bx - ax);
        const wy = ay + t * (by - ay);
        bestPoint = { x: wx, y: wy };
        bestAnchor = undefined;
        bestSplit = { pipeKind, pipeIndex, t };
      }
    }
    if (pipesData?.pipes) {
      for (let i = 0; i < pipesData.pipes.length; i++) {
        const seg = pipesData.pipes[i];
        testSegment("auto", i, seg.from[0], seg.from[1], seg.to[0], seg.to[1]);
      }
    }
    for (let i = 0; i < manualPipes.length; i++) {
      const seg = manualPipes[i];
      testSegment("manual", i, seg.from[0], seg.from[1], seg.to[0], seg.to[1]);
    }
    if (!bestPoint) return { point: world };
    return bestSplit
      ? { point: bestPoint, anchor: bestAnchor, splitTarget: bestSplit }
      : { point: bestPoint, anchor: bestAnchor };
  }

  function getMeasureDistanceMeters(
    a: { x: number; y: number } | null,
    b: { x: number; y: number } | null,
  ): number | null {
    if (!a || !b) return null;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy) * worldToM;
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

  /** Hit-test pipe endpoints (not segments). Returns the joint description: every pipe
   *  end + detector that's coincident with the closest endpoint under the cursor. This
   *  is what powers grip-style edits — dragging a joint moves all incident pipes and
   *  the detector (if any) together. Tolerance is screen-space pixels. */
  function nearestPipeEndpoint(pointer: PointerInfo, thresholdPx = 12): {
    joint: { x: number; y: number };
    endpoints: Array<{ kind: "auto" | "manual"; index: number; end: "from" | "to" }>;
    detectorIds: string[];
  } | null {
    const candidates: Array<{ x: number; y: number; ref: { kind: "auto" | "manual"; index: number; end: "from" | "to" } }> = [];
    if (pipesData?.pipes) {
      for (let i = 0; i < pipesData.pipes.length; i++) {
        const seg = pipesData.pipes[i];
        candidates.push({ x: seg.from[0], y: seg.from[1], ref: { kind: "auto", index: i, end: "from" } });
        candidates.push({ x: seg.to[0],   y: seg.to[1],   ref: { kind: "auto", index: i, end: "to" } });
      }
    }
    for (let i = 0; i < manualPipes.length; i++) {
      const seg = manualPipes[i];
      candidates.push({ x: seg.from[0], y: seg.from[1], ref: { kind: "manual", index: i, end: "from" } });
      candidates.push({ x: seg.to[0],   y: seg.to[1],   ref: { kind: "manual", index: i, end: "to" } });
    }

    let bestDist2 = thresholdPx * thresholdPx;
    let bestCand: typeof candidates[number] | null = null;
    for (const c of candidates) {
      const p = screenPointForWorld(c.x, c.y, 0.8);
      if (!p) continue;
      const dx = p.x - pointer.clientX, dy = p.y - pointer.clientY;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        bestCand = c;
      }
    }
    if (!bestCand) return null;

    /* Gather every pipe end + detector coincident with the picked endpoint. */
    const JOINT_EPS = 1e-3;
    const TOL2 = JOINT_EPS * JOINT_EPS;
    const joint = { x: bestCand.x, y: bestCand.y };
    const endpoints: Array<{ kind: "auto" | "manual"; index: number; end: "from" | "to" }> = [];
    for (const c of candidates) {
      const dx = c.x - joint.x, dy = c.y - joint.y;
      if (dx * dx + dy * dy <= TOL2) endpoints.push(c.ref);
    }
    const detectorIds: string[] = [];
    const visibleDetectors = selectedFloorId
      ? detectors.filter((d) => d.floor_plan_id === selectedFloorId)
      : detectors;
    for (const d of visibleDetectors) {
      const dx = d.x - joint.x, dy = d.y - joint.y;
      if (dx * dx + dy * dy <= TOL2) detectorIds.push(d.id);
    }
    return { joint, endpoints, detectorIds };
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
          /* Endpoint/joint grip-edit takes precedence over segment-select: if the user
           * clicks within a few pixels of any pipe-end, drag that joint (and every pipe
           * end + detector coincident with it) instead of selecting the segment. */
          if (!additive) {
            const jointHit = nearestPipeEndpoint(pointer);
            if (jointHit && jointHit.endpoints.length > 0) {
              evt.preventDefault();
              evt.stopPropagation();
              const pipeStarts = new Map<string, { from: [number, number]; to: [number, number] }>();
              for (const ep of jointHit.endpoints) {
                const key = `${ep.kind}:${ep.index}`;
                if (pipeStarts.has(key)) continue;
                const src = ep.kind === "auto"
                  ? pipesData?.pipes[ep.index]
                  : manualPipes[ep.index];
                if (!src) continue;
                pipeStarts.set(key, {
                  from: [src.from[0], src.from[1]],
                  to:   [src.to[0],   src.to[1]],
                });
              }
              const detectorStarts: Record<string, { x: number; y: number }> = {};
              for (const id of jointHit.detectorIds) {
                const d = detectors.find((x) => x.id === id);
                if (d) detectorStarts[id] = { x: d.x, y: d.y };
              }
              pipeEndpointDragRef.current = {
                startWorld: jointHit.joint,
                endpoints: jointHit.endpoints,
                pipeStarts,
                detectorIds: jointHit.detectorIds,
                detectorStarts,
                moved: false,
              };
              applySelectedIds(jointHit.detectorIds);
              setSelectedPipe(null);
              setPipeEditSnap([{ x: jointHit.joint.x, y: jointHit.joint.y, snapped: false }]);
              try { el.style.cursor = "grabbing"; } catch {}
              return;
            }
          }
          // No detector under cursor — try a pipe before falling back to marquee.
          const hitPipe = nearestPipe(pointer);
          if (hitPipe) {
            evt.preventDefault();
            evt.stopPropagation();
            /* Start a pipe-body translate. If the cursor never actually moves we'll
             * fall back to plain selection on pointer-up. */
            const seg = hitPipe.kind === "auto"
              ? pipesData?.pipes[hitPipe.index]
              : manualPipes[hitPipe.index];
            const world = worldPointFromPointer(pointer);
            if (seg && world) {
              pipeBodyDragRef.current = {
                ref: hitPipe,
                startWorld: world,
                startClient: { x: evt.clientX, y: evt.clientY },
                startFrom: [seg.from[0], seg.from[1]],
                startTo:   [seg.to[0],   seg.to[1]],
                moved: false,
              };
              try { el.style.cursor = "grabbing"; } catch {}
            }
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

        /* Snapshot every pipe endpoint that is anchored to (or coincident with) any of
         * the dragged detectors. The drag-move pass will translate those endpoints by
         * the same delta as the detector, keeping joints rigidly connected. */
        const JOINT_EPS = 1e-3;       // world units — generous for floating-point noise
        const dragIdSet = new Set(dragIds);
        const draggedAnchorPts = Object.values(startById);
        function followsDrag(
          end: [number, number],
          anchor: PipeEndpointAnchor | undefined,
        ): boolean {
          if (anchor?.kind === "detector" && dragIdSet.has(anchor.id)) return true;
          for (const p of draggedAnchorPts) {
            const dx = end[0] - p.x, dy = end[1] - p.y;
            if (dx * dx + dy * dy <= JOINT_EPS * JOINT_EPS) return true;
          }
          return false;
        }
        const pipeStarts = new Map<number, { from: [number, number]; to: [number, number]; followFrom: boolean; followTo: boolean }>();
        if (pipesData?.pipes) {
          for (let i = 0; i < pipesData.pipes.length; i++) {
            const seg = pipesData.pipes[i];
            const f = followsDrag(seg.from, seg.fromAnchor);
            const t = followsDrag(seg.to,   seg.toAnchor);
            if (f || t) {
              pipeStarts.set(i, {
                from: [seg.from[0], seg.from[1]],
                to:   [seg.to[0],   seg.to[1]],
                followFrom: f, followTo: t,
              });
            }
          }
        }
        const manualStarts = new Map<number, { from: [number, number]; to: [number, number]; followFrom: boolean; followTo: boolean }>();
        for (let i = 0; i < manualPipes.length; i++) {
          const seg = manualPipes[i];
          const f = followsDrag(seg.from, seg.fromAnchor);
          const t = followsDrag(seg.to,   seg.toAnchor);
          if (f || t) {
            manualStarts.set(i, {
              from: [seg.from[0], seg.from[1]],
              to:   [seg.to[0],   seg.to[1]],
              followFrom: f, followTo: t,
            });
          }
        }
        groupDragRef.current = { ids: dragIds, startWorld: world, startById, pipeStarts, manualStarts };
        try { el.style.cursor = "grabbing"; } catch {}
      }
    };

    const onPointerMove = (evt: PointerEvent) => {
      if (!canEdit || tool !== "select") return;

      /* Schedule a state update on the next animation frame, replacing any pending
       * payload so we never run more state work than the screen can render. */
      function scheduleDragFrame(fn: () => void) {
        const slot = pipeDragRafRef.current;
        if (slot) { slot.pending = fn; return; }
        const raf = requestAnimationFrame(() => {
          const s = pipeDragRafRef.current;
          pipeDragRafRef.current = null;
          if (s?.pending) s.pending();
        });
        pipeDragRafRef.current = { raf, pending: fn };
      }

      /* Pipe-body translate — drag the whole segment by both endpoints. Each endpoint
       * snaps independently to a nearby pipe-end / sprinkler / source so the moved
       * pipe re-joins the network on release; both endpoints show a live snap dot. */
      if (pipeBodyDragRef.current) {
        const world = worldPointFromPointer({ clientX: evt.clientX, clientY: evt.clientY });
        if (!world) return;
        evt.preventDefault();
        evt.stopPropagation();
        const drag = pipeBodyDragRef.current;
        const dx = world.x - drag.startWorld.x;
        const dy = world.y - drag.startWorld.y;
        /* Tap-vs-drag threshold uses pixel distance so it doesn't change with zoom.
         * Real mouse clicks always exceed a tiny world-units threshold, so the previous
         * 1e-8 check effectively never registered clicks as taps. */
        if (!drag.moved) {
          const pdx = evt.clientX - drag.startClient.x;
          const pdy = evt.clientY - drag.startClient.y;
          if (pdx * pdx + pdy * pdy < 16) return;   // < 4 px → still a click
        }
        drag.moved = true;
        const rawFrom: [number, number] = [drag.startFrom[0] + dx, drag.startFrom[1] + dy];
        const rawTo:   [number, number] = [drag.startTo[0]   + dx, drag.startTo[1]   + dy];
        /* Snap each endpoint independently, excluding the moving pipe's own ends. */
        const excludeKeys = new Set([
          `${drag.ref.kind}:${drag.ref.index}:from`,
          `${drag.ref.kind}:${drag.ref.index}:to`,
        ]);
        const snapFrom = snapPipeEndpoint({ x: rawFrom[0], y: rawFrom[1] }, 16, { pipeEndpointKeys: excludeKeys });
        const snapTo   = snapPipeEndpoint({ x: rawTo[0],   y: rawTo[1]   }, 16, { pipeEndpointKeys: excludeKeys });
        const newFrom: [number, number] = [snapFrom.point.x, snapFrom.point.y];
        const newTo:   [number, number] = [snapTo.point.x,   snapTo.point.y];
        const snappedFrom = snapFrom.anchor !== undefined || snapFrom.point.x !== rawFrom[0] || snapFrom.point.y !== rawFrom[1];
        const snappedTo   = snapTo.anchor   !== undefined || snapTo.point.x   !== rawTo[0]   || snapTo.point.y   !== rawTo[1];
        scheduleDragFrame(() => {
          setPipeEditSnap([
            { x: newFrom[0], y: newFrom[1], snapped: snappedFrom, split: snapFrom.splitTarget !== undefined },
            { x: newTo[0],   y: newTo[1],   snapped: snappedTo,   split: snapTo.splitTarget   !== undefined },
          ]);
          if (drag.ref.kind === "auto") {
            setPipesData((prev) => {
              if (!prev) return prev;
              const next = prev.pipes.slice();
              const cur = next[drag.ref.index];
              if (cur) {
                next[drag.ref.index] = { ...cur, from: newFrom, to: newTo, fromAnchor: undefined, toAnchor: undefined };
              }
              return { ...prev, pipes: next };
            });
          } else {
            setManualPipes((prev) => {
              const next = prev.slice();
              const cur = next[drag.ref.index];
              if (cur) {
                next[drag.ref.index] = { ...cur, from: newFrom, to: newTo, fromAnchor: undefined, toAnchor: undefined };
              }
              return next;
            });
          }
        });
        return;
      }

      /* Pipe endpoint / joint drag — runs before marquee + detector-group drag so the
       * grip edit is never preempted. */
      if (pipeEndpointDragRef.current) {
        const world = worldPointFromPointer({ clientX: evt.clientX, clientY: evt.clientY });
        if (!world) return;
        evt.preventDefault();
        evt.stopPropagation();
        const drag = pipeEndpointDragRef.current;
        /* Snap the moving joint to any other detector / source / pipe-end nearby, but
         * exclude the endpoints + detectors that are being dragged (otherwise the joint
         * would always self-snap to its previous frame's position). */
        const excludeDetectorIds = new Set(drag.detectorIds);
        const excludePipeKeys = new Set(drag.endpoints.map((e) => `${e.kind}:${e.index}:${e.end}`));
        const snap = snapPipeEndpoint(world, 16, {
          detectorIds: excludeDetectorIds,
          pipeEndpointKeys: excludePipeKeys,
        });
        const target = snap.point;
        const snapped = snap.anchor !== undefined || snap.splitTarget !== undefined || (target.x !== world.x || target.y !== world.y);

        const autoUpdates: Array<{ index: number; end: "from" | "to" }> = [];
        const manualUpdates: Array<{ index: number; end: "from" | "to" }> = [];
        for (const ep of drag.endpoints) {
          (ep.kind === "auto" ? autoUpdates : manualUpdates).push({ index: ep.index, end: ep.end });
        }
        scheduleDragFrame(() => {
          setPipeEditSnap([{ x: target.x, y: target.y, snapped, split: snap.splitTarget !== undefined }]);
          if (autoUpdates.length > 0) {
            setPipesData((prev) => {
              if (!prev) return prev;
              const next = prev.pipes.slice();
              for (const u of autoUpdates) {
                const cur = next[u.index];
                if (!cur) continue;
                next[u.index] = {
                  ...cur,
                  from: u.end === "from" ? [target.x, target.y] : cur.from,
                  to:   u.end === "to"   ? [target.x, target.y] : cur.to,
                };
              }
              return { ...prev, pipes: next };
            });
          }
          if (manualUpdates.length > 0) {
            setManualPipes((prev) => {
              const next = prev.slice();
              for (const u of manualUpdates) {
                const cur = next[u.index];
                if (!cur) continue;
                next[u.index] = {
                  ...cur,
                  from: u.end === "from" ? [target.x, target.y] : cur.from,
                  to:   u.end === "to"   ? [target.x, target.y] : cur.to,
                };
              }
              return next;
            });
          }
          if (drag.detectorIds.length > 0) {
            setDetectors((prev) => prev.map((d) =>
              drag.detectorIds.includes(d.id) ? { ...d, x: target.x, y: target.y } : d,
            ));
          }
        });
        drag.moved = true;
        return;
      }

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
      /* Auto-routed pipes: translate every captured endpoint by the same delta. */
      if (drag.pipeStarts.size > 0) {
        setPipesData((prev) => {
          if (!prev) return prev;
          const next = prev.pipes.map((seg, i) => {
            const cap = drag.pipeStarts.get(i);
            if (!cap) return seg;
            return {
              ...seg,
              from: cap.followFrom ? [cap.from[0] + dx, cap.from[1] + dy] as [number, number] : seg.from,
              to:   cap.followTo   ? [cap.to[0]   + dx, cap.to[1]   + dy] as [number, number] : seg.to,
            };
          });
          return { ...prev, pipes: next };
        });
      }
      /* Manual pipes: same treatment. */
      if (drag.manualStarts.size > 0) {
        setManualPipes((prev) =>
          prev.map((seg, i) => {
            const cap = drag.manualStarts.get(i);
            if (!cap) return seg;
            return {
              ...seg,
              from: cap.followFrom ? [cap.from[0] + dx, cap.from[1] + dy] as [number, number] : seg.from,
              to:   cap.followTo   ? [cap.to[0]   + dx, cap.to[1]   + dy] as [number, number] : seg.to,
            };
          }),
        );
      }
      setHasManualChanges(true);
    };

    const onPointerUp = (evt: PointerEvent) => {
      /* Helper: rebuild a pipe array by applying any number of in-place mutations
       * (typically anchor/coordinate updates on dragged pipes) and then splitting
       * any number of target pipes at given (t, point) pairs into chains of
       * contiguous sub-segments. Mutations apply first at their original indices;
       * splits then process from highest index downward so earlier indices remain
       * valid as we splice replacements in. */
      function applyMutationAndSplits<T extends PipeSegment>(
        arr: T[],
        mutates: Array<{ index: number; from?: [number, number]; to?: [number, number]; fromAnchor?: PipeEndpointAnchor; toAnchor?: PipeEndpointAnchor; setFromAnchor?: boolean; setToAnchor?: boolean }>,
        splits: Array<{ index: number; t: number; point: [number, number] }>,
      ): T[] {
        let next = arr.slice();
        for (const m of mutates) {
          const c = next[m.index];
          if (!c) continue;
          next[m.index] = {
            ...c,
            from: m.from ?? c.from,
            to: m.to ?? c.to,
            fromAnchor: m.setFromAnchor ? m.fromAnchor : c.fromAnchor,
            toAnchor: m.setToAnchor ? m.toAnchor : c.toAnchor,
          } as T;
        }
        if (splits.length === 0) return next;
        const byIndex = new Map<number, Array<{ t: number; point: [number, number] }>>();
        for (const s of splits) {
          const list = byIndex.get(s.index) ?? [];
          list.push({ t: s.t, point: s.point });
          byIndex.set(s.index, list);
        }
        const indices = Array.from(byIndex.keys()).sort((a, b) => b - a);
        for (const idx of indices) {
          const orig = next[idx];
          if (!orig) continue;
          const splitsAtIdx = byIndex.get(idx)!.sort((a, b) => a.t - b.t);
          const points: Array<[number, number]> = [orig.from];
          for (const s of splitsAtIdx) points.push(s.point);
          points.push(orig.to);
          const replacement: T[] = [];
          for (let i = 0; i < points.length - 1; i++) {
            const isFirst = i === 0;
            const isLast = i === points.length - 2;
            replacement.push({
              ...orig,
              from: points[i],
              to: points[i + 1],
              fromAnchor: isFirst ? orig.fromAnchor : undefined,
              toAnchor: isLast ? orig.toAnchor : undefined,
            } as T);
          }
          next.splice(idx, 1, ...replacement);
        }
        return next;
      }

      /* Finalize pipe-body translate (or convert to a plain selection if not moved).
       * On release we redo a fresh snap test and, when an endpoint locks onto a
       * sprinkler/source, bake the anchor so subsequent sprinkler drags carry the
       * pipe along — exactly like dropping a wire onto a terminal. Mid-segment snaps
       * additionally split the target pipe into a real T-junction. */
      if (pipeBodyDragRef.current) {
        const drag = pipeBodyDragRef.current;
        if (drag.moved) {
          const world = worldPointFromPointer({ clientX: evt.clientX, clientY: evt.clientY });
          if (world) {
            const dx = world.x - drag.startWorld.x;
            const dy = world.y - drag.startWorld.y;
            const rawFrom: [number, number] = [drag.startFrom[0] + dx, drag.startFrom[1] + dy];
            const rawTo:   [number, number] = [drag.startTo[0]   + dx, drag.startTo[1]   + dy];
            const excludeKeys = new Set([
              `${drag.ref.kind}:${drag.ref.index}:from`,
              `${drag.ref.kind}:${drag.ref.index}:to`,
            ]);
            const excludeSegKeys = new Set([`${drag.ref.kind}:${drag.ref.index}`]);
            const snapFrom = snapPipeEndpoint({ x: rawFrom[0], y: rawFrom[1] }, 16, { pipeEndpointKeys: excludeKeys, pipeSegmentKeys: excludeSegKeys });
            const snapTo   = snapPipeEndpoint({ x: rawTo[0],   y: rawTo[1]   }, 16, { pipeEndpointKeys: excludeKeys, pipeSegmentKeys: excludeSegKeys });
            const finalFrom: [number, number] = [snapFrom.point.x, snapFrom.point.y];
            const finalTo:   [number, number] = [snapTo.point.x,   snapTo.point.y];

            const autoSplits: Array<{ index: number; t: number; point: [number, number] }> = [];
            const manualSplits: Array<{ index: number; t: number; point: [number, number] }> = [];
            if (snapFrom.splitTarget) {
              (snapFrom.splitTarget.pipeKind === "auto" ? autoSplits : manualSplits)
                .push({ index: snapFrom.splitTarget.pipeIndex, t: snapFrom.splitTarget.t, point: finalFrom });
            }
            if (snapTo.splitTarget) {
              (snapTo.splitTarget.pipeKind === "auto" ? autoSplits : manualSplits)
                .push({ index: snapTo.splitTarget.pipeIndex, t: snapTo.splitTarget.t, point: finalTo });
            }

            if (drag.ref.kind === "auto") {
              setPipesData((prev) => {
                if (!prev) return prev;
                const nextPipes = applyMutationAndSplits(
                  prev.pipes,
                  [{ index: drag.ref.index, from: finalFrom, to: finalTo, fromAnchor: snapFrom.anchor, toAnchor: snapTo.anchor, setFromAnchor: true, setToAnchor: true }],
                  autoSplits,
                );
                return { ...prev, pipes: nextPipes };
              });
              if (manualSplits.length > 0) {
                setManualPipes((prev) => applyMutationAndSplits(prev, [], manualSplits));
              }
              setPipesModified(true);
            } else {
              setManualPipes((prev) => applyMutationAndSplits(
                prev,
                [{ index: drag.ref.index, from: finalFrom, to: finalTo, fromAnchor: snapFrom.anchor, toAnchor: snapTo.anchor, setFromAnchor: true, setToAnchor: true }],
                manualSplits,
              ));
              if (autoSplits.length > 0) {
                setPipesData((prev) => {
                  if (!prev) return prev;
                  return { ...prev, pipes: applyMutationAndSplits(prev.pipes, [], autoSplits) };
                });
                setPipesModified(true);
              }
            }
          }
          setHasManualChanges(true);
        } else {
          /* Tiny-click → treat as selection. */
          applySelectedIds([]);
          setSelectedPipe(drag.ref);
        }
        pipeBodyDragRef.current = null;
        setPipeEditSnap(null);
        if (pipeDragRafRef.current) {
          cancelAnimationFrame(pipeDragRafRef.current.raf);
          pipeDragRafRef.current = null;
        }
        try { (containerRef.current!).style.cursor = ""; } catch {}
        return;
      }

      /* Finalize a pipe-endpoint / joint drag. If the user released onto a snap target
       * (detector or source), bake that as an explicit anchor on every captured pipe
       * end so subsequent detector drags carry the pipe joint along automatically. */
      if (pipeEndpointDragRef.current) {
        const drag = pipeEndpointDragRef.current;
        if (drag.moved) {
          const world = worldPointFromPointer({ clientX: evt.clientX, clientY: evt.clientY });
          if (world) {
            const excludeDetectorIds = new Set(drag.detectorIds);
            const excludePipeKeys = new Set(drag.endpoints.map((e) => `${e.kind}:${e.index}:${e.end}`));
            const excludeSegKeys = new Set(drag.endpoints.map((e) => `${e.kind}:${e.index}`));
            const snap = snapPipeEndpoint(world, 16, {
              detectorIds: excludeDetectorIds,
              pipeEndpointKeys: excludePipeKeys,
              pipeSegmentKeys: excludeSegKeys,
            });
            const newAnchor: PipeEndpointAnchor | undefined = snap.anchor;
            const finalPoint: [number, number] = [snap.point.x, snap.point.y];
            const autoEps = drag.endpoints.filter((e) => e.kind === "auto");
            const manualEps = drag.endpoints.filter((e) => e.kind === "manual");

            const autoMutates = autoEps.map((ep) => ({
              index: ep.index,
              fromAnchor: ep.end === "from" ? newAnchor : undefined,
              toAnchor:   ep.end === "to"   ? newAnchor : undefined,
              setFromAnchor: ep.end === "from",
              setToAnchor:   ep.end === "to",
            }));
            const manualMutates = manualEps.map((ep) => ({
              index: ep.index,
              fromAnchor: ep.end === "from" ? newAnchor : undefined,
              toAnchor:   ep.end === "to"   ? newAnchor : undefined,
              setFromAnchor: ep.end === "from",
              setToAnchor:   ep.end === "to",
            }));
            const autoSplits: Array<{ index: number; t: number; point: [number, number] }> = [];
            const manualSplits: Array<{ index: number; t: number; point: [number, number] }> = [];
            if (snap.splitTarget) {
              (snap.splitTarget.pipeKind === "auto" ? autoSplits : manualSplits)
                .push({ index: snap.splitTarget.pipeIndex, t: snap.splitTarget.t, point: finalPoint });
            }

            if (autoMutates.length > 0 || autoSplits.length > 0) {
              setPipesData((prev) => {
                if (!prev) return prev;
                return { ...prev, pipes: applyMutationAndSplits(prev.pipes, autoMutates, autoSplits) };
              });
              setPipesModified(true);
            }
            if (manualMutates.length > 0 || manualSplits.length > 0) {
              setManualPipes((prev) => applyMutationAndSplits(prev, manualMutates, manualSplits));
            }
          }
          setHasManualChanges(true);
        }
        pipeEndpointDragRef.current = null;
        setPipeEditSnap(null);
        if (pipeDragRafRef.current) {
          cancelAnimationFrame(pipeDragRafRef.current.raf);
          pipeDragRafRef.current = null;
        }
        try { el.style.cursor = ""; } catch {}
        return;
      }

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
      try { el.style.cursor = ""; } catch {}
    };

    el.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, { passive: false, capture: true });
    window.addEventListener("pointerup", onPointerUp, true);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
    };
  }, [tool, addType, draggingDetectorId, detectors, selectedFloorId, canEdit, selectedDetectorIds, manualPipes, pipesData]);

  /* ────────────────────────────────────────────────────────────────────────────
   * Cursor / hover feedback
   * Picks a CSS cursor based on the active tool and (for the select tool) what
   * lies under the pointer — detector, pipe-end joint, pipe body, or empty
   * canvas. Uses direct style mutation (no React state) so move events don't
   * trigger re-renders. */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!canEdit) { el.style.cursor = "default"; return; }
    const baseCursor =
      tool === "pan"        ? "grab" :
      tool === "add"        ? "copy" :
      tool === "erase"      ? "crosshair" :
      tool === "draw-pipe"  ? "crosshair" :
      tool === "measure"    ? "crosshair" :
      /* select */            "default";
    el.style.cursor = baseCursor;
    if (tool !== "select") return;

    const onMove = (evt: PointerEvent) => {
      // While any drag is active, the drag-start handler already sets the cursor.
      if (
        pipeEndpointDragRef.current ||
        pipeBodyDragRef.current ||
        groupDragRef.current ||
        marqueeRef.current
      ) return;
      const pointer = { clientX: evt.clientX, clientY: evt.clientY };
      const hitDet = nearestDetectorId(pointer);
      if (hitDet) { el.style.cursor = "grab"; return; }
      const jointHit = nearestPipeEndpoint(pointer);
      if (jointHit && jointHit.endpoints.length > 0) {
        el.style.cursor = "crosshair";
        return;
      }
      const hitPipe = nearestPipe(pointer);
      if (hitPipe) { el.style.cursor = "move"; return; }
      el.style.cursor = "default";
    };
    el.addEventListener("pointermove", onMove);
    return () => { el.removeEventListener("pointermove", onMove); };
  }, [tool, canEdit, detectors, pipesData, manualPipes, selectedFloorId]);

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

      // Merge like the editor: replace this type's detectors with the new
      // results, but ONLY for the floor we just ran automation on. Detectors
      // belonging to other floor plans must remain untouched (the backend
      // also scopes its delete by floor_plan_id, so they were never removed
      // server-side either).
      const isCurrentFloor = (d: Detector) => d.floor_plan_id === selectedFloorId;
      setDetectors(prev => {
        if (dtype === "mcp_hooter") {
          return [
            ...prev.filter(d => !isCurrentFloor(d) || (d.dtype !== "mcb" && d.dtype !== "hooter")),
            ...placed.filter(d => d.dtype === "mcb" || d.dtype === "hooter"),
          ];
        }
        return [
          ...prev.filter(d => !isCurrentFloor(d) || d.dtype !== dtype),
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

  // ── Export DWG ──
  // Same flow as exportDxf, but downloads the DWG sibling produced by the
  // backend (via ODA File Converter) after /save.
  async function exportDwg() {
    if (!projectId) return;
    setIsExportingDwg(true);
    try {
      const token = getToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

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
          console.warn("Failed to upload manual pipes prior to DWG export:", e);
        }
      }

      const saveRes = await fetch(apiUrl(`/api/projects/${projectId}/save`), {
        method: "POST",
        headers,
      });
      if (!saveRes.ok) {
        const text = await saveRes.text();
        throw new Error(text || `Failed to generate output DWG (${saveRes.status})`);
      }
      const proj = await saveRes.json();
      const outputDwg = proj?.files?.output_dwg as string | undefined;
      if (!outputDwg) {
        throw new Error(
          "Backend did not produce a DWG (ODA File Converter may be unavailable).",
        );
      }

      const fileRes = await fetch(apiUrl(outputDwg), { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!fileRes.ok) {
        throw new Error(`Failed to download output DWG (${fileRes.status})`);
      }
      const blob = await fileRes.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${projectName || "drawing"}_with_equipment.dwg`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      console.error("DWG export failed", e);
      setManualEditMsg(e?.message || "Failed to export DWG.");
    } finally {
      setIsExportingDwg(false);
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
      const rawWorld = worldPointFromPointer({ clientX: evt.clientX, clientY: evt.clientY });
      if (!rawWorld) return;
      /* Snap to the nearest sprinkler / source / pipe-end so joints stay tight. */
      const snap = snapPipeEndpoint(rawWorld);
      const world = snap.point;

      if (!pipeDrawStart) {
        // First click: anchor start point
        pipeDrawStartAnchorRef.current = snap.anchor;
        setPipeDrawStart(world);
        setPipeDrawPreview(world);
      } else {
        // Second click: commit the pipe segment with anchor metadata.
        const seg: PipeSegment = {
          from: [pipeDrawStart.x, pipeDrawStart.y] as [number, number],
          to: [world.x, world.y] as [number, number],
          diameter: `${pipeDrawDiameter}mm`,
          fromAnchor: pipeDrawStartAnchorRef.current,
          toAnchor: snap.anchor,
        };
        setManualPipes((prev) => [...prev, seg]);
        // Chain: new start is current endpoint for continuous drawing
        pipeDrawStartAnchorRef.current = snap.anchor;
        setPipeDrawStart(world);
        setPipeDrawPreview(world);
      }
    };

    const onPointerMove = (evt: PointerEvent) => {
      if (!pipeDrawStart) return;
      const rawWorld = worldPointFromPointer({ clientX: evt.clientX, clientY: evt.clientY });
      if (!rawWorld) return;
      /* Preview also snaps so the user sees the tightening effect before committing. */
      setPipeDrawPreview(snapPipeEndpoint(rawWorld).point);
    };

    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") {
        setPipeDrawStart(null);
        setPipeDrawPreview(null);
        pipeDrawStartAnchorRef.current = undefined;
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

  // Measure distance between any two points (with snapping to nearby elements).
  useEffect(() => {
    if (tool !== "measure") return;
    const el = containerRef.current;
    if (!el) return;

    const pickPoint = (evt: PointerEvent): { x: number; y: number } | null => {
      const pointer = { clientX: evt.clientX, clientY: evt.clientY };
      const snapped = nearestMeasureAnchor(pointer);
      if (snapped) return snapped;
      return worldPointFromPointer(pointer);
    };

    const onPointerDown = (evt: PointerEvent) => {
      const tgt = evt.target as Element | null;
      if (tgt && tgt.closest && tgt.closest("[data-ui-overlay]")) return;
      evt.preventDefault();
      evt.stopPropagation();
      const point = pickPoint(evt);
      if (!point) return;

      if (!measureStart || measureEnd) {
        setMeasureStart(point);
        setMeasureEnd(null);
        setMeasurePreview(point);
      } else {
        setMeasureEnd(point);
        setMeasurePreview(null);
      }
    };

    const onPointerMove = (evt: PointerEvent) => {
      if (!measureStart || measureEnd) return;
      const point = pickPoint(evt);
      if (point) setMeasurePreview(point);
    };

    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") {
        setMeasureStart(null);
        setMeasureEnd(null);
        setMeasurePreview(null);
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
  }, [tool, measureStart, measureEnd, detectors, manualPipes, pipesData, chosenSource, detectedSources, selectedFloorId]);

  const measureDistanceM = getMeasureDistanceMeters(measureStart, measureEnd || measurePreview);

  return (
    <main
      style={{
        position: "fixed", inset: 0,
        display: "flex", flexDirection: "column",
        fontFamily: "'Segoe UI', 'Helvetica Neue', system-ui, sans-serif",
        background: SD.bg, color: SD.text,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          borderBottom: `1px solid ${SD.border}`,
          background: SD.surface,
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 12px",
            borderBottom: `1px solid ${SD.divider}`,
            background: SD.surfaceAlt,
            minHeight: 32,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <a
              href={`/p/${projectId}`}
              style={{ color: SD.accent, textDecoration: "none", fontSize: 12 }}
            >
              ← Back
            </a>
            <span style={{ color: SD.divider }}>│</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: SD.text }}>
              {projectName || "Untitled Drawing"}
            </span>
            <span style={{ fontSize: 11, color: SD.textMuted }}>
              {canEdit ? `· ${tool.toUpperCase()}` : "· View only"}
              {measureDistanceM != null ? ` · ${measureDistanceM.toFixed(3)} m` : ""}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              style={{ ...btnStyle, padding: "3px 10px", fontSize: 11 }}
              onClick={saveManualEdits}
              disabled={!hasManualChanges || isSavingEdits}
              title="Save"
            >
              {isSavingEdits ? "Saving…" : hasManualChanges ? "Save" : "Saved"}
            </button>
            <button
              style={{ ...btnStyle, padding: "3px 10px", fontSize: 11 }}
              onClick={exportDxf}
              disabled={!dxfUrl || isExportingDxf}
              title="Export DXF"
            >
              {isExportingDxf ? "Exporting…" : "↓ DXF"}
            </button>
            <button
              style={{ ...btnStyle, padding: "3px 10px", fontSize: 11 }}
              onClick={exportDwg}
              disabled={!dxfUrl || isExportingDwg}
              title="Export DWG"
            >
              {isExportingDwg ? "…" : "↓ DWG"}
            </button>
            <div style={{
              width: 26, height: 26, borderRadius: "50%",
              background: SD.accent, color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 700,
            }}>
              U
            </div>
          </div>
        </div>

        <div style={{
          display: "flex", gap: 0,
          padding: "0 12px",
          background: SD.surfaceAlt,
          borderBottom: `1px solid ${SD.border}`,
        }}>
          <button onClick={() => setRibbonTab("home")} style={ribbonTabBtn(ribbonTab === "home")}>Edit</button>
          <button onClick={() => setRibbonTab("insert")} style={ribbonTabBtn(ribbonTab === "insert")}>Pipes</button>
          <button onClick={() => setRibbonTab("automation")} style={ribbonTabBtn(ribbonTab === "automation")}>Automation</button>
        </div>

        <div
          style={{
            display: "flex",
            gap: 0,
            alignItems: "stretch",
            padding: "4px 8px",
            background: SD.surface,
            minHeight: 70,
          }}
        >
          {ribbonTab === "home" ? (
            <>
              {canEdit ? (
                <div style={ribbonGroupStyle}>
                  <div style={ribbonGroupTitleStyle}>Placement</div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <select
                      value={addType}
                      onChange={(e) => setAddType(e.target.value)}
                      style={{
                        background: "#E8EAED",
                        color: "#1A1A2E",
                        border: "1px solid #E8EAED",
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
                        background: "#2D6A4F",
                        borderColor: "#2D6A4F",
                        color: "#08130b",
                        opacity: (!hasManualChanges || isSavingEdits) ? 0.6 : 1,
                        cursor: (!hasManualChanges || isSavingEdits) ? "not-allowed" : "pointer",
                      }}
                    >
                      {isSavingEdits ? "Saving..." : hasManualChanges ? "Save Edits" : "Saved"}
                    </button>
                    {selectedDetectorIds.length > 0 ? (
                      <span style={{ fontSize: 11, color: "#6B7280" }}>Selected: {selectedDetectorIds.length}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div style={ribbonGroupStyle}>
                <div style={ribbonGroupTitleStyle}>Export</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    onClick={exportDxf}
                    disabled={!dxfUrl || isExportingDxf}
                    style={{
                      ...btnStyle,
                      background: "#2D6A4F",
                      borderColor: "#1F4A37",
                      color: "#fff",
                      opacity: (!dxfUrl || isExportingDxf) ? 0.6 : 1,
                      cursor: (!dxfUrl || isExportingDxf) ? "not-allowed" : "pointer",
                    }}
                  >
                    {isExportingDxf ? "Exporting..." : "⬇ Export DXF"}
                  </button>
                  <button
                    onClick={exportDwg}
                    disabled={!dxfUrl || isExportingDwg}
                    style={{
                      ...btnStyle,
                      background: "#2D6A4F",
                      borderColor: "#1F4A37",
                      color: "#fff",
                      opacity: (!dxfUrl || isExportingDwg) ? 0.6 : 1,
                      cursor: (!dxfUrl || isExportingDwg) ? "not-allowed" : "pointer",
                    }}
                  >
                    {isExportingDwg ? "Converting..." : "⬇ Export DWG"}
                  </button>
                </div>
              </div>

            </>
          ) : null}

          {ribbonTab === "insert" ? (
            <>
              {canEdit ? (
                <div style={ribbonGroupStyle}>
                  <div style={ribbonGroupTitleStyle}>Draw Pipe</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 240 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12, color: "#6B7280" }}>Diameter:</span>
                      <select
                        value={pipeDrawDiameter}
                        onChange={(e) => setPipeDrawDiameter(Number(e.target.value))}
                        style={{
                          background: "#E8EAED", color: "#1A1A2E",
                          border: "1px solid #E8EAED", borderRadius: 6,
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
                          borderColor: tool === "draw-pipe" ? "#2D6A4F" : "#E8EAED",
                          color: tool === "draw-pipe" ? "#fff" : btnStyle.color,
                        }}
                      >
                        {tool === "draw-pipe" ? "✏ Drawing (Esc to stop)" : "✏ Draw Pipe"}
                      </button>
                    </div>
                    {tool === "draw-pipe" ? (
                      <div style={{ fontSize: 11, color: "#2D6A4F", lineHeight: 1.4 }}>
                        {pipeDrawStart
                          ? "Click to end segment. Click again to chain. Esc to finish."
                          : "Click on drawing to start a pipe segment."}
                      </div>
                    ) : null}
                    {manualPipes.length > 0 ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 11, color: "#6B7280" }}>{manualPipes.length} manual pipe{manualPipes.length !== 1 ? "s" : ""}</span>
                        <button
                          onClick={() => {
                            setManualPipes([]);
                            setPipeDrawStart(null);
                            setPipeDrawPreview(null);
                          }}
                          style={{ ...btnStyle, background: "#B42318", borderColor: "#7A1810", color: "#fff", padding: "3px 8px", fontSize: 11 }}
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

              <div style={ribbonGroupStyle}>
                <div style={ribbonGroupTitleStyle}>Measure</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 260 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      onClick={() => setTool("measure")}
                      style={{
                        ...btnStyle,
                        background: tool === "measure" ? "#0891b2" : btnStyle.background,
                        borderColor: tool === "measure" ? "#0e7490" : "#E8EAED",
                        color: tool === "measure" ? "#ecfeff" : btnStyle.color,
                      }}
                    >
                      📏 Measure Distance
                    </button>
                    <button
                      onClick={() => {
                        setMeasureStart(null);
                        setMeasureEnd(null);
                        setMeasurePreview(null);
                      }}
                      style={btnStyle}
                    >
                      Clear
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: "#6B7280", lineHeight: 1.4 }}>
                    {tool === "measure"
                      ? (measureStart
                        ? (measureEnd ? "Click again to start a new measurement. Esc clears."
                          : "Click second point to finish. Snaps to nearby detectors/pipes/sources.")
                        : "Click first point to start measuring.")
                      : "Activate Measure, then click any two points."}
                  </div>
                  {measureDistanceM != null ? (
                    <div style={{ fontSize: 12, color: "#67e8f9", fontWeight: 600 }}>
                      Distance: {measureDistanceM.toFixed(3)} m
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}

          {ribbonTab === "automation" ? (
            <>
              {canEdit ? (
                <div style={ribbonGroupStyle}>
                  <div style={ribbonGroupTitleStyle}>Auto-place Equipment</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 320 }}>
                    {!selectedFloorId ? (
                      <div style={{ fontSize: 11, color: "#9AA1AC" }}>
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
                              border: "1px solid #E8EAED",
                              background: isPlacing ? "#E7F1EC" : "#F0F2F5",
                              color: disabled && !isPlacing ? "#9AA1AC" : "#1A1A2E",
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
                            <span style={{ fontSize: 10, color: "#9AA1AC" }}>
                              {isPlacing ? "Placing..." : placed > 0 ? `${placed} placed` : ""}
                            </span>
                          </button>
                        );
                      });
                    })()}
                    {autoPlaceMsg ? (
                      <div style={{ fontSize: 11, color: "#6B7280", paddingTop: 2, lineHeight: 1.4 }}>
                        {autoPlaceMsg}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div style={ribbonGroupStyle}>
                  <div style={ribbonGroupTitleStyle}>Automation</div>
                  <div style={{ fontSize: 12, color: "#6B7280" }}>Viewer role cannot run automation.</div>
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
                      background: sourceSelectMode ? "#D97706" : "#B42318",
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
                      background: sourceSelectMode && chosenSource ? "#2D6A4F" : btnStyle.background,
                      borderColor: sourceSelectMode && chosenSource ? "#15803d" : "#E8EAED",
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
                      background: "#B42318",
                      borderColor: "#7A1810",
                      color: "#fff",
                      opacity: !canEdit || !hasPipeData || isRoutingPipes || isDetectingSources || isClearingPipes ? 0.6 : 1,
                      cursor: !canEdit || !hasPipeData || isRoutingPipes || isDetectingSources || isClearingPipes ? "not-allowed" : "pointer",
                    }}
                    title={hasPipeData ? (selectedFloorId ? "Clear pipes for selected block" : "Clear project pipes") : "No pipes to clear"}
                  >
                    {isClearingPipes ? "Clearing..." : selectedFloorId ? "Clear Pipes (Block)" : "Clear Pipes"}
                  </button>
                  <span style={{ fontSize: 11, color: "#6B7280" }}>
                    {pipesData?.pipes?.length ? `${pipesData.pipes.length} segment${pipesData.pipes.length === 1 ? "" : "s"}` : "No pipes yet"}
                  </span>
                </div>
              </div>
            </>
          ) : null}

        </div>
      </header>

      {/* SmartDraw-style body: left sidebar + center workspace */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        {/* ── Left sidebar ───────────────────────────────── */}
        <aside style={sidebarCollapsed ? sidebarCollapsedStyle : sidebarStyle}>
          {sidebarCollapsed ? (
            <button
              onClick={() => setSidebarCollapsed(false)}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              style={{
                width: "100%",
                padding: "10px 0",
                background: SD.surfaceAlt,
                border: "none",
                borderBottom: `1px solid ${SD.divider}`,
                color: SD.text,
                cursor: "pointer",
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              ▶
            </button>
          ) : (
          <div style={{ overflowY: "auto", flex: 1 }}>
            {/* Collapse toggle */}
            <div style={{ ...sidebarSectionTitleStyle, borderTop: "none" }}>
              <span>Tools</span>
              <button
                onClick={() => setSidebarCollapsed(true)}
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
                style={{
                  background: "transparent",
                  border: "none",
                  color: SD.text,
                  cursor: "pointer",
                  padding: "0 4px",
                  fontSize: 12,
                  lineHeight: 1,
                }}
              >
                ◀
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, padding: 8 }}>
              {([
                { key: "pan", label: "Pan", icon: "✋" },
                { key: "select", label: "Select", icon: "↖" },
                { key: "add", label: "Place", icon: "✛" },
                { key: "draw-pipe", label: "Line", icon: "╱" },
                { key: "measure", label: "Measure", icon: "📏" },
                { key: "erase", label: "Erase", icon: "✕" },
              ] as const).map((t) => {
                const active = tool === t.key;
                return (
                  <button
                    key={t.key}
                    disabled={!canEdit && t.key !== "pan" && t.key !== "measure"}
                    onClick={() => setTool(t.key as any)}
                    title={t.label}
                    style={{
                      display: "flex", flexDirection: "column",
                      alignItems: "center", justifyContent: "center",
                      gap: 2,
                      padding: "8px 4px",
                      background: active ? SD.active : SD.surface,
                      border: `1px solid ${active ? SD.activeBorder : SD.border}`,
                      borderRadius: 4,
                      cursor: "pointer",
                      color: SD.text,
                      fontSize: 10,
                      minHeight: 48,
                    }}
                  >
                    <span style={{ fontSize: 16, lineHeight: 1 }}>{t.icon}</span>
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Panel toggles */}
            <div style={{ padding: "4px 8px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
              <button
                onClick={() => setShowLayers((v) => !v)}
                style={{
                  ...sidebarItemStyle,
                  padding: "6px 10px",
                  border: `1px solid ${SD.border}`,
                  borderRadius: 4,
                  background: showLayers ? SD.active : SD.surface,
                  fontWeight: 500,
                }}
              >
                <span style={{ fontSize: 14 }}>☰</span>
                <span>Layers ({layers.length})</span>
              </button>
              <button
                onClick={() => setShowBlocks((v) => !v)}
                style={{
                  ...sidebarItemStyle,
                  padding: "6px 10px",
                  border: `1px solid ${SD.border}`,
                  borderRadius: 4,
                  background: showBlocks ? SD.active : SD.surface,
                  fontWeight: 500,
                }}
              >
                <span style={{ fontSize: 14 }}>▦</span>
                <span>Blocks ({blocks.length})</span>
              </button>
            </div>

            {/* Equipment Symbols */}
            <div style={sidebarSectionTitleStyle}>
              <span>Symbols</span>
            </div>
            <div style={{ padding: "8px 10px" }}>
              <input
                type="text"
                placeholder="Search symbols…"
                style={{
                  width: "100%",
                  padding: "5px 8px",
                  fontSize: 12,
                  border: `1px solid ${SD.border}`,
                  borderRadius: 4,
                  outline: "none",
                  background: SD.surface,
                  color: SD.text,
                }}
                onChange={() => {}}
              />
            </div>
            {canEdit ? (
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 4,
                padding: "0 8px 8px",
              }}>
                {ADD_TYPE_OPTIONS.map((opt) => {
                  const active = addType === opt.value && tool === "add";
                  return (
                    <button
                      key={opt.value}
                      onClick={() => { setAddType(opt.value); setTool("add"); }}
                      title={opt.label}
                      style={{
                        ...insertToolTileStyle,
                        minHeight: 56,
                        borderColor: active ? SD.activeBorder : SD.border,
                        background: active ? SD.active : SD.surface,
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", height: 24 }}>
                        {renderInsertToolPreview(opt.value)}
                      </span>
                      <span style={{ fontSize: 9, textAlign: "center", lineHeight: 1.15 }}>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

          </div>
          )}
        </aside>

        {/* ── Center workspace ───────────────────────────── */}
        <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: SD.bg }}>
          {/* Page tabs */}
          <div style={pageTabsStyle}>
            <div style={{
              padding: "4px 14px",
              fontSize: 11,
              background: SD.surface,
              border: `1px solid ${SD.border}`,
              borderBottom: "none",
              borderTopLeftRadius: 3,
              borderTopRightRadius: 3,
              color: SD.text,
              fontWeight: 600,
            }}>Page 1</div>
            <button style={{
              padding: "4px 10px",
              fontSize: 11,
              background: "transparent",
              border: "none",
              color: SD.textSubtle,
              cursor: "pointer",
            }}>+</button>
          </div>

          {/* Rulers + canvas */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* Top ruler row (corner + horizontal) */}
            <div style={{ display: "flex", flexShrink: 0 }}>
              <div style={{ width: 18, height: 18, background: SD.surfaceAlt, borderRight: `1px solid ${SD.border}`, borderBottom: `1px solid ${SD.border}` }} />
              <div style={{ ...rulerHStyle, flex: 1 }}>
                {Array.from({ length: 60 }).map((_, i) => (
                  <div key={i} style={{
                    position: "absolute",
                    left: `${i * 40}px`,
                    top: 0,
                    bottom: 0,
                    width: 1,
                    background: i % 5 === 0 ? SD.borderStrong : SD.border,
                  }}>
                    {i % 5 === 0 ? (
                      <span style={{ position: "absolute", top: 1, left: 2, fontSize: 8 }}>{i}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
              <div style={rulerVStyle}>
                {Array.from({ length: 60 }).map((_, i) => (
                  <div key={i} style={{
                    position: "absolute",
                    top: `${i * 40}px`,
                    left: 0,
                    right: 0,
                    height: 1,
                    background: i % 5 === 0 ? SD.borderStrong : SD.border,
                  }}>
                    {i % 5 === 0 ? (
                      <span style={{ position: "absolute", left: 1, top: 1, fontSize: 8, writingMode: "vertical-rl" }}>{i}</span>
                    ) : null}
                  </div>
                ))}
              </div>
              <div
                ref={containerRef}
                style={{ flex: 1, position: "relative", overflow: "hidden", background: SD.bg }}
              >

        {canEdit && (tool !== "pan" || sourceSelectMode) ? (
          <div style={{
            position: "absolute",
            top: 10,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 14,
            background: "rgba(255,255,255,0.96)",
            border: "1px solid #E8EAED",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12,
            color: "#1A1A2E",
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
                  : tool === "measure"
                    ? (measureStart
                      ? (measureEnd
                        ? `Measured ${measureDistanceM?.toFixed(3) ?? "0.000"} m. Click to start another measurement.`
                        : "Measure mode: click second point. Snaps to nearby detectors/pipes/sources. Esc clears.")
                      : "Measure mode: click first point.")
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
              border: "1px dashed #D97706",
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
                border: "1px solid #E8EAED",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 12,
                color: "#1A1A2E",
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
                <label style={{ color: "#6B7280" }}>Diameter:</label>
                <select
                  value={mm}
                  onChange={(e) => changeSelectedPipeDiameter(Number(e.target.value))}
                  disabled={!canEdit}
                  style={{
                    background: "#E8EAED", color: "#1A1A2E",
                    border: "1px solid #E8EAED", borderRadius: 6,
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
                    background: "#B42318", borderColor: "#7A1810",
                    color: "#fff", border: "1px solid #7A1810",
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
              border: "1px solid #E8EAED",
              borderRadius: 8,
              padding: "6px 10px",
              fontSize: 12,
              color: "#1A1A2E",
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
            <div style={{ marginTop: 10, width: 280, height: 6, background: "#E8EAED", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progress.pct}%`, background: "#2D6A4F", transition: "width 0.2s" }} />
            </div>
          </div>
        ) : null}

        {error ? (
          <div
            style={{
              position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
              background: "#45273a", border: "1px solid #B42318", borderRadius: 8,
              padding: "8px 16px", fontSize: 13, color: "#B42318", zIndex: 20,
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
              background: "#ffffff", border: "1px solid #E8EAED",
              borderRadius: 8, maxHeight: "70vh", overflowY: "auto",
              minWidth: 220, maxWidth: 300, zIndex: 15,
            }}
          >
            <h3 style={{
              padding: "10px 12px", fontSize: 13, color: "#2D6A4F",
              borderBottom: "1px solid #E8EAED", margin: 0,
              position: "sticky", top: 0, background: "#ffffff",
            }}>
              Layers
            </h3>
            {/* Equipment (virtual) layers ─ detectors per dtype + sprinkler pipes */}
            <div style={{
              padding: "6px 12px 4px", fontSize: 10, fontWeight: 700,
              color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5,
              borderBottom: "1px solid #E8EAED",
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
                      style={{ accentColor: "#2D6A4F" }}
                    />
                    <span
                      style={{
                        width: 14, height: 14, borderRadius: 3,
                        border: "1px solid #E8EAED", flexShrink: 0,
                        background: DTYPE_COLORS[opt.value] || "#22d3ee",
                      }}
                    />
                    <span
                      style={{
                        overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap", color: "#1A1A2E", flex: 1,
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
                      style={{ accentColor: "#2D6A4F" }}
                    />
                    <span
                      style={{
                        width: 14, height: 14, borderRadius: 3,
                        border: "1px solid #E8EAED", flexShrink: 0,
                        background: "#B42318",
                      }}
                    />
                    <span style={{ flex: 1, color: "#1A1A2E" }} title="Sprinkler Pipes">
                      Sprinkler Pipes
                    </span>
                    {pipeCount > 0 ? (
                      <span style={{ fontSize: 10, color: "#7f849c" }}>{pipeCount}</span>
                    ) : null}
                  </label>
                );
              })()}
              {/* Smoke detector coverage circles overlay */}
              {(() => {
                const smokeCount = detectors.filter(
                  (d) => String(d.dtype || "").toLowerCase() === "smoke",
                ).length;
                return (
                  <label
                    key="equip-coverage"
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "5px 12px", fontSize: 12, cursor: "pointer",
                      opacity: smokeCount === 0 ? 0.5 : 1,
                    }}
                    title={`Translucent ${detectorSpacingM.toFixed(1)} m radius disk around each smoke detector`}
                  >
                    <input
                      type="checkbox"
                      checked={showCoverageDisks}
                      onChange={(e) => setShowCoverageDisks(e.target.checked)}
                      style={{ accentColor: "#2D6A4F" }}
                    />
                    <span
                      style={{
                        width: 14, height: 14, borderRadius: "50%",
                        border: `1px solid ${DTYPE_COLORS.smoke || "#ef4444"}`,
                        flexShrink: 0,
                        background: `${DTYPE_COLORS.smoke || "#ef4444"}33`,
                      }}
                    />
                    <span style={{ flex: 1, color: "#1A1A2E" }}>
                      Coverage circles ({detectorSpacingM.toFixed(0)} m)
                    </span>
                    {smokeCount > 0 ? (
                      <span style={{ fontSize: 10, color: "#7f849c" }}>{smokeCount}</span>
                    ) : null}
                  </label>
                );
              })()}
            </div>

            {/* DXF drawing layers (from the file) */}
            {layers.length > 0 ? (
              <div style={{
                padding: "6px 12px 4px", fontSize: 10, fontWeight: 700,
                color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5,
                borderTop: "1px solid #E8EAED", borderBottom: "1px solid #E8EAED",
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
                    style={{ accentColor: "#2D6A4F" }}
                  />
                  <span
                    style={{
                      width: 14, height: 14, borderRadius: 3,
                      border: "1px solid #E8EAED", flexShrink: 0,
                      background: colorToHex(l.color),
                    }}
                  />
                  <span
                    style={{
                      overflow: "hidden", textOverflow: "ellipsis",
                      whiteSpace: "nowrap", color: "#1A1A2E",
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
              background: "#ffffff", border: "1px solid #E8EAED",
              borderRadius: 8, maxHeight: "70vh", overflowY: "auto",
              minWidth: 240, maxWidth: 320, zIndex: 15,
            }}
          >
            <div style={{
              padding: "10px 12px", fontSize: 13, color: "#2D6A4F",
              borderBottom: "1px solid #E8EAED",
              position: "sticky", top: 0, background: "#ffffff",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            }}>
              <span>Blocks</span>
              {selectedBlock ? (
                <button
                  onClick={() => { setSelectedBlock(null); clearHighlight(); }}
                  style={{
                    background: "transparent", color: "#B42318",
                    border: "1px solid #E8EAED", borderRadius: 4,
                    padding: "2px 8px", fontSize: 11, cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <div>
              {blocks.length === 0 ? (
                <div style={{ padding: "10px 12px", fontSize: 12, color: "#9AA1AC" }}>
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
                      background: active ? "#E8EAED" : "transparent",
                      color: active ? "#1A1A2E" : "#1A1A2E",
                      border: "none", borderBottom: "1px solid #F0F2F5",
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
                      fontSize: 11, color: active ? "#1A1A2E" : "#9AA1AC",
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

              </div>
            </div>
          </div>

          {/* Bottom status bar */}
          <div style={bottomBarStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: SD.textSubtle, fontSize: 11 }}>Layer:</span>
              <select
                style={{
                  fontSize: 11,
                  padding: "1px 4px",
                  border: `1px solid ${SD.border}`,
                  borderRadius: 3,
                  background: SD.surface,
                  color: SD.text,
                  outline: "none",
                }}
                value={selectedFloorId ?? ""}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) { setSelectedFloorId(null); clearHighlight(); fitView(); }
                  else {
                    const fp = floorPlans.find(f => f.id === id);
                    if (fp) selectFloorPlan(fp);
                  }
                }}
              >
                <option value="">Layer-1 (Default)</option>
                {floorPlans.map((fp) => (
                  <option key={fp.id} value={fp.id}>Block {fp.block_index + 1}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                onClick={fitView}
                style={{ ...btnStyle, padding: "1px 8px", fontSize: 11 }}
                title="Fit"
              >Fit</button>
              <span style={{ color: SD.textSubtle, fontSize: 11 }}>—</span>
              <input
                type="range"
                min={10}
                max={400}
                defaultValue={100}
                onChange={() => {}}
                style={{ width: 120, accentColor: SD.accent }}
                title="Zoom"
              />
              <span style={{ color: SD.textSubtle, fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right" }}>
                100%
              </span>
              <button
                onClick={() => setBgIdx((i) => (i + 1) % bgColors.length)}
                style={{ ...btnStyle, padding: "1px 8px", fontSize: 11 }}
                title="Background"
              >BG</button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// SmartDraw-style light theme tokens
// ──────────────────────────────────────────────────────────────────────────────
const SD = {
  bg: "#F0F2F5",            // page bg — matches workspace
  surface: "#FFFFFF",       // panels / ribbon / sidebar
  surfaceAlt: "#F7F8FA",    // subtle alt surface
  hover: "#EEF2EE",
  active: "#E7F1EC",        // selected tool — soft green tint
  activeBorder: "#2D6A4F",
  border: "#E8EAED",        // standard app border
  borderStrong: "#D1D5DB",
  divider: "#EEF2EE",
  text: "#1A1A2E",          // primary text
  textSubtle: "#6B7280",    // secondary text
  textMuted: "#9AA1AC",
  accent: "#2D6A4F",        // forest green app accent
  accentDark: "#1F4A37",
  danger: "#B42318",
  success: "#2D6A4F",
  warning: "#D97706",
  yellow: "#FDE68A",        // Buy button (warm amber, app-style)
  yellowDark: "#B45309",
  shadow: "0 1px 2px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.06)",
  shadowLg: "0 4px 14px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.06)",
};

const btnStyle: React.CSSProperties = {
  background: SD.surface, color: SD.text,
  border: `1px solid ${SD.border}`, borderRadius: 4,
  padding: "5px 10px", fontSize: 12, cursor: "pointer",
  lineHeight: 1.2,
};

const insertToolTileStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 2,
  minHeight: 64,
  border: `1px solid ${SD.border}`,
  borderRadius: 4,
  background: SD.surface,
  color: SD.text,
  cursor: "pointer",
  padding: "6px 4px",
};

function renderInsertToolPreview(dtype: string): React.ReactNode {
  const stroke = "#1A1A2E";
  const fill = "#1A1A2E";

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
    background: active ? SD.surface : "transparent",
    color: active ? SD.text : SD.textSubtle,
    border: "none",
    borderTop: active ? `2px solid ${SD.accent}` : "2px solid transparent",
    borderRight: active ? `1px solid ${SD.border}` : "1px solid transparent",
    borderLeft: active ? `1px solid ${SD.border}` : "1px solid transparent",
    borderBottom: active ? `1px solid ${SD.surface}` : `1px solid transparent`,
    marginBottom: -1,
    padding: "6px 16px",
    fontSize: 12,
    fontWeight: active ? 600 : 500,
    cursor: "pointer",
    letterSpacing: 0.1,
  };
}

const ribbonGroupStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  gap: 4,
  minHeight: 54,
  padding: "4px 10px",
  borderRight: `1px solid ${SD.divider}`,
  background: "transparent",
};

const ribbonGroupTitleStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.3,
  textTransform: "none",
  color: SD.textMuted,
  textAlign: "center",
  marginTop: 2,
};

const overlayStyle: React.CSSProperties = {
  position: "absolute", inset: 0,
  display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center",
  background: "rgba(255,255,255,0.92)", zIndex: 15,
  color: SD.textSubtle,
};

const spinnerStyle: React.CSSProperties = {
  width: 44, height: 44,
  border: `4px solid ${SD.divider}`,
  borderTopColor: SD.accent,
  borderRadius: "50%",
  animation: "dxfspin 0.8s linear infinite",
};

// ──────────────────────────────────────────────────────────────────────────────
// SmartDraw sidebar / chrome styles
// ──────────────────────────────────────────────────────────────────────────────
const sidebarStyle: React.CSSProperties = {
  width: 232,
  flexShrink: 0,
  background: SD.surface,
  borderRight: `1px solid ${SD.border}`,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const sidebarCollapsedStyle: React.CSSProperties = {
  width: 28,
  flexShrink: 0,
  background: SD.surface,
  borderRight: `1px solid ${SD.border}`,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const sidebarSectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: SD.text,
  background: SD.surfaceAlt,
  padding: "6px 12px",
  borderTop: `1px solid ${SD.divider}`,
  borderBottom: `1px solid ${SD.divider}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  userSelect: "none",
};

const sidebarItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 12px",
  fontSize: 12,
  color: SD.text,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
};

const bottomBarStyle: React.CSSProperties = {
  height: 28,
  flexShrink: 0,
  borderTop: `1px solid ${SD.border}`,
  background: SD.surface,
  display: "flex",
  alignItems: "center",
  padding: "0 12px",
  gap: 12,
  fontSize: 11,
  color: SD.textSubtle,
};

const pageTabsStyle: React.CSSProperties = {
  height: 26,
  flexShrink: 0,
  borderBottom: `1px solid ${SD.border}`,
  background: SD.surfaceAlt,
  display: "flex",
  alignItems: "flex-end",
  paddingLeft: 8,
  gap: 1,
};

const rulerHStyle: React.CSSProperties = {
  height: 18,
  flexShrink: 0,
  background: SD.surfaceAlt,
  borderBottom: `1px solid ${SD.border}`,
  position: "relative",
  overflow: "hidden",
  fontSize: 9,
  color: SD.textMuted,
};

const rulerVStyle: React.CSSProperties = {
  width: 18,
  flexShrink: 0,
  background: SD.surfaceAlt,
  borderRight: `1px solid ${SD.border}`,
  position: "relative",
  overflow: "hidden",
  fontSize: 9,
  color: SD.textMuted,
};

if (typeof document !== "undefined" && !document.getElementById("dxfspin-kf")) {
  const s = document.createElement("style");
  s.id = "dxfspin-kf";
  s.textContent = "@keyframes dxfspin { to { transform: rotate(360deg); } }";
  document.head.appendChild(s);
}
