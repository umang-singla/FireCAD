"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { getToken, getTenantRole } from "../../lib/auth";
import dynamic from "next/dynamic";

const FloorPlanExtractor = dynamic(() => import("./components/FloorPlanExtractor"), { ssr: false });

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");
const WS_BASE = (process.env.NEXT_PUBLIC_WS_BASE || "").replace(/\/$/, "");

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

function resolveWsBase() {
  if (WS_BASE) return WS_BASE.replace(/^http/, "ws");
  return resolveApiBase().replace(/^http/, "ws");
}

const apiUrl = (path: string) => `${resolveApiBase()}${path}`;

function apiMediaUrl(path: string, version: number) {
  const base = apiUrl(path);
  return `${base}${base.includes("?") ? "&" : "?"}v=${version}`;
}

const NETWORK_PENDING_EVENT = "mepit-network-pending";
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

function resolveDxfToWorldFromSettings(settingsObj: any, fallbackUnits: string) {
  const worldToM = Number(settingsObj?.world_to_m);
  if (Number.isFinite(worldToM) && worldToM > 0) return worldToM;

  const dxfToWorld = Number(settingsObj?.dxf_to_world);
  if (Number.isFinite(dxfToWorld) && dxfToWorld > 0) return dxfToWorld;

  return deriveWorldToMFromUnits(String(fallbackUnits || "mm"));
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
  input_filename?: string | null;
  nbc_evaluation?: {
    matched_rule_id?: string;
    matched_category?: string;
    equipment?: Array<{
      key: string;
      label: string;
      required: boolean;
      supported: boolean;
      notes: string[];
    }>;
    water_pump_requirements?: any;
    warnings?: string[];
  } | null;
  nbc_answers?: Record<string, any> | null;
  settings?: Record<string, any> | null;
  floor_plans_count?: number;
};

type FloorPlan = {
  id: string;
  project_id: string;
  block_index: number;
  status: string;
  height_m?: number | null;
  world_bbox: { xmin: number; ymin: number; xmax: number; ymax: number } | null;
  pixel_bbox: number[] | null;
  files: Record<string, string | null>;
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

type ShapeKind = "rect" | "circle" | "cloud" | "text";

type ShapeAnnotation = {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  fontSize?: number;
};

type ShapeResizeHandle = "nw" | "ne" | "sw" | "se";

type NBCSettingsQuestion = {
  id: string;
  type: "select" | "number" | "boolean";
  label: string;
  options?: string[];
};

function isBlankNbcAnswer(value: any) {
  return value === null || value === undefined || value === "";
}

type Detector = {
  id: string;
  project_id: string;
  x: number;
  y: number;
  z: number;
  rotation_deg?: number;
  dtype: string;
  locked: boolean;
  floor_plan_id?: string | null;
};

type ObjectType = "smoke" | "panel" | "hooter" | "mcb" | "sprinkler" | "fire_hose" | "internal_hydrant" | "beam_detector" | "reflector";

const OBJECT_TYPES: ObjectType[] = ["smoke", "panel", "hooter", "mcb", "sprinkler", "fire_hose", "internal_hydrant", "beam_detector", "reflector"];

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

function getMappingFit(m: Mapping) {
  const fit = m.pixel_fit;
  if (fit && Number.isFinite(fit.scale) && fit.scale > 0) {
    return {
      scale: fit.scale,
      offset_x: fit.offset_x,
      offset_y: fit.offset_y,
    };
  }
  // Legacy mappings may not include pixel_fit; derive the same contain-fit transform
  // used by renderer to avoid subtle stretch-based coordinate drift.
  const { xmin, xmax, ymin, ymax } = m.world_bbox;
  const spanX = Math.max(1e-9, xmax - xmin);
  const spanY = Math.max(1e-9, ymax - ymin);
  const scale = Math.min(m.width_px / spanX, m.height_px / spanY);
  const drawW = spanX * scale;
  const drawH = spanY * scale;
  return {
    scale,
    offset_x: (m.width_px - drawW) * 0.5,
    offset_y: (m.height_px - drawH) * 0.5,
  };
}

function worldToPixel(m: Mapping, x: number, y: number) {
  const { xmin, xmax, ymin, ymax } = m.world_bbox;
  const fit = getMappingFit(m);
  return {
    px: fit.offset_x + (x - xmin) * fit.scale,
    py: fit.offset_y + (ymax - y) * fit.scale,
  };
}
function pixelToWorld(m: Mapping, px: number, py: number) {
  const { xmin, xmax, ymin, ymax } = m.world_bbox;
  const fit = getMappingFit(m);
  return {
    x: xmin + (px - fit.offset_x) / fit.scale,
    y: ymax - (py - fit.offset_y) / fit.scale,
  };
}

function normalizeAngleDeg(angle: number) {
  const a = angle % 360;
  return a < 0 ? a + 360 : a;
}

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

function formatLitersWithKl(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "-");
  const liters = Math.round(n);
  const kl = n / 1000;
  const klText = Number.isInteger(kl) ? `${kl}` : kl.toFixed(2);
  return `${liters.toLocaleString()} L (${klText} KL)`;
}

function humanizeWaterPumpKey(key: string) {
  const labelMap: Record<string, string> = {
    underground_static_tank_l: "Underground Static Water Tank",
    terrace_tank_l: "Terrace Water Tank",
    pump_near_underground_tank: "Pump Near Underground Tank",
    pump_at_terrace_lpm: "Pump at Terrace",
  };
  return labelMap[key] || key.replace(/_/g, " ");
}

function renderWaterPumpValue(key: string, value: any) {
  if (value === "NR") return "Not Required";
  if (key.endsWith("_l") && Number.isFinite(Number(value))) return formatLitersWithKl(value);
  if (key.endsWith("_lpm") && Number.isFinite(Number(value))) return `${Number(value).toLocaleString()} LPM`;
  return String(value ?? "-");
}

export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [detectors, setDetectors] = useState<Detector[]>([]);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [pipesData, setPipesData] = useState<PipesData | null>(null);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [activeBlockIndex, setActiveBlockIndex] = useState(0);
  const [networkPending, setNetworkPending] = useState(0);
  const [wizardStep, setWizardStep] = useState(1);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [nbcSettingsQuestions, setNbcSettingsQuestions] = useState<NBCSettingsQuestion[]>([]);
  const [nbcSettingsFollowups, setNbcSettingsFollowups] = useState<NBCSettingsQuestion[]>([]);
  const [nbcSettingsAnswers, setNbcSettingsAnswers] = useState<Record<string, any>>({});
  const [nbcSettingsLabels, setNbcSettingsLabels] = useState<Record<string, string>>({});
  const [nbcSettingsSaving, setNbcSettingsSaving] = useState(false);
  const [showTankCapacityModal, setShowTankCapacityModal] = useState(false);
  const [tankQuestions, setTankQuestions] = useState<NBCSettingsQuestion[]>([]);
  const [tankFollowups, setTankFollowups] = useState<NBCSettingsQuestion[]>([]);
  const [tankAnswers, setTankAnswers] = useState<Record<string, any>>({});
  const [tankLabels, setTankLabels] = useState<Record<string, string>>({});
  const [tankCapacitySaving, setTankCapacitySaving] = useState(false);
  const [tankCapacityError, setTankCapacityError] = useState<string | null>(null);
  const [tankCapacityEval, setTankCapacityEval] = useState<any | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [mediaVersion, setMediaVersion] = useState<number>(Date.now());

  const canEdit = (() => {
    const role = getTenantRole();
    return role !== "viewer";
  })();

  const [settings, setSettings] = useState<any>({
    // NOTE: detector_spacing_m and wall_buffer_m are backend-owned constants
    // (see api/app/pipeline/place_detectors_advanced.py). The UI must not
    // send them; the backend ignores them in PipelineOptions.merge_settings.
    target_long_side_px: 6000,
    gemini_model: "gemini-3.1-flash-image-preview",
    building_type: "residential",
    has_false_ceiling: false,
    units: "mm",
    typical_ceiling_height: 3.0,
    ceiling_height_unit: "m",
  });

  // Current pipeline stage for live progress display
  const [pipelineStage, setPipelineStage] = useState<string | null>(null);

  async function refresh() {
    const p: Project = await (await authFetch(`/api/projects/${projectId}`)).json();
    setProject(p);

    // Hydrate local settings from server-side settings_json
    if (p.settings) {
      setSettings((prev: any) => ({ ...prev, ...p.settings }));
    }

    const d: Detector[] = await (await authFetch(`/api/projects/${projectId}/detectors`)).json();
    setDetectors(d);

    const mappingUrl = p.files?.mapping_json || p.files?.output_preview_mapping;
    if (mappingUrl) {
      const mj: Mapping = await (await trackedFetch(apiUrl(mappingUrl), { cache: "no-store" })).json();
      setMapping(mj);
    } else {
      setMapping(null);
    }

    // Fetch sprinkler pipes if available
    if (p.files?.sprinkler_pipes) {
      try {
        const pd: PipesData = await (await trackedFetch(apiUrl(p.files.sprinkler_pipes), { cache: "no-store" })).json();
        setPipesData(pd);
      } catch { setPipesData(null); }
    } else {
      setPipesData(null);
    }

    // Fetch floor plans if any
    if (p.floor_plans_count && p.floor_plans_count > 0) {
      try {
        const fps: FloorPlan[] = await (await authFetch(`/api/projects/${projectId}/floor_plans`)).json();
        setFloorPlans(fps);
      } catch { setFloorPlans([]); }
    } else {
      setFloorPlans([]);
    }

    // Force image reload for updated PNG assets (mask/render) after refresh.
    setMediaVersion(Date.now());
  }

  useEffect(() => { refresh(); }, []);

  // Real-time pipeline status via WebSocket (routed through proxy)
  useEffect(() => {
    const base = resolveWsBase();
    const wsUrl = `${base}/api/projects/${projectId}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "status") {
            // Full refresh to pick up new files/status from the API
            refresh();
            if (msg.status === "ready" || msg.status === "failed" || msg.status === "mask_failed" || msg.status === "ready_no_mask" || msg.status === "awaiting_alignment_review" || msg.status === "awaiting_floor_review") {
              setPipelineStage(null);
            }
          } else if (msg.type === "stage") {
            if (msg.event === "start") {
              setPipelineStage(msg.stage);
            }
          } else if (msg.type === "floor_plans") {
            refresh();
          }
        } catch {}
      };

      ws.onclose = () => {
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [projectId]);

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

  async function openSettingsModal() {
    setShowSettingsModal(true);
    // Load current NBC answers from project
    setNbcSettingsAnswers(project?.nbc_answers || {});
    try {
      const [qs, labels] = await Promise.all([
        (await authFetch("/api/nbc/questions")).json(),
        (await authFetch("/api/nbc/occupancy_types")).json(),
      ]);
      setNbcSettingsQuestions(qs);
      setNbcSettingsLabels(labels);
      // Load followups if occupancy is already selected
      const occ = project?.nbc_answers?.occupancy_subtype;
      if (occ) {
        const followups: NBCSettingsQuestion[] = await (await authFetch(`/api/nbc/followup_fields?occupancy_subtype=${encodeURIComponent(occ)}`)).json();
        setNbcSettingsFollowups(followups);
      }
    } catch {}
  }

  async function nbcSettingsSelectOccupancy(subtype: string) {
    setNbcSettingsAnswers((prev: Record<string, any>) => ({ ...prev, occupancy_subtype: subtype }));
    try {
      const followups: NBCSettingsQuestion[] = await (await authFetch(`/api/nbc/followup_fields?occupancy_subtype=${encodeURIComponent(subtype)}`)).json();
      setNbcSettingsFollowups(followups);
    } catch {
      setNbcSettingsFollowups([]);
    }
  }

  function setNbcSettingsAnswer(id: string, value: any) {
    setNbcSettingsAnswers((prev: Record<string, any>) => ({ ...prev, [id]: value }));
  }

  async function saveNbcSettings() {
    setNbcSettingsSaving(true);
    try {
      // Re-evaluate NBC with updated answers
      const evalResult = await (await authFetch("/api/nbc/evaluate", {
        method: "POST",
        body: JSON.stringify({ answers: nbcSettingsAnswers }),
      })).json();
      // Save to project settings
      const normalizedSettings = {
        ...settings,
        world_to_m: deriveWorldToMFromUnits(String(settings.units || "mm")),
        nbc_answers: nbcSettingsAnswers,
        nbc_evaluation: evalResult,
      };
      await authFetch(`/api/projects/${projectId}/settings`, {
        method: "POST",
        body: JSON.stringify({ settings: normalizedSettings }),
      });
      setSettings(normalizedSettings);
      setShowSettingsModal(false);
      await refresh();
    } catch (e: any) {
      console.error("Failed to save NBC settings:", e);
    } finally {
      setNbcSettingsSaving(false);
    }
  }

  async function openTankCapacityModal() {
    setShowTankCapacityModal(true);
    setTankCapacityError(null);
    setTankCapacityEval(project?.nbc_evaluation || settings?.nbc_evaluation || null);
    const existingAnswers = project?.nbc_answers || settings?.nbc_answers || {};
    setTankAnswers(existingAnswers);
    try {
      const [qs, labels] = await Promise.all([
        (await authFetch("/api/nbc/questions")).json(),
        (await authFetch("/api/nbc/occupancy_types")).json(),
      ]);
      setTankQuestions(qs);
      setTankLabels(labels);

      const occ = existingAnswers?.occupancy_subtype;
      if (occ) {
        const followups: NBCSettingsQuestion[] = await (await authFetch(`/api/nbc/followup_fields?occupancy_subtype=${encodeURIComponent(occ)}`)).json();
        setTankFollowups(followups);
      } else {
        setTankFollowups([]);
      }
    } catch {
      setTankCapacityError("Could not load questionnaire. Please try again.");
    }
  }

  async function tankSelectOccupancy(subtype: string) {
    setTankAnswers((prev: Record<string, any>) => ({ ...prev, occupancy_subtype: subtype }));
    try {
      const followups: NBCSettingsQuestion[] = await (await authFetch(`/api/nbc/followup_fields?occupancy_subtype=${encodeURIComponent(subtype)}`)).json();
      setTankFollowups(followups);
    } catch {
      setTankFollowups([]);
    }
  }

  function setTankAnswer(id: string, value: any) {
    setTankAnswers((prev: Record<string, any>) => ({ ...prev, [id]: value }));
  }

  const tankMissingQuestions = useMemo(() => {
    const visible = [...tankQuestions, ...tankFollowups];
    return visible.filter((q) => isBlankNbcAnswer(tankAnswers[q.id]));
  }, [tankQuestions, tankFollowups, tankAnswers]);

  async function calculateTankCapacity() {
    setTankCapacitySaving(true);
    setTankCapacityError(null);
    try {
      const evalResult = await (await authFetch("/api/nbc/evaluate", {
        method: "POST",
        body: JSON.stringify({ answers: tankAnswers }),
      })).json();

      const normalizedSettings = {
        ...settings,
        world_to_m: deriveWorldToMFromUnits(String(settings.units || "mm")),
        nbc_answers: tankAnswers,
        nbc_evaluation: evalResult,
      };

      await authFetch(`/api/projects/${projectId}/settings`, {
        method: "POST",
        body: JSON.stringify({ settings: normalizedSettings }),
      });

      setSettings(normalizedSettings);
      setTankCapacityEval(evalResult);
      await refresh();
    } catch (e: any) {
      setTankCapacityError(e?.message || "Tank capacity calculation failed.");
    } finally {
      setTankCapacitySaving(false);
    }
  }

  async function saveSettings() {
    const normalizedSettings = {
      ...settings,
      world_to_m: deriveWorldToMFromUnits(String(settings.units || "mm")),
      // Preserve NBC data in settings_json
      nbc_answers: settings.nbc_answers,
      nbc_evaluation: project?.nbc_evaluation || settings.nbc_evaluation,
    };

    await authFetch(`/api/projects/${projectId}/settings`, {
      method:"POST",
      body: JSON.stringify({ settings: normalizedSettings })
    });
    setSettings(normalizedSettings);
    await refresh();
  }

  async function updateProjectUnits(nextUnits: string) {
    const normalizedUnit = (nextUnits || "mm").trim().toLowerCase();
    const nextScale = deriveWorldToMFromUnits(normalizedUnit);
    const normalizedSettings = {
      ...settings,
      units: normalizedUnit,
      // Keep both scale keys in sync with selected unit for measurement and pipeline use.
      dxf_to_world: nextScale,
      world_to_m: nextScale,
      nbc_answers: settings.nbc_answers,
      nbc_evaluation: project?.nbc_evaluation || settings.nbc_evaluation,
    };

    setSettings(normalizedSettings);
    await authFetch(`/api/projects/${projectId}/settings`, {
      method: "POST",
      body: JSON.stringify({ settings: normalizedSettings }),
    });
    await refresh();
  }

  async function runPipeline() {
    await saveSettings();
    setPipelineStage(null);
    await authFetch(`/api/projects/${projectId}/run`, { method:"POST" });
    await refresh();
  }

  async function retryMaskGenerationStep() {
    setPipelineStage(null);
    await authFetch(`/api/projects/${projectId}/retry_mask_generation`, { method: "POST" });
    await refresh();
  }

  const isReady = project?.status === "ready";
  const isAwaitingFloorReview = project?.status === "awaiting_floor_review";
  const isAwaitingAlignmentReview = project?.status === "awaiting_alignment_review";
  const isAwaitingRoomReview = project?.status === "awaiting_room_review";
  // Treat ALL intermediate pipeline statuses as "running" so the loader
  // stays visible until a review step or final output appears.
  const IDLE_STATUSES = new Set(["created", "uploaded", "ready", "ready_no_mask", "failed", "mask_failed", "awaiting_alignment_review", "awaiting_room_review", "awaiting_floor_review"]);
  const isRunning = !!project && !IDLE_STATUSES.has(project.status);
  const isQuestionnaireMode = !editorOpen;
  const showGlobalLoader = project === null || networkPending > 0;
  const reviewUnits = String(settings?.units || "mm").toLowerCase();
  const reviewWorldToM = resolveDxfToWorldFromSettings(settings, reviewUnits);

  async function saveLayout() {
    await authFetch(`/api/projects/${projectId}/save`, { method:"POST" });
    await refresh();
  }

  async function continuePipelineAfterFloorReview(floorPlanHeightsM?: Record<string, number>) {
    if (floorPlanHeightsM && Object.keys(floorPlanHeightsM).length > 0 && floorPlans.length > 0) {
      await Promise.all(
        floorPlans.map(async (fp) => {
          const h = floorPlanHeightsM[fp.id];
          if (!Number.isFinite(h) || h <= 0) {
            throw new Error(`Invalid floor height for block ${fp.block_index + 1}`);
          }
          await authFetch(`/api/projects/${projectId}/floor_plans/${fp.id}`, {
            method: "PUT",
            body: JSON.stringify({ height_m: h }),
          });
        }),
      );
    }
    setPipelineStage(null);
    await authFetch(`/api/projects/${projectId}/continue_floor_review`, { method:"POST" });
    await refresh();
    setEditorOpen(false);
  }

  async function addFloorPlan(worldBbox: { xmin: number; ymin: number; xmax: number; ymax: number }) {
    const res = await authFetch(`/api/projects/${projectId}/floor_plans`, {
      method: "POST",
      body: JSON.stringify({ world_bbox: worldBbox }),
    });
    await refresh();
    return await res.json();
  }

  async function uploadFloorPlanRenderImage(fpId: string, blob: Blob) {
    const fd = new FormData();
    fd.append("file", blob, "floor_plan.png");
    await authFetch(`/api/projects/${projectId}/floor_plans/${fpId}/render_image`, {
      method: "POST",
      body: fd,
    });
  }

  async function deleteFloorPlan(fpId: string) {
    await authFetch(`/api/projects/${projectId}/floor_plans/${fpId}`, { method: "DELETE" });
    await refresh();
  }

  async function clearAllFloorPlansForProject() {
    const res = await authFetch(`/api/projects/${projectId}/floor_plans`);
    const existing = await res.json();
    if (!Array.isArray(existing) || existing.length === 0) return;
    for (const fp of existing) {
      if (fp?.id) {
        await authFetch(`/api/projects/${projectId}/floor_plans/${fp.id}`, { method: "DELETE" });
      }
    }
    await refresh();
  }

  async function continuePipelineAfterAlignment(adjustedMaskBlob?: Blob) {
    if (adjustedMaskBlob) {
      // If multi-block, upload to the active block; otherwise project-level
      const activeFp = floorPlans[activeBlockIndex];
      if (activeFp) {
        const fd = new FormData();
        fd.append("file", adjustedMaskBlob, "mask_aligned_adjusted.png");
        await authFetch(`/api/projects/${projectId}/floor_plans/${activeFp.id}/aligned_mask`, { method:"POST", body: fd });
      } else {
        const fd = new FormData();
        fd.append("file", adjustedMaskBlob, "mask_aligned_adjusted.png");
        await authFetch(`/api/projects/${projectId}/aligned_mask`, { method:"POST", body: fd });
      }
    }
    setPipelineStage(null);
    await authFetch(`/api/projects/${projectId}/continue`, { method:"POST" });
    await refresh();
    setEditorOpen(false);
  }

  async function uploadAlignedMaskFile(e: any) {
    const f: File | undefined = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    // Upload to active block if multi-block, otherwise project-level
    const activeFp = floorPlans[activeBlockIndex];
    if (activeFp) {
      await authFetch(`/api/projects/${projectId}/floor_plans/${activeFp.id}/aligned_mask`, { method:"POST", body: fd });
    } else {
      await authFetch(`/api/projects/${projectId}/aligned_mask`, { method:"POST", body: fd });
    }
    await refresh();
  }

  async function retryMaskGeneration(instruction: string) {
    const activeFp = floorPlans[activeBlockIndex];
    if (activeFp) {
      await authFetch(`/api/projects/${projectId}/floor_plans/${activeFp.id}/regenerate_mask`, {
        method: "POST",
        body: JSON.stringify({ instruction }),
      });
    } else {
      await authFetch(`/api/projects/${projectId}/regenerate_mask`, {
        method: "POST",
        body: JSON.stringify({ instruction }),
      });
    }
    await refresh();
  }

  async function saveRoomsAndContinue(rooms: any[]) {
    setPipelineStage(null);
    // Use /save which writes the user's saved detectors & pipes to DXF
    // (bulk_save was already called by handleContinue in RoomEditor)
    await authFetch(`/api/projects/${projectId}/save`, { method: "POST" });
    await refresh();
    setEditorOpen(false);
  }

  async function saveRoomsOnly(rooms: any[]) {
    const activeFp = floorPlans[activeBlockIndex];
    if (activeFp) {
      await authFetch(`/api/projects/${projectId}/floor_plans/${activeFp.id}/rooms`, {
        method: "PUT",
        body: JSON.stringify({ rooms }),
      });
    } else {
      await authFetch(`/api/projects/${projectId}/rooms`, {
        method: "PUT",
        body: JSON.stringify({ rooms }),
      });
    }
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
        <section style={{ zIndex: 1, padding: 24, overflow: "auto", minHeight: "calc(100vh - 28px)" }}>
          {/* ── Top bar ────────────────────────── */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            padding: "14px 20px", borderRadius: 16,
            background: "#FFFFFF", border: "1px solid #E8EAED",
            boxShadow: "0 2px 8px rgba(0,0,0,0.06)", marginBottom: 20,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 10,
                background: "#2D6A4F",
                display: "grid", placeItems: "center", fontSize: 18, flexShrink: 0,
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              </div>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#1A1A2E" }}>{project?.name || "Project"}</div>
                <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>Project Workspace</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {!canEdit && (
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 8,
                  background: "#FEF3C7", color: "#92400E", border: "1px solid rgba(217,119,6,0.2)",
                }}>View Only</span>
              )}
              {canEdit && (
                <button onClick={openTankCapacityModal} style={{
                  padding: "8px 14px", borderRadius: 10,
                  border: "1px solid #E8EAED", background: "#FFFFFF",
                  color: "#1A1A2E", cursor: "pointer", fontSize: 12, fontWeight: 600,
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>
                  Tank Capacity
                </button>
              )}
              {canEdit && (
                <button onClick={openSettingsModal} style={{
                  padding: "8px 14px", borderRadius: 10,
                  border: "1px solid #E8EAED", background: "#FFFFFF",
                  color: "#1A1A2E", cursor: "pointer", fontSize: 12, fontWeight: 600,
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  Settings
                </button>
              )}
              <button onClick={refresh} style={{
                padding: "8px 14px", borderRadius: 10,
                border: "1px solid #E8EAED", background: "#FFFFFF",
                color: "#1A1A2E", cursor: "pointer", fontSize: 12, fontWeight: 600,
              }}>Refresh</button>
            </div>
          </div>

          {project?.error ? (
            <pre style={styles.errorBox}>{project.error}</pre>
          ) : null}

          {/* ── NBC Evaluation banner ────────── */}
          {project?.nbc_evaluation?.matched_category ? (
            <div style={{
              padding: "12px 18px", borderRadius: 14, marginBottom: 20,
              background: "#ECFDF5",
              border: "1px solid rgba(5,150,105,0.2)",
              display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            }}>
              <div style={{ fontSize: 13, color: "#1A1A2E" }}>
                <strong>NBC Category:</strong> {project.nbc_evaluation.matched_category}
              </div>
              {(project.nbc_evaluation.equipment || []).filter(eq => eq.required).map(eq => (
                <span key={eq.key} style={{
                  fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 8,
                  background: "#ECFDF5",
                  color: "#059669",
                  border: "1px solid rgba(5,150,105,0.2)",
                }}>{eq.label}</span>
              ))}
              {project.nbc_evaluation.water_pump_requirements ? (
                <div style={{ width: "100%", marginTop: 6, fontSize: 12, color: "#064E3B" }}>
                  <strong>Water Pump Requirements:</strong>
                  <div style={{ marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {Object.entries(project.nbc_evaluation.water_pump_requirements).map(([key, value]) => (
                      <span key={key} style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 8,
                        background: "#D1FAE5",
                        border: "1px solid rgba(5,150,105,0.2)",
                        color: "#065F46",
                      }}>
                        {key.replace(/_/g, " ")}: {String(value)}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ── Files grid ──────────────────── */}
          <div style={{
            padding: "20px", borderRadius: 16,
            background: "#FFFFFF",
            border: "1px solid #E8EAED",
            marginBottom: 20,
          }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#1A1A2E", marginBottom: 14 }}>Files</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
              {/* Uploaded DWG tile */}
              {project?.files?.input ? (
                <div style={{
                  padding: "16px 14px", borderRadius: 14, textAlign: "center",
                  background: "#FAFBFC", border: "1px solid #E8EAED",
                  transition: "border-color 0.15s",
                }}>
                  <div style={{
                    width: 52, height: 52, margin: "0 auto 10px", borderRadius: 12,
                    background: "#2D6A4F",
                    display: "grid", placeItems: "center",
                  }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                    </svg>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A2E", wordBreak: "break-all" }}>
                    {project.input_filename || "drawing.dwg"}
                  </div>
                  <div style={{ fontSize: 10, color: "#9CA3AF", marginTop: 4 }}>DWG/DXF</div>
                </div>
              ) : null}

              {/* Upload new file tile */}
              {canEdit && (<label style={{
                padding: "16px 14px", borderRadius: 14, textAlign: "center",
                background: "#FAFBFC", border: "2px dashed #E8EAED",
                cursor: "pointer", transition: "border-color 0.15s, background 0.15s",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8,
                minHeight: 120,
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10,
                  background: "#D8F3DC", border: "1px solid rgba(5,150,105,0.15)",
                  display: "grid", placeItems: "center",
                }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2D6A4F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>
                  {project?.files?.input ? "Replace file" : "Upload DWG/DXF"}
                </div>
                <input
                  type="file"
                  accept=".dxf,.dwg"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    await uploadFile(projectId, e, refresh);
                  }}
                />
              </label>)}
            </div>
          </div>

          {/* ── Edit Drawing ───────────────────── */}
          {project?.files?.input ? (
            <div style={{
              padding: "20px", borderRadius: 16,
              background: "#FFFFFF",
              border: "1px solid #E8EAED",
            }}>
              {(() => {
                const s = (project?.status || "").toLowerCase();
                const done = s === "ready";
                const fail = s === "failed";
                const maskFail = s === "mask_failed";
                const reviewing = s === "awaiting_alignment_review" || s === "awaiting_room_review" || s === "awaiting_floor_review";
                const run = !["created","uploaded","ready","ready_no_mask","failed","mask_failed","awaiting_alignment_review","awaiting_room_review","awaiting_floor_review"].includes(s);
                const canOpenEditor = done || reviewing;
                return (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{
                        width: 42, height: 42, borderRadius: 12,
                        background: done ? "#ECFDF5" : run ? "#EFF6FF" : (fail || maskFail) ? "#FEF2F2" : reviewing ? "#EFF6FF" : "#F3F4F6",
                        border: done ? "1px solid rgba(5,150,105,0.2)" : run ? "1px solid rgba(37,99,235,0.2)" : (fail || maskFail) ? "1px solid rgba(220,38,38,0.2)" : reviewing ? "1px solid rgba(37,99,235,0.2)" : "1px solid #E8EAED",
                        display: "grid", placeItems: "center", flexShrink: 0,
                      }}>
                        {run ? (
                          <div style={{
                            width: 20, height: 20, borderRadius: "50%",
                            border: "3px solid #E8EAED", borderTopColor: "#2563EB",
                            animation: "spin 1s linear infinite",
                          }} />
                        ) : (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={done ? "#059669" : (fail || maskFail) ? "#DC2626" : reviewing ? "#2563EB" : "#6B7280"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            {done ? (
                              <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>
                            ) : (fail || maskFail) ? (
                              <><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></>
                            ) : reviewing ? (
                              <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
                            ) : (
                              <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></>
                            )}
                          </svg>
                        )}
                      </div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1A2E" }}>
                          {done ? "Drawing Complete" : maskFail ? "Mask Generation Failed" : fail ? "Drawing Failed" : run ? "Processing Drawing" : reviewing ? "Awaiting Review" : "Edit Drawing"}
                        </div>
                        <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>
                          {done ? "Detectors placed successfully." : maskFail ? "Gemini failed to generate the mask. You can retry just this step." : fail ? (project?.error || "An error occurred. Click to retry.") : run ? (pipelineStage ? pipelineStage.replace(/_/g, " ") : "Pipeline is running\u2026") : reviewing ? "Review is pending. Open the editor to continue." : "Run the placement pipeline on your uploaded drawing."}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {canOpenEditor ? (
                        <button onClick={() => {
                          // Final "ready" stage and the room-review stage open the
                          // dedicated DXF editor. Earlier review stages (Gemini mask
                          // alignment, floor plan extraction) keep the inline UI.
                          if (done || isAwaitingRoomReview) {
                            router.push(`/p/${projectId}/dxf`);
                          } else {
                            setEditorOpen(true);
                          }
                        }} style={{
                          padding: "10px 20px", borderRadius: 12,
                          border: "none", background: "#2D6A4F", color: "#fff",
                          cursor: "pointer", fontSize: 13, fontWeight: 700,
                          display: "flex", alignItems: "center", gap: 8,
                          boxShadow: "0 4px 12px rgba(45,106,79,0.3)",
                          whiteSpace: "nowrap",
                        }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                          {canEdit ? "Open Editor" : "View Editor"}
                        </button>
                      ) : null}
                      {/* BOQ Button — always available once project exists */}
                      <button onClick={() => router.push(`/p/${projectId}/boq`)} style={{
                        padding: "10px 20px", borderRadius: 12,
                        border: "1px solid #e5e7eb", background: "#fff", color: "#1e3a5f",
                        cursor: "pointer", fontSize: 13, fontWeight: 600,
                        display: "flex", alignItems: "center", gap: 8,
                        whiteSpace: "nowrap",
                      }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                          <line x1="16" y1="13" x2="8" y2="13"/>
                          <line x1="16" y1="17" x2="8" y2="17"/>
                          <polyline points="10 9 9 9 8 9"/>
                        </svg>
                        BOQ
                      </button>
                      {canEdit && !run && !canOpenEditor && maskFail ? (
                        <button onClick={retryMaskGenerationStep} style={{
                          padding: "10px 20px", borderRadius: 12,
                          border: "none",
                          background: "#2D6A4F",
                          color: "#fff",
                          cursor: "pointer", fontSize: 13, fontWeight: 700,
                          display: "flex", alignItems: "center", gap: 8,
                          boxShadow: "0 4px 12px rgba(45,106,79,0.3)",
                          whiteSpace: "nowrap",
                        }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="1 4 1 10 7 10"/>
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                          </svg>
                          Retry Mask Generation
                        </button>
                      ) : null}
                      {canEdit && !run && !canOpenEditor && !maskFail ? (
                        <button onClick={runPipeline} style={{
                          padding: "10px 20px", borderRadius: 12,
                          border: "none",
                          background: "#2D6A4F",
                          color: "#fff",
                          cursor: "pointer", fontSize: 13, fontWeight: 700,
                          display: "flex", alignItems: "center", gap: 8,
                          boxShadow: "0 4px 12px rgba(45,106,79,0.3)",
                          whiteSpace: "nowrap",
                        }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                          </svg>
                          {fail ? "Retry Pipeline" : "Run Pipeline"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : null}

          {/* ── Settings modal (NBC Questions) ── */}
          {showSettingsModal ? (
            <div style={{
              position: "fixed", inset: 0, zIndex: 50,
              background: "rgba(0,0,0,0.35)", backdropFilter: "blur(4px)",
              display: "grid", placeItems: "center",
            }} onClick={() => setShowSettingsModal(false)}>
              <div onClick={e => e.stopPropagation()} style={{
                width: "min(620px, calc(100% - 32px))", borderRadius: 20,
                background: "#FFFFFF",
                border: "1px solid #E8EAED", boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
                padding: 0, maxHeight: "90vh", overflow: "hidden",
                display: "flex", flexDirection: "column",
              }}>
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "18px 24px", borderBottom: "1px solid #E8EAED",
                }}>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "#1A1A2E" }}>Project Settings — NBC Rules</h3>
                  <button onClick={() => setShowSettingsModal(false)} style={{
                    background: "none", border: "none", fontSize: 22, color: "#9CA3AF",
                    cursor: "pointer", padding: "4px 8px", lineHeight: 1,
                  }}>&times;</button>
                </div>

                <div style={{ padding: "0 24px 24px", overflowY: "auto", flex: 1 }}>
                  {/* NBC common questions */}
                  {nbcSettingsQuestions.map((q) => (
                    <div key={q.id} style={{ marginTop: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", marginBottom: 6 }}>{q.label}</div>
                      {q.type === "select" && q.options && (
                        <select
                          value={nbcSettingsAnswers[q.id] ?? ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setNbcSettingsAnswer(q.id, val);
                            if (q.id === "occupancy_subtype") nbcSettingsSelectOccupancy(val);
                          }}
                          style={{ width: "100%", borderRadius: 10, border: "1px solid #E8EAED", padding: "10px 14px", fontSize: 13, color: "#1A1A2E", background: "#fff", outline: "none", cursor: "pointer" }}
                        >
                          <option value="">— Select —</option>
                          {q.options.map((opt) => (
                            <option key={opt} value={opt}>
                              {nbcSettingsLabels[opt] || opt.replace(/_/g, " ")}
                            </option>
                          ))}
                        </select>
                      )}
                      {q.type === "number" && (
                        <input
                          type="number"
                          value={nbcSettingsAnswers[q.id] ?? ""}
                          onChange={(e) => setNbcSettingsAnswer(q.id, e.target.value === "" ? "" : Number(e.target.value))}
                          style={{ width: "100%", borderRadius: 10, border: "1px solid #E8EAED", padding: "10px 14px", fontSize: 13, color: "#1A1A2E", background: "#fff", outline: "none" }}
                          placeholder="0"
                        />
                      )}
                      {q.type === "boolean" && (
                        <div style={{ display: "flex", gap: 8 }}>
                          <button type="button" onClick={() => setNbcSettingsAnswer(q.id, true)} style={{
                            borderRadius: 8, border: "1px solid #E8EAED", padding: "8px 20px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                            background: nbcSettingsAnswers[q.id] === true ? "#2D6A4F" : "#fff",
                            color: nbcSettingsAnswers[q.id] === true ? "#fff" : "#6B7280",
                            borderColor: nbcSettingsAnswers[q.id] === true ? "#2D6A4F" : "#E8EAED",
                          }}>Yes</button>
                          <button type="button" onClick={() => setNbcSettingsAnswer(q.id, false)} style={{
                            borderRadius: 8, border: "1px solid #E8EAED", padding: "8px 20px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                            background: nbcSettingsAnswers[q.id] === false ? "#2D6A4F" : "#fff",
                            color: nbcSettingsAnswers[q.id] === false ? "#fff" : "#6B7280",
                            borderColor: nbcSettingsAnswers[q.id] === false ? "#2D6A4F" : "#E8EAED",
                          }}>No</button>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* NBC followup questions */}
                  {nbcSettingsFollowups.length > 0 && (
                    <>
                      <div style={{ margin: "20px 0 0", padding: "10px 0 0", borderTop: "1px solid #E8EAED" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#9CA3AF", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                          Additional Details for {nbcSettingsLabels[nbcSettingsAnswers.occupancy_subtype] || nbcSettingsAnswers.occupancy_subtype}
                        </div>
                      </div>
                      {nbcSettingsFollowups.map((q) => (
                        <div key={q.id} style={{ marginTop: 14 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", marginBottom: 6 }}>{q.label}</div>
                          {q.type === "number" && (
                            <input
                              type="number"
                              value={nbcSettingsAnswers[q.id] ?? ""}
                              onChange={(e) => setNbcSettingsAnswer(q.id, e.target.value === "" ? "" : Number(e.target.value))}
                              style={{ width: "100%", borderRadius: 10, border: "1px solid #E8EAED", padding: "10px 14px", fontSize: 13, color: "#1A1A2E", background: "#fff", outline: "none" }}
                              placeholder="0"
                            />
                          )}
                          {q.type === "boolean" && (
                            <div style={{ display: "flex", gap: 8 }}>
                              <button type="button" onClick={() => setNbcSettingsAnswer(q.id, true)} style={{
                                borderRadius: 8, border: "1px solid #E8EAED", padding: "8px 20px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                                background: nbcSettingsAnswers[q.id] === true ? "#2D6A4F" : "#fff",
                                color: nbcSettingsAnswers[q.id] === true ? "#fff" : "#6B7280",
                                borderColor: nbcSettingsAnswers[q.id] === true ? "#2D6A4F" : "#E8EAED",
                              }}>Yes</button>
                              <button type="button" onClick={() => setNbcSettingsAnswer(q.id, false)} style={{
                                borderRadius: 8, border: "1px solid #E8EAED", padding: "8px 20px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                                background: nbcSettingsAnswers[q.id] === false ? "#2D6A4F" : "#fff",
                                color: nbcSettingsAnswers[q.id] === false ? "#fff" : "#6B7280",
                                borderColor: nbcSettingsAnswers[q.id] === false ? "#2D6A4F" : "#E8EAED",
                              }}>No</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </>
                  )}

                  {/* Current matched category */}
                  {project?.nbc_evaluation?.matched_category && (
                    <div style={{
                      marginTop: 20, padding: "10px 14px", borderRadius: 12,
                      background: "#ECFDF5", border: "1px solid rgba(5,150,105,0.2)",
                      fontSize: 12, color: "#1A1A2E",
                    }}>
                      <strong>Current NBC Category:</strong> {project.nbc_evaluation.matched_category}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                    <button onClick={() => setShowSettingsModal(false)} style={btn(false)}>Cancel</button>
                    <button onClick={saveNbcSettings} disabled={nbcSettingsSaving || !nbcSettingsAnswers.occupancy_subtype} style={btn(true)}>
                      {nbcSettingsSaving ? "Saving..." : "Save & Re-evaluate"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* ── Tank Capacity Calculator modal ── */}
          {showTankCapacityModal ? (
            <div style={{
              position: "fixed", inset: 0, zIndex: 50,
              background: "rgba(0,0,0,0.35)", backdropFilter: "blur(4px)",
              display: "grid", placeItems: "center",
            }} onClick={() => setShowTankCapacityModal(false)}>
              <div onClick={e => e.stopPropagation()} style={{
                width: "min(680px, calc(100% - 32px))", borderRadius: 20,
                background: "#FFFFFF",
                border: "1px solid #E8EAED", boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
                padding: 0, maxHeight: "90vh", overflow: "hidden",
                display: "flex", flexDirection: "column",
              }}>
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "18px 24px", borderBottom: "1px solid #E8EAED",
                }}>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "#1A1A2E" }}>Calculate Water Tank Capacity</h3>
                  <button onClick={() => setShowTankCapacityModal(false)} style={{
                    background: "none", border: "none", fontSize: 22, color: "#9CA3AF",
                    cursor: "pointer", padding: "4px 8px", lineHeight: 1,
                  }}>&times;</button>
                </div>

                <div style={{ padding: "0 24px 24px", overflowY: "auto", flex: 1 }}>
                  <div style={{
                    marginTop: 16,
                    padding: "10px 14px",
                    borderRadius: 10,
                    background: "#F8FAFC",
                    border: "1px solid #E2E8F0",
                    fontSize: 12,
                    color: "#334155",
                  }}>
                    This asks only missing NBC inputs. Answers already captured during project creation are reused.
                  </div>

                  {tankMissingQuestions.length > 0 ? (
                    <>
                      {tankMissingQuestions.map((q) => (
                        <div key={q.id} style={{ marginTop: 16 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", marginBottom: 6 }}>{q.label}</div>
                          {q.type === "select" && q.options && (
                            <select
                              value={tankAnswers[q.id] ?? ""}
                              onChange={(e) => {
                                const val = e.target.value;
                                setTankAnswer(q.id, val);
                                if (q.id === "occupancy_subtype") tankSelectOccupancy(val);
                              }}
                              style={{ width: "100%", borderRadius: 10, border: "1px solid #E8EAED", padding: "10px 14px", fontSize: 13, color: "#1A1A2E", background: "#fff", outline: "none", cursor: "pointer" }}
                            >
                              <option value="">- Select -</option>
                              {q.options.map((opt) => (
                                <option key={opt} value={opt}>
                                  {tankLabels[opt] || opt.replace(/_/g, " ")}
                                </option>
                              ))}
                            </select>
                          )}
                          {q.type === "number" && (
                            <input
                              type="number"
                              value={tankAnswers[q.id] ?? ""}
                              onChange={(e) => setTankAnswer(q.id, e.target.value === "" ? "" : Number(e.target.value))}
                              style={{ width: "100%", borderRadius: 10, border: "1px solid #E8EAED", padding: "10px 14px", fontSize: 13, color: "#1A1A2E", background: "#fff", outline: "none" }}
                              placeholder="0"
                            />
                          )}
                          {q.type === "boolean" && (
                            <div style={{ display: "flex", gap: 8 }}>
                              <button type="button" onClick={() => setTankAnswer(q.id, true)} style={{
                                borderRadius: 8, border: "1px solid #E8EAED", padding: "8px 20px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                                background: tankAnswers[q.id] === true ? "#2D6A4F" : "#fff",
                                color: tankAnswers[q.id] === true ? "#fff" : "#6B7280",
                                borderColor: tankAnswers[q.id] === true ? "#2D6A4F" : "#E8EAED",
                              }}>Yes</button>
                              <button type="button" onClick={() => setTankAnswer(q.id, false)} style={{
                                borderRadius: 8, border: "1px solid #E8EAED", padding: "8px 20px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                                background: tankAnswers[q.id] === false ? "#2D6A4F" : "#fff",
                                color: tankAnswers[q.id] === false ? "#fff" : "#6B7280",
                                borderColor: tankAnswers[q.id] === false ? "#2D6A4F" : "#E8EAED",
                              }}>No</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </>
                  ) : (
                    <div style={{
                      marginTop: 16,
                      padding: "10px 14px",
                      borderRadius: 10,
                      background: "#ECFDF5",
                      border: "1px solid rgba(5,150,105,0.2)",
                      fontSize: 12,
                      color: "#065F46",
                    }}>
                      All required answers are already available. You can calculate directly.
                    </div>
                  )}

                  {tankCapacityError ? (
                    <div style={{
                      marginTop: 14,
                      padding: "10px 14px",
                      borderRadius: 10,
                      background: "#FEF2F2",
                      border: "1px solid rgba(220,38,38,0.2)",
                      color: "#B91C1C",
                      fontSize: 12,
                    }}>
                      {tankCapacityError}
                    </div>
                  ) : null}

                  {tankCapacityEval?.water_pump_requirements ? (
                    <div style={{
                      marginTop: 16,
                      padding: "12px 14px",
                      borderRadius: 12,
                      background: "#ECFDF5",
                      border: "1px solid rgba(5,150,105,0.2)",
                      color: "#1A1A2E",
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#065F46", marginBottom: 8 }}>Fire Water Capacity Summary</div>
                      <div style={{ fontSize: 12, display: "grid", gap: 8 }}>
                        {Object.entries(tankCapacityEval.water_pump_requirements).map(([key, value]) => (
                          <div key={key} style={{
                            display: "grid",
                            gridTemplateColumns: "minmax(180px, 1fr) 1fr",
                            gap: 10,
                            alignItems: "start",
                            padding: "6px 8px",
                            borderRadius: 8,
                            background: "rgba(255,255,255,0.65)",
                          }}>
                            <div style={{ color: "#065F46", fontWeight: 600 }}>{humanizeWaterPumpKey(key)}</div>
                            <div style={{ color: "#1A1A2E", fontWeight: 700 }}>{renderWaterPumpValue(key, value)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                    <button onClick={() => setShowTankCapacityModal(false)} style={btn(false)}>Close</button>
                    <button
                      onClick={calculateTankCapacity}
                      disabled={tankCapacitySaving || tankMissingQuestions.length > 0}
                      style={btn(true)}
                    >
                      {tankCapacitySaving ? "Calculating..." : "Calculate & Save"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}



      {editorOpen ? (
      <section style={{ ...styles.canvasPanel, display: "flex", flexDirection: "column" }}>
        {/* ── Back to workspace button ── */}
        <div style={{ padding: "10px 14px", borderBottom: "1px solid #E8EAED", display: "flex", alignItems: "center", gap: 10, background: "#FAFBFC", flexShrink: 0 }}>
          <button onClick={() => setEditorOpen(false)} style={{
            padding: "6px 14px", borderRadius: 8, border: "1px solid #E8EAED",
            background: "#FFFFFF", color: "#1A1A2E", cursor: "pointer",
            fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Back to Workspace
          </button>
          <span style={{ fontSize: 13, color: "#6B7280" }}>{project?.name || "Project"}</span>
          {canEdit ? <div style={{ flex: 1 }} /> : null}
          {canEdit ? (
            <button onClick={openTankCapacityModal} style={{
              padding: "6px 12px", borderRadius: 8,
              border: "1px solid #E8EAED", background: "#FFFFFF",
              color: "#1A1A2E", cursor: "pointer", fontSize: 12, fontWeight: 600,
              display: "flex", alignItems: "center", gap: 6,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>
              Tank Capacity
            </button>
          ) : null}
        </div>
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {isAwaitingFloorReview && project?.files?.dxf ? (
          <FloorPlanExtractor
            dxfUrl={apiUrl(project.files.dxf)}
            mapping={mapping}
            onConfirm={async (plans) => {
              // Create floor plans from detected boxes, upload frontend-rendered PNGs,
              // then continue the backend mask-generation pipeline.
              await clearAllFloorPlansForProject();
              const created: any[] = [];
              for (const plan of plans) {
                const fp = await addFloorPlan(plan.world_bbox);
                if (!fp?.id) continue;
                if (!plan.render_blob) {
                  throw new Error(`Missing rendered image for floor plan ${fp.id}`);
                }
                await uploadFloorPlanRenderImage(fp.id, plan.render_blob);
                created.push({ id: fp.id, height_m: plan.height_m });
              }
              // Persist user-entered floor heights
              for (const item of created) {
                if (item.id && Number.isFinite(Number(item.height_m)) && Number(item.height_m) > 0) {
                  await authFetch(`/api/projects/${projectId}/floor_plans/${item.id}`, {
                    method: "PUT",
                    body: JSON.stringify({ height_m: Number(item.height_m) }),
                  });
                }
              }
              // Then continue pipeline
              await continuePipelineAfterFloorReview();
            }}
            canEdit={canEdit}
          />
        ) : isAwaitingFloorReview ? (
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            padding: 20,
            background: "#FEF2F2",
            border: "1px solid rgba(220,38,38,0.2)",
            color: "#991B1B",
          }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginBottom: 16 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>DXF File Required</p>
            <p style={{ fontSize: 14, color: "#991B1B", textAlign: "center" }}>
              Floor plan extraction requires a DXF file. Please upload a DWG file which will be converted to DXF.
            </p>
          </div>
        ) : isAwaitingAlignmentReview ? (
          floorPlans.length > 0 ? (
            /* ── Floor-plan-based alignment review ── */
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              {/* Block selector tabs */}
              {floorPlans.length > 1 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 6, padding: "8px 12px",
                borderBottom: "1px solid #E8EAED", background: "#F8FAF9", flexShrink: 0, flexWrap: "wrap",
              }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#1A3C34", marginRight: 4 }}>Floor Plans:</span>
                {floorPlans.map((fp, i) => (
                  <button
                    key={fp.id}
                    onClick={() => setActiveBlockIndex(i)}
                    style={{
                      padding: "5px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
                      border: activeBlockIndex === i ? "2px solid #2D6A4F" : "1px solid #D1D5DB",
                      background: activeBlockIndex === i ? "#D8F3DC" : "#FFFFFF",
                      color: activeBlockIndex === i ? "#1A3C34" : "#4B5563",
                    }}
                  >
                    Block {fp.block_index + 1}
                    {fp.status === "aligned" ? " \u2713" : ""}
                  </button>
                ))}
              </div>
              )}
              <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
                {(() => {
                  const fp = floorPlans[activeBlockIndex];
                  if (!fp) return null;
                  const blockRender = fp.files?.render_png;
                  const blockMask = fp.files?.aligned_mask || fp.files?.mask_png;
                  if (blockRender && blockMask) {
                    return (
                      <AlignmentReview
                        key={fp.id}
                        originalUrl={apiMediaUrl(blockRender, mediaVersion)}
                        alignedUrl={apiMediaUrl(blockMask, mediaVersion)}
                        onContinue={continuePipelineAfterAlignment}
                        onUploadAlignedMask={uploadAlignedMaskFile}
                        onRetryGeneration={retryMaskGeneration}
                        onRefresh={refresh}
                        blockLabel={floorPlans.length > 1 ? `Block ${fp.block_index + 1} of ${floorPlans.length}` : undefined}
                        canEdit={canEdit}
                      />
                    );
                  }
                  return (
                    <div style={styles.emptyState}>
                      <h3 style={styles.emptyTitle}>Block {fp.block_index + 1} mask not available</h3>
                      <p style={styles.emptySubtitle}>Upload an aligned mask for this block.</p>
                    </div>
                  );
                })()}
              </div>
            </div>
          ) : project?.files?.aligned_mask && project?.files?.render_png ? (
            <AlignmentReview
              originalUrl={apiMediaUrl(project.files.render_png, mediaVersion)}
              alignedUrl={apiMediaUrl(project.files.aligned_mask, mediaVersion)}
              onContinue={continuePipelineAfterAlignment}
              onUploadAlignedMask={uploadAlignedMaskFile}
              onRetryGeneration={retryMaskGeneration}
              onRefresh={refresh}
              canEdit={canEdit}
            />
          ) : (
            <div style={styles.emptyState}>
              <h3 style={styles.emptyTitle}>Aligned mask not available</h3>
              <p style={styles.emptySubtitle}>Upload an aligned mask from the sidebar to continue.</p>
            </div>
          )
        ) : isAwaitingRoomReview && project?.files?.render_png && mapping ? (
          floorPlans.length > 0 ? (
            /* ── Multi-block room review ── */
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 6, padding: "8px 12px",
                borderBottom: "1px solid #E8EAED", background: "#F8FAF9", flexShrink: 0, flexWrap: "wrap",
              }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#1A3C34", marginRight: 4 }}>Floor Plans:</span>
                {floorPlans.map((fp, i) => (
                  <button
                    key={fp.id}
                    onClick={() => setActiveBlockIndex(i)}
                    style={{
                      padding: "5px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
                      border: activeBlockIndex === i ? "2px solid #2D6A4F" : "1px solid #D1D5DB",
                      background: activeBlockIndex === i ? "#D8F3DC" : "#FFFFFF",
                      color: activeBlockIndex === i ? "#1A3C34" : "#4B5563",
                    }}
                  >
                    Block {fp.block_index + 1}
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: "#4B5563", fontWeight: 600 }}>Units</span>
                <select
                  value={reviewUnits}
                  disabled={!canEdit}
                  onChange={async (e) => { await updateProjectUnits(e.target.value); }}
                  style={{ width: 96, padding: "4px 8px", borderRadius: 8, border: "1px solid #D1D5DB", background: "#FFFFFF", fontSize: 12 }}
                >
                  <option value="mm">mm</option>
                  <option value="cm">cm</option>
                  <option value="m">m</option>
                  <option value="ft">ft</option>
                  <option value="in">in</option>
                </select>
              </div>
              <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
                {(() => {
                  const fp = floorPlans[activeBlockIndex];
                  if (!fp) return null;
                  const fpRender = fp.files?.render_png;
                  const fpMapping = fp.files?.mapping_json;
                  if (!fpRender || !fpMapping) {
                    return (
                      <div style={styles.emptyState}>
                        <h3 style={styles.emptyTitle}>Block {fp.block_index + 1} not ready</h3>
                      </div>
                    );
                  }
                  return (
                    <FloorPlanRoomEditor
                      key={fp.id}
                      renderUrl={apiUrl(fpRender)}
                      mappingUrl={apiUrl(fpMapping)}
                      projectId={projectId}
                      floorPlanId={fp.id}
                      nbcEquipment={project?.nbc_evaluation?.equipment || []}
                      onSave={saveRoomsOnly}
                      onContinue={saveRoomsAndContinue}
                      displayUnit={reviewUnits}
                      worldToM={reviewWorldToM}
                      canEdit={canEdit}
                    />
                  );
                })()}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                borderBottom: "1px solid #E8EAED", background: "#F8FAF9", flexShrink: 0,
              }}>
                <span style={{ fontSize: 12, color: "#4B5563", fontWeight: 600 }}>Units</span>
                <select
                  value={reviewUnits}
                  disabled={!canEdit}
                  onChange={async (e) => { await updateProjectUnits(e.target.value); }}
                  style={{ width: 96, padding: "4px 8px", borderRadius: 8, border: "1px solid #D1D5DB", background: "#FFFFFF", fontSize: 12 }}
                >
                  <option value="mm">mm</option>
                  <option value="cm">cm</option>
                  <option value="m">m</option>
                  <option value="ft">ft</option>
                  <option value="in">in</option>
                </select>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <RoomEditor
                  renderUrl={apiUrl(project.files.render_png)}
                  mapping={mapping}
                  projectId={projectId}
                  nbcEquipment={project?.nbc_evaluation?.equipment || []}
                  onSave={saveRoomsOnly}
                  onContinue={saveRoomsAndContinue}
                  displayUnit={reviewUnits}
                  worldToM={reviewWorldToM}
                  canEdit={canEdit}
                />
              </div>
            </div>
          )
        ) : !project?.files?.render_png || !mapping ? (
          <div style={styles.emptyState}>
            <h3 style={styles.emptyTitle}>No preview yet</h3>
            <p style={styles.emptySubtitle}>Upload a DXF/DWG and run auto-placement to generate your interactive view.</p>
          </div>
        ) : (
          floorPlans.length > 0 ? (
            /* ── Multi-block editor ── */
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 6, padding: "8px 12px",
                borderBottom: "1px solid #E8EAED", background: "#F8FAF9", flexShrink: 0, flexWrap: "wrap",
              }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#1A3C34", marginRight: 4 }}>Floor Plans:</span>
                {floorPlans.map((fp, i) => (
                  <button
                    key={fp.id}
                    onClick={() => setActiveBlockIndex(i)}
                    style={{
                      padding: "5px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
                      border: activeBlockIndex === i ? "2px solid #2D6A4F" : "1px solid #D1D5DB",
                      background: activeBlockIndex === i ? "#D8F3DC" : "#FFFFFF",
                      color: activeBlockIndex === i ? "#1A3C34" : "#4B5563",
                    }}
                  >
                    Block {fp.block_index + 1}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
                {(() => {
                  const fp = floorPlans[activeBlockIndex];
                  if (!fp) return null;
                  const fpRender = fp.files?.render_png;
                  const fpMapping = fp.files?.mapping_json;
                  if (!fpRender || !fpMapping) {
                    return (
                      <div style={styles.emptyState}>
                        <h3 style={styles.emptyTitle}>Block {fp.block_index + 1} not ready</h3>
                      </div>
                    );
                  }
                  return (
                    <FloorPlanEditor
                      key={fp.id}
                      renderUrl={apiUrl(fpRender)}
                      mappingUrl={apiUrl(fpMapping)}
                      projectId={projectId}
                      floorPlanId={fp.id}
                      floorPlan={fp}
                      isReady={isReady}
                      exportDxfUrl={project?.files?.output_dxf ? apiUrl(project.files.output_dxf) : null}
                      exportPngUrl={project?.files?.output_preview_png ? apiUrl(project.files.output_preview_png) : null}
                      onSave={saveLayout}
                      onChanged={refresh}
                      worldToM={reviewWorldToM}
                      canEdit={canEdit}
                    />
                  );
                })()}
              </div>
            </div>
          ) : (
            <Editor
              renderUrl={apiUrl(project.files.render_png)}
              mapping={mapping}
              detectors={detectors}
              projectId={projectId}
              isReady={isReady}
              pipesData={pipesData}
              exportDxfUrl={project?.files?.output_dxf ? apiUrl(project.files.output_dxf) : null}
              exportPngUrl={project?.files?.output_preview_png ? apiUrl(project.files.output_preview_png) : null}
              onSave={saveLayout}
              onChanged={refresh}
              worldToM={reviewWorldToM}
              canEdit={canEdit}
            />
          )
        )}
        </div>
      </section>
      ) : null}

      {/* Render tank-capacity modal in editor mode as well */}
      {showTankCapacityModal && !isQuestionnaireMode ? (
        <div style={{
          position: "fixed", inset: 0, zIndex: 50,
          background: "rgba(0,0,0,0.35)", backdropFilter: "blur(4px)",
          display: "grid", placeItems: "center",
        }} onClick={() => setShowTankCapacityModal(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            width: "min(680px, calc(100% - 32px))", borderRadius: 20,
            background: "#FFFFFF",
            border: "1px solid #E8EAED", boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
            padding: 0, maxHeight: "90vh", overflow: "hidden",
            display: "flex", flexDirection: "column",
          }}>
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "18px 24px", borderBottom: "1px solid #E8EAED",
            }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "#1A1A2E" }}>Calculate Water Tank Capacity</h3>
              <button onClick={() => setShowTankCapacityModal(false)} style={{
                background: "none", border: "none", fontSize: 22, color: "#9CA3AF",
                cursor: "pointer", padding: "4px 8px", lineHeight: 1,
              }}>&times;</button>
            </div>

            <div style={{ padding: "0 24px 24px", overflowY: "auto", flex: 1 }}>
              <div style={{
                marginTop: 16,
                padding: "10px 14px",
                borderRadius: 10,
                background: "#F8FAFC",
                border: "1px solid #E2E8F0",
                fontSize: 12,
                color: "#334155",
              }}>
                This asks only missing NBC inputs. Answers already captured during project creation are reused.
              </div>

              {tankMissingQuestions.length > 0 ? (
                <>
                  {tankMissingQuestions.map((q) => (
                    <div key={q.id} style={{ marginTop: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", marginBottom: 6 }}>{q.label}</div>
                      {q.type === "select" && q.options && (
                        <select
                          value={tankAnswers[q.id] ?? ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setTankAnswer(q.id, val);
                            if (q.id === "occupancy_subtype") tankSelectOccupancy(val);
                          }}
                          style={{ width: "100%", borderRadius: 10, border: "1px solid #E8EAED", padding: "10px 14px", fontSize: 13, color: "#1A1A2E", background: "#fff", outline: "none", cursor: "pointer" }}
                        >
                          <option value="">- Select -</option>
                          {q.options.map((opt) => (
                            <option key={opt} value={opt}>
                              {tankLabels[opt] || opt.replace(/_/g, " ")}
                            </option>
                          ))}
                        </select>
                      )}
                      {q.type === "number" && (
                        <input
                          type="number"
                          value={tankAnswers[q.id] ?? ""}
                          onChange={(e) => setTankAnswer(q.id, e.target.value === "" ? "" : Number(e.target.value))}
                          style={{ width: "100%", borderRadius: 10, border: "1px solid #E8EAED", padding: "10px 14px", fontSize: 13, color: "#1A1A2E", background: "#fff", outline: "none" }}
                          placeholder="0"
                        />
                      )}
                      {q.type === "boolean" && (
                        <div style={{ display: "flex", gap: 8 }}>
                          <button type="button" onClick={() => setTankAnswer(q.id, true)} style={{
                            borderRadius: 8, border: "1px solid #E8EAED", padding: "8px 20px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                            background: tankAnswers[q.id] === true ? "#2D6A4F" : "#fff",
                            color: tankAnswers[q.id] === true ? "#fff" : "#6B7280",
                            borderColor: tankAnswers[q.id] === true ? "#2D6A4F" : "#E8EAED",
                          }}>Yes</button>
                          <button type="button" onClick={() => setTankAnswer(q.id, false)} style={{
                            borderRadius: 8, border: "1px solid #E8EAED", padding: "8px 20px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                            background: tankAnswers[q.id] === false ? "#2D6A4F" : "#fff",
                            color: tankAnswers[q.id] === false ? "#fff" : "#6B7280",
                            borderColor: tankAnswers[q.id] === false ? "#2D6A4F" : "#E8EAED",
                          }}>No</button>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              ) : (
                <div style={{
                  marginTop: 16,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "#ECFDF5",
                  border: "1px solid rgba(5,150,105,0.2)",
                  fontSize: 12,
                  color: "#065F46",
                }}>
                  All required answers are already available. You can calculate directly.
                </div>
              )}

              {tankCapacityError ? (
                <div style={{
                  marginTop: 14,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "#FEF2F2",
                  border: "1px solid rgba(220,38,38,0.2)",
                  color: "#B91C1C",
                  fontSize: 12,
                }}>
                  {tankCapacityError}
                </div>
              ) : null}

              {tankCapacityEval?.water_pump_requirements ? (
                <div style={{
                  marginTop: 16,
                  padding: "12px 14px",
                  borderRadius: 12,
                  background: "#ECFDF5",
                  border: "1px solid rgba(5,150,105,0.2)",
                  color: "#1A1A2E",
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#065F46", marginBottom: 8 }}>Fire Water Capacity Summary</div>
                  <div style={{ fontSize: 12, display: "grid", gap: 8 }}>
                    {Object.entries(tankCapacityEval.water_pump_requirements).map(([key, value]) => (
                      <div key={key} style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(180px, 1fr) 1fr",
                        gap: 10,
                        alignItems: "start",
                        padding: "6px 8px",
                        borderRadius: 8,
                        background: "rgba(255,255,255,0.65)",
                      }}>
                        <div style={{ color: "#065F46", fontWeight: 600 }}>{humanizeWaterPumpKey(key)}</div>
                        <div style={{ color: "#1A1A2E", fontWeight: 700 }}>{renderWaterPumpValue(key, value)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                <button onClick={() => setShowTankCapacityModal(false)} style={btn(false)}>Close</button>
                <button
                  onClick={calculateTankCapacity}
                  disabled={tankCapacitySaving || tankMissingQuestions.length > 0}
                  style={btn(true)}
                >
                  {tankCapacitySaving ? "Calculating..." : "Calculate & Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
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
          border: 1px solid #E8EAED;
          background: #FFFFFF;
          color: #1A1A2E;
          padding: 10px 12px;
          outline: none;
        }

        input[type="text"]:focus,
        input[type="number"]:focus,
        select:focus {
          border-color: #2D6A4F;
          box-shadow: 0 0 0 2px rgba(45, 106, 79, 0.12);
        }

        input[type="file"] {
          width: 100%;
          border-radius: 12px;
          border: 1px solid #E8EAED;
          background: #FAFBFC;
          color: #1A1A2E;
          padding: 8px;
        }

        option {
          color: #1A1A2E;
          background: #ffffff;
        }

        .wizardStepPanel {
          animation: wizardFadeSlide 260ms ease;
        }

        .runningOrb {
          width: 58px;
          height: 58px;
          border-radius: 999px;
          background: radial-gradient(circle at 35% 35%, #D8F3DC 0%, #52B788 45%, #2D6A4F 100%);
          box-shadow: 0 6px 20px rgba(45, 106, 79, 0.25);
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
          border: 2px solid rgba(45, 106, 79, 0.15);
          border-top-color: #2D6A4F;
          transform: translateX(-50%);
          animation: spinRing 1.2s linear infinite;
          pointer-events: none;
        }

        .globalLoaderSpinner {
          width: 44px;
          height: 44px;
          border-radius: 999px;
          border: 3px solid #E8EAED;
          border-top-color: #2D6A4F;
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

        .stageDot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #52B788;
          animation: stagePulse 1s ease-in-out infinite;
        }

        @keyframes stagePulse {
          0%, 100% { opacity: 0.5; transform: scale(0.9); }
          50% { opacity: 1; transform: scale(1.2); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </main>
  );
}

// ─── Floor Plan Review Component ─────────────────────────────────────────────

function FloorPlanReview({
  renderUrl,
  mapping,
  floorPlans,
  initialHeightsByFloorPlanId,
  onConfirm,
  onAddFloorPlan,
  onDeleteFloorPlan,
  onRefresh,
  canEdit = true,
}: {
  renderUrl: string;
  mapping: Mapping;
  floorPlans: FloorPlan[];
  initialHeightsByFloorPlanId?: Record<string, number>;
  onConfirm: (heightsByFloorPlanId: Record<string, number>) => Promise<void>;
  onAddFloorPlan: (pixelBbox: number[]) => Promise<void>;
  onDeleteFloorPlan: (fpId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  canEdit?: boolean;
}) {
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [drawStart, setDrawStart] = useState<{ px: number; py: number } | null>(null);
  const [drawEnd, setDrawEnd] = useState<{ px: number; py: number } | null>(null);
  const [hoveredFp, setHoveredFp] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [floorHeights, setFloorHeights] = useState<Record<string, string>>({});
  const svgRef = useRef<SVGSVGElement>(null);

  const COLORS = ["#2563EB", "#DC2626", "#059669", "#D97706", "#7C3AED", "#DB2777", "#0891B2", "#65A30D"];

  function fpColor(index: number) {
    return COLORS[index % COLORS.length];
  }

  function worldBboxToPixelRect(wb: { xmin: number; ymin: number; xmax: number; ymax: number }) {
    const tl = worldToPixel(mapping, wb.xmin, wb.ymax);
    const br = worldToPixel(mapping, wb.xmax, wb.ymin);
    return {
      x: Math.min(tl.px, br.px),
      y: Math.min(tl.py, br.py),
      width: Math.abs(br.px - tl.px),
      height: Math.abs(br.py - tl.py),
    };
  }

  function toImagePoint(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || !imgDims) return null;
    const rect = svg.getBoundingClientRect();
    const scaleX = imgDims.w / rect.width;
    const scaleY = imgDims.h / rect.height;
    return {
      px: (e.clientX - rect.left) * scaleX,
      py: (e.clientY - rect.top) * scaleY,
    };
  }

  useEffect(() => {
    setFloorHeights((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const fp of floorPlans) {
        if (next[fp.id] !== undefined) continue;
        const initial = initialHeightsByFloorPlanId?.[fp.id];
        next[fp.id] = Number.isFinite(initial as number) ? String(initial) : "";
      }
      for (const fpId of Object.keys(next)) {
        if (!floorPlans.some((fp) => fp.id === fpId)) delete next[fpId];
      }
      return next;
    });
  }, [floorPlans, initialHeightsByFloorPlanId]);

  const allHeightsEntered = floorPlans.length > 0 && floorPlans.every((fp) => {
    const v = Number(floorHeights[fp.id]);
    return Number.isFinite(v) && v > 0;
  });

  async function handleConfirm() {
    if (!allHeightsEntered) return;
    setIsConfirming(true);
    try {
      const heightsByFloorPlanId: Record<string, number> = {};
      for (const fp of floorPlans) {
        const v = Number(floorHeights[fp.id]);
        if (Number.isFinite(v) && v > 0) heightsByFloorPlanId[fp.id] = v;
      }
      await onConfirm(heightsByFloorPlanId);
    } finally {
      setIsConfirming(false);
    }
  }

  async function handleFinishDraw() {
    if (!drawStart || !drawEnd) return;
    const x0 = Math.round(Math.min(drawStart.px, drawEnd.px));
    const y0 = Math.round(Math.min(drawStart.py, drawEnd.py));
    const x1 = Math.round(Math.max(drawStart.px, drawEnd.px));
    const y1 = Math.round(Math.max(drawStart.py, drawEnd.py));
    if (x1 - x0 < 10 || y1 - y0 < 10) return;
    setIsAdding(true);
    try {
      await onAddFloorPlan([x0, y0, x1, y1]);
      setDrawStart(null);
      setDrawEnd(null);
      setDrawMode(false);
    } finally {
      setIsAdding(false);
    }
  }

  const drawRect = drawStart && drawEnd
    ? {
        x: Math.min(drawStart.px, drawEnd.px),
        y: Math.min(drawStart.py, drawEnd.py),
        width: Math.abs(drawEnd.px - drawStart.px),
        height: Math.abs(drawEnd.py - drawStart.py),
      }
    : null;

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
        borderBottom: "1px solid #E8EAED", background: "#FAFBFC", flexShrink: 0,
        flexWrap: "wrap",
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1A2E" }}>
          Review Floor Plans
        </span>
        <span style={{ fontSize: 12, color: "#6B7280" }}>
          {floorPlans.length} floor plan{floorPlans.length !== 1 ? "s" : ""} detected
        </span>
        <div style={{ flex: 1 }} />
        {canEdit && (
        <button
          onClick={() => {
            setDrawMode(!drawMode);
            setDrawStart(null);
            setDrawEnd(null);
          }}
          style={{
            padding: "7px 14px", borderRadius: 10, fontSize: 12, fontWeight: 600,
            cursor: "pointer",
            border: drawMode ? "2px solid #2D6A4F" : "1px solid #E8EAED",
            background: drawMode ? "#D8F3DC" : "#FFFFFF",
            color: drawMode ? "#1A3C34" : "#1A1A2E",
            display: "flex", alignItems: "center", gap: 6,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {drawMode ? "Drawing..." : "Add Floor Plan"}
        </button>
        )}
        <button onClick={onRefresh} style={{
          padding: "7px 14px", borderRadius: 10, border: "1px solid #E8EAED",
          background: "#FFFFFF", color: "#1A1A2E", cursor: "pointer",
          fontSize: 12, fontWeight: 600,
        }}>Refresh</button>
        {canEdit && (
        <button
          onClick={handleConfirm}
          disabled={isConfirming || !allHeightsEntered}
          style={{
            padding: "7px 18px", borderRadius: 10, border: "none",
            background: "#2D6A4F", color: "#fff", cursor: "pointer",
            fontSize: 12, fontWeight: 700,
            boxShadow: "0 4px 12px rgba(45,106,79,0.3)",
            opacity: isConfirming || !allHeightsEntered ? 0.6 : 1,
          }}
        >
          {isConfirming ? "Confirming..." : "Confirm & Continue"}
        </button>
        )}
      </div>

      {/* Content area: image + sidebar legend */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Image area */}
        <div style={{ flex: 1, overflow: "auto", padding: 12, background: "#F0F2F5" }}>
          <div style={{ position: "relative", display: "inline-block" }}>
            <img
              src={renderUrl}
              alt="Master render"
              onLoad={(e) => {
                const img = e.currentTarget;
                setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              style={{ display: "block", userSelect: "none", pointerEvents: "none", maxWidth: "100%" }}
              draggable={false}
            />
            {imgDims && (
              <svg
                ref={svgRef}
                width="100%"
                height="100%"
                viewBox={`0 0 ${imgDims.w} ${imgDims.h}`}
                style={{
                  position: "absolute", left: 0, top: 0,
                  cursor: drawMode ? "crosshair" : "default",
                }}
                onMouseDown={(e) => {
                  if (!drawMode) return;
                  const pt = toImagePoint(e);
                  if (pt) {
                    setDrawStart(pt);
                    setDrawEnd(pt);
                  }
                }}
                onMouseMove={(e) => {
                  if (!drawMode || !drawStart) return;
                  const pt = toImagePoint(e);
                  if (pt) setDrawEnd(pt);
                }}
                onMouseUp={() => {
                  if (!drawMode || !drawStart || !drawEnd) return;
                  // Keep the rectangle drawn, user clicks "Add" button or we auto-add
                  handleFinishDraw();
                }}
              >
                {/* Existing floor plan bounding boxes */}
                {floorPlans.map((fp, i) => {
                  if (!fp.world_bbox) return null;
                  const rect = worldBboxToPixelRect(fp.world_bbox);
                  const color = fpColor(i);
                  const isHovered = hoveredFp === fp.id;
                  return (
                    <g key={fp.id}
                      onMouseEnter={() => setHoveredFp(fp.id)}
                      onMouseLeave={() => setHoveredFp(null)}
                    >
                      <rect
                        x={rect.x} y={rect.y} width={rect.width} height={rect.height}
                        fill={isHovered ? `${color}22` : `${color}11`}
                        stroke={color} strokeWidth={isHovered ? 4 : 2.5}
                        strokeDasharray={isHovered ? "none" : "8 4"}
                        rx={4}
                      />
                      {/* Label */}
                      <rect
                        x={rect.x} y={rect.y - 24}
                        width={Math.max(80, 16 + (`Floor ${i + 1}`).length * 8)}
                        height={22} rx={4}
                        fill={color} opacity={0.9}
                      />
                      <text
                        x={rect.x + 8} y={rect.y - 8}
                        fill="#fff" fontSize={13} fontWeight={700}
                        fontFamily="system-ui, sans-serif"
                      >
                        Floor {i + 1}
                      </text>
                    </g>
                  );
                })}

                {/* Height inputs above each highlighted floor plan */}
                {canEdit && floorPlans.map((fp, i) => {
                  if (!fp.world_bbox) return null;
                  const rect = worldBboxToPixelRect(fp.world_bbox);
                  const val = floorHeights[fp.id] ?? "";
                  const inputWidth = 132;
                  const fx = Math.max(0, Math.min(rect.x + rect.width * 0.5 - inputWidth * 0.5, imgDims.w - inputWidth));
                  const fy = Math.max(0, rect.y - 52);
                  return (
                    <foreignObject key={`fp-height-${fp.id}`} x={fx} y={fy} width={inputWidth} height={30}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,0.95)", border: "1px solid #D1D5DB", borderRadius: 8, padding: "2px 6px" }}>
                        <input
                          type="number"
                          min={0.1}
                          step={0.1}
                          value={val}
                          onChange={(e) => setFloorHeights((prev) => ({ ...prev, [fp.id]: e.target.value }))}
                          placeholder={`H${i + 1} (m)`}
                          style={{ width: 86, border: "none", outline: "none", fontSize: 11, background: "transparent", color: "#111827" }}
                        />
                        <span style={{ fontSize: 11, color: "#374151", fontWeight: 600 }}>m</span>
                      </div>
                    </foreignObject>
                  );
                })}

                {/* Drawing rectangle */}
                {drawMode && drawRect && (
                  <rect
                    x={drawRect.x} y={drawRect.y}
                    width={drawRect.width} height={drawRect.height}
                    fill="rgba(45,106,79,0.12)"
                    stroke="#2D6A4F" strokeWidth={3}
                    strokeDasharray="8 4"
                    rx={4}
                  />
                )}
              </svg>
            )}
            {isAdding && (
              <div style={{
                position: "absolute", inset: 0,
                background: "rgba(0,0,0,0.15)",
                display: "grid", placeItems: "center",
              }}>
                <div style={{
                  padding: "12px 24px", borderRadius: 12,
                  background: "#fff", boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  fontSize: 13, fontWeight: 600, color: "#1A1A2E",
                }}>Adding floor plan...</div>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar legend */}
        <div style={{
          width: 260, flexShrink: 0, borderLeft: "1px solid #E8EAED",
          background: "#FFFFFF", padding: "14px", overflow: "auto",
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1A2E", marginBottom: 12 }}>
            Detected Floor Plans
          </div>
          {floorPlans.length === 0 ? (
            <div style={{ fontSize: 12, color: "#9CA3AF", padding: "8px 0" }}>
              No floor plans detected. Use "Add Floor Plan" to mark areas manually.
            </div>
          ) : null}
          {floorPlans.map((fp, i) => {
            const color = fpColor(i);
            const heightVal = floorHeights[fp.id] ?? "";
            return (
              <div
                key={fp.id}
                onMouseEnter={() => setHoveredFp(fp.id)}
                onMouseLeave={() => setHoveredFp(null)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 10px", borderRadius: 10, marginBottom: 6,
                  background: hoveredFp === fp.id ? "#F0FDF4" : "#FAFBFC",
                  border: hoveredFp === fp.id ? `1px solid ${color}40` : "1px solid #E8EAED",
                  transition: "background 0.15s, border 0.15s",
                }}
              >
                <div style={{
                  width: 14, height: 14, borderRadius: 4,
                  background: color, flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A2E" }}>
                    Floor {i + 1}
                  </div>
                  <div style={{ fontSize: 10, color: "#9CA3AF" }}>
                    Block {fp.block_index}
                  </div>
                  <div style={{ marginTop: 6 }}>
                    {canEdit ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          type="number"
                          min={0.1}
                          step={0.1}
                          value={heightVal}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            e.stopPropagation();
                            setFloorHeights((prev) => ({ ...prev, [fp.id]: e.target.value }));
                          }}
                          placeholder="Height"
                          style={{
                            width: 86,
                            borderRadius: 6,
                            border: "1px solid #D1D5DB",
                            padding: "3px 6px",
                            fontSize: 11,
                            color: "#1A1A2E",
                            background: "#FFFFFF",
                            outline: "none",
                          }}
                        />
                        <span style={{ fontSize: 11, color: "#6B7280", fontWeight: 600 }}>m</span>
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: "#6B7280" }}>
                        Height: {heightVal ? `${heightVal} m` : "Not set"}
                      </div>
                    )}
                  </div>
                </div>
                {fp.files?.render_png && (
                  <img
                    src={fp.files.render_png.startsWith("/") ? `${resolveApiBase()}${fp.files.render_png}` : fp.files.render_png}
                    alt={`Floor ${i + 1}`}
                    style={{ width: 40, height: 40, objectFit: "contain", borderRadius: 6, border: "1px solid #E8EAED" }}
                  />
                )}
                {canEdit && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await onDeleteFloorPlan(fp.id);
                  }}
                  title="Remove floor plan"
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: "#DC2626", fontSize: 16, padding: "2px 6px",
                    borderRadius: 6, lineHeight: 1,
                  }}
                >
                  &times;
                </button>
                )}
              </div>
            );
          })}

          {drawMode && (
            <div style={{
              marginTop: 12, padding: "10px", borderRadius: 10,
              background: "#EFF6FF", border: "1px solid rgba(37,99,235,0.2)",
              fontSize: 12, color: "#1E40AF", lineHeight: 1.5,
            }}>
              Click and drag on the image to draw a rectangle around a floor plan.
            </div>
          )}

          <div style={{
            marginTop: 16, padding: "10px", borderRadius: 10,
            background: "#FEFCE8", border: "1px solid rgba(217,119,6,0.2)",
            fontSize: 11, color: "#92400E", lineHeight: 1.5,
          }}>
            Review the detected floor plans and enter height (m) for each one.
            Confirm & Continue is enabled only after all floor plan heights are filled.
          </div>
        </div>
      </div>
    </div>
  );
}

function AlignmentReview({
  originalUrl,
  alignedUrl,
  onContinue,
  onUploadAlignedMask,
  onRetryGeneration,
  onRefresh,
  blockLabel,
  canEdit = true,
}: {
  originalUrl: string;
  alignedUrl: string;
  onContinue: (adjustedMaskBlob: Blob) => Promise<void>;
  onUploadAlignedMask: (e: any) => Promise<void>;
  onRetryGeneration: (instruction: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  blockLabel?: string;
  canEdit?: boolean;
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
  const [isRetrying, setIsRetrying] = useState(false);
  const [generationInstruction, setGenerationInstruction] = useState("");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const hasAutoFitRef = useRef(false);
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

  useEffect(() => {
    if (!origDims || hasAutoFitRef.current) return;
    const vp = viewportRef.current;
    if (!vp) return;
    const availW = Math.max(120, vp.clientWidth - 20);
    const availH = Math.max(120, vp.clientHeight - 20);
    const fitZoom = Math.min(availW / origDims.w, availH / origDims.h);
    if (Number.isFinite(fitZoom) && fitZoom > 0) {
      setViewZoom(Math.max(0.25, Math.min(3, fitZoom)));
      hasAutoFitRef.current = true;
    }
  }, [origDims]);

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

  async function retryGeneration() {
    setIsRetrying(true);
    try {
      await onRetryGeneration(generationInstruction.trim());
    } finally {
      setIsRetrying(false);
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
          background: "rgba(9, 24, 14, 0.78)",
          padding: "10px 12px",
          flexWrap: "wrap",
        }}
      >
        {blockLabel && (
          <span style={{ fontSize: 13, fontWeight: 700, color: "#52B788", marginRight: 8 }}>{blockLabel}</span>
        )}
        <span style={{ fontSize: 12, color: "#D8F3DC" }}>Opacity</span>
        <input
          type="range"
          min={0}
          max={100}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          style={{ width: 120 }}
        />
        <span style={{ fontSize: 12, color: "#D8F3DC" }}>{opacity}%</span>

        <span style={{ fontSize: 12, color: "#D8F3DC", marginLeft: 12 }}>Scale</span>
        <input
          type="range"
          min={50}
          max={200}
          value={Math.round(scale * 100)}
          onChange={(e) => setScale(Number(e.target.value) / 100)}
          style={{ width: 120 }}
        />
        <span style={{ fontSize: 12, color: "#D8F3DC" }}>{Math.round(scale * 100)}%</span>

        <span style={{ fontSize: 12, color: "#D8F3DC", marginLeft: 12 }}>View</span>
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
        <span style={{ fontSize: 12, color: "#D8F3DC" }}>{Math.round(viewZoom * 100)}%</span>

        <button onClick={() => { setOffsetX(0); setOffsetY(0); setScale(1); setViewZoom(1); setBoxScaleX(1); setBoxScaleY(1); }} style={toolBtn(false)}>Reset</button>
        {canEdit && (
        <>
        <label style={{ fontSize: 12, color: "#D8F3DC", marginLeft: 6 }}>Replace mask</label>
        <input
          type="file"
          accept=".png,.jpg,.jpeg,.webp"
          onChange={onUploadAlignedMask}
          style={{ width: 220 }}
        />
        </>
        )}
        <button onClick={onRefresh} style={toolBtn(false)}>Refresh</button>
        {canEdit && (
        <button onClick={continueWithAdjustedMask} style={toolBtn(true)} disabled={isContinuing}>
          {isContinuing ? "Continuing..." : "Continue Pipeline"}
        </button>
        )}
      </div>

      {canEdit && (
        <div
          style={{
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(9, 24, 14, 0.68)",
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: "#B7E4C7" }}>Mask Generation Instruction</div>
          <textarea
            value={generationInstruction}
            onChange={(e) => setGenerationInstruction(e.target.value)}
            placeholder="Optional: add instruction for retry generation (e.g. keep all internal walls and beams fully solid red)."
            rows={2}
            style={{
              width: "100%",
              resize: "vertical",
              minHeight: 56,
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(2, 10, 5, 0.75)",
              color: "#D8F3DC",
              padding: "8px 10px",
              fontSize: 12,
              outline: "none",
            }}
          />
          <div style={{ fontSize: 11, color: "#95D5B2" }}>
            Use this when auto-generated mask misses walls/doors or wrongly fills spaces, then click Retry Generation.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={retryGeneration} style={{ ...toolBtn(false), flex: "0 0 auto", width: 170 }} disabled={isRetrying}>
              {isRetrying ? "Retrying..." : "Retry Generation"}
            </button>
          </div>
        </div>
      )}

      <div
        ref={viewportRef}
        style={{
          position:"relative",
          flex: 1,
          overflow: "auto",
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.14)",
          background: "rgba(4, 18, 10, 0.48)",
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
                  border: "2px dashed rgba(82, 183, 136, 0.8)",
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
                  background: isResizing ? "#52B788" : "#40916C",
                  cursor: "nwse-resize",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
                }}
                title="Resize mask box"
              />

              <div
                onMouseDown={(e) => startResize(e, "n")}
                style={{ position: "absolute", left: "50%", top: -6, transform: "translateX(-50%)", width: 12, height: 12, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#40916C", cursor: "ns-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize top"
              />
              <div
                onMouseDown={(e) => startResize(e, "s")}
                style={{ position: "absolute", left: "50%", bottom: -6, transform: "translateX(-50%)", width: 12, height: 12, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#40916C", cursor: "ns-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize bottom"
              />
              <div
                onMouseDown={(e) => startResize(e, "e")}
                style={{ position: "absolute", right: -6, top: "50%", transform: "translateY(-50%)", width: 12, height: 12, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#40916C", cursor: "ew-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize right"
              />
              <div
                onMouseDown={(e) => startResize(e, "w")}
                style={{ position: "absolute", left: -6, top: "50%", transform: "translateY(-50%)", width: 12, height: 12, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#40916C", cursor: "ew-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize left"
              />
              <div
                onMouseDown={(e) => startResize(e, "nw")}
                style={{ position: "absolute", left: -7, top: -7, width: 14, height: 14, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#40916C", cursor: "nwse-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize top-left"
              />
              <div
                onMouseDown={(e) => startResize(e, "ne")}
                style={{ position: "absolute", right: -7, top: -7, width: 14, height: 14, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#40916C", cursor: "nesw-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
                title="Resize top-right"
              />
              <div
                onMouseDown={(e) => startResize(e, "sw")}
                style={{ position: "absolute", left: -7, bottom: -7, width: 14, height: 14, borderRadius: 3, border: "1px solid rgba(255,255,255,0.92)", background: "#40916C", cursor: "nesw-resize", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }}
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
    border: primary ? "none" : "1px solid #E8EAED",
    background: primary ? "#2D6A4F" : "#FFFFFF",
    color: primary ? "#FFFFFF" : "#1A1A2E",
    cursor:"pointer",
    flex: 1,
    textAlign:"center",
    fontWeight: 600,
    boxShadow: primary ? "0 4px 12px rgba(45, 106, 79, 0.3)" : undefined,
  };
}

// ─── Room Editor Component ──────────────────────────────────────────────────

type Room = {
  id: string;
  label?: string;
  label_text?: string;
  label_texts?: string[];
  area_px: number;
  polygon_px: number[][];
  polygon_world: number[][];
};

type NBCEquipmentItem = {
  key: string;
  label: string;
  required: boolean;
  supported: boolean;
  notes: string[];
};

/* ── Wrapper: loads floor-plan mapping then renders RoomEditor ── */
function FloorPlanRoomEditor({
  renderUrl, mappingUrl, projectId, floorPlanId, nbcEquipment, onSave, onContinue, displayUnit, worldToM, canEdit = true,
}: {
  renderUrl: string;
  mappingUrl: string;
  projectId: string;
  floorPlanId: string;
  nbcEquipment: NBCEquipmentItem[];
  onSave: (rooms: Room[]) => Promise<void>;
  onContinue: (rooms: Room[]) => Promise<void>;
  displayUnit: string;
  worldToM: number;
  canEdit?: boolean;
}) {
  const [fpMapping, setFpMapping] = useState<Mapping | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const m: Mapping = await (await trackedFetch(mappingUrl, { cache: "no-store" })).json();
        setFpMapping(m);
      } catch { setFpMapping(null); }
    })();
  }, [mappingUrl]);
  if (!fpMapping) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>Loading mapping...</div>;
  return (
    <RoomEditor
      renderUrl={renderUrl}
      mapping={fpMapping}
      projectId={projectId}
      floorPlanId={floorPlanId}
      nbcEquipment={nbcEquipment}
      onSave={onSave}
      onContinue={onContinue}
      displayUnit={displayUnit}
      worldToM={worldToM}
      canEdit={canEdit}
    />
  );
}

/* ── Wrapper: loads floor-plan mapping + detectors then renders Editor ── */
function FloorPlanEditor({
  renderUrl, mappingUrl, projectId, floorPlanId, floorPlan, isReady, exportDxfUrl, exportPngUrl, onSave, onChanged, worldToM, canEdit = true,
}: {
  renderUrl: string;
  mappingUrl: string;
  projectId: string;
  floorPlanId: string;
  floorPlan: FloorPlan;
  isReady: boolean;
  exportDxfUrl: string | null;
  exportPngUrl: string | null;
  onSave: () => void;
  onChanged: () => void;
  worldToM: number;
  canEdit?: boolean;
}) {
  const [fpMapping, setFpMapping] = useState<Mapping | null>(null);
  const [fpDetectors, setFpDetectors] = useState<Detector[]>([]);
  const [fpPipesData, setFpPipesData] = useState<PipesData | null>(null);

  async function loadData() {
    try {
      const m: Mapping = await (await trackedFetch(mappingUrl, { cache: "no-store" })).json();
      setFpMapping(m);
    } catch { setFpMapping(null); }
    try {
      const dets: Detector[] = await (await authFetch(`/api/projects/${projectId}/detectors?floor_plan_id=${floorPlanId}`)).json();
      setFpDetectors(dets);
    } catch { setFpDetectors([]); }
    // Load per-floor-plan sprinkler pipes
    if (floorPlan.files?.sprinkler_pipes) {
      try {
        const pd: PipesData = await (await trackedFetch(apiUrl(floorPlan.files.sprinkler_pipes), { cache: "no-store" })).json();
        setFpPipesData(pd);
      } catch { setFpPipesData(null); }
    } else {
      setFpPipesData(null);
    }
  }

  useEffect(() => { loadData(); }, [mappingUrl, floorPlanId]);

  if (!fpMapping) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>Loading mapping...</div>;
  return (
    <Editor
      renderUrl={renderUrl}
      mapping={fpMapping}
      detectors={fpDetectors}
      projectId={projectId}
      isReady={isReady}
      pipesData={fpPipesData}
      floorPlanId={floorPlanId}
      exportDxfUrl={exportDxfUrl}
      exportPngUrl={exportPngUrl}
      onSave={onSave}
      onChanged={() => { loadData(); onChanged(); }}
      worldToM={worldToM}
      canEdit={canEdit}
    />
  );
}

function RoomEditor({
  renderUrl,
  mapping,
  projectId,
  nbcEquipment,
  floorPlanId,
  onSave,
  onContinue,
  displayUnit,
  worldToM,
  canEdit = true,
}: {
  renderUrl: string;
  mapping: Mapping;
  projectId: string;
  nbcEquipment: NBCEquipmentItem[];
  floorPlanId?: string | null;
  onSave: (rooms: Room[]) => Promise<void>;
  onContinue: (rooms: Room[]) => Promise<void>;
  displayUnit: string;
  worldToM: number;
  canEdit?: boolean;
}) {
  // ── Room state ──
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [isSavingRooms, setIsSavingRooms] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const [splitMode, setSplitMode] = useState(false);
  const [splitStart, setSplitStart] = useState<{px:number; py:number} | null>(null);
  const [splitEnd, setSplitEnd] = useState<{px:number; py:number} | null>(null);
  const [splitHover, setSplitHover] = useState<{px:number; py:number} | null>(null);

  // ── Detector state ──
  const [detectors, setDetectors] = useState<Detector[]>([]);
  const [editorMode, setEditorMode] = useState<"rooms" | "select" | "add" | "erase" | "pan" | "pipe_draw" | "pipe_select" | "measure" | "shape_rect" | "shape_circle" | "shape_cloud" | "shape_select" | "text_add">("select");
  const [addType, setAddType] = useState<ObjectType>("smoke");
  const [selectedDetectorIds, setSelectedDetectorIds] = useState<string[]>([]);
  const [imgDims, setImgDims] = useState<{w:number; h:number} | null>(null);
  const [transformState, setTransformState] = useState({ scale: 0.18, positionX: 0, positionY: 0 });
  const [hoverPoint, setHoverPoint] = useState<{px:number; py:number} | null>(null);
  const [marquee, setMarquee] = useState<{sx:number; sy:number; ex:number; ey:number} | null>(null);
  // ── Pipe editing state ──
  const [selectedPipeIdx, setSelectedPipeIdx] = useState<number | null>(null);
  const [pipeDrawStart, setPipeDrawStart] = useState<{px:number; py:number} | null>(null);
  const [pipeDrawEnd, setPipeDrawEnd] = useState<{px:number; py:number} | null>(null);
  const [pipeJoinHover, setPipeJoinHover] = useState<{px:number; py:number} | null>(null);
  const [drawPipeDiameter, setDrawPipeDiameter] = useState<string>("25mm");
  const [groupDrag, setGroupDrag] = useState<{
    ids: string[];
    start: { px: number; py: number };
    origins: Record<string, { px: number; py: number }>;
  } | null>(null);
  const [groupPreview, setGroupPreview] = useState<Record<string, { px: number; py: number }> | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<{ vertical: number[]; horizontal: number[] }>({ vertical: [], horizontal: [] });
  const [isAutoPlacing, setIsAutoPlacing] = useState<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<"rooms" | "equipment">("equipment");
  const [pipesData, setPipesData] = useState<PipesData | null>(null);
  const [isSavingChanges, setIsSavingChanges] = useState(false);
  const [isExportingDxf, setIsExportingDxf] = useState(false);
  const [measureStart, setMeasureStart] = useState<{px:number; py:number} | null>(null);
  const [measureEnd, setMeasureEnd] = useState<{px:number; py:number} | null>(null);
  const [measureLocked, setMeasureLocked] = useState(false);
  const [shapes, setShapes] = useState<ShapeAnnotation[]>([]);
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [shapeDraft, setShapeDraft] = useState<{ kind: "rect" | "circle" | "cloud"; start: { px: number; py: number }; end: { px: number; py: number } } | null>(null);
  const [shapeDrag, setShapeDrag] = useState<{ id: string; start: { px: number; py: number }; origin: ShapeAnnotation } | null>(null);
  const [shapeResize, setShapeResize] = useState<{ id: string; handle: ShapeResizeHandle; start: { px: number; py: number }; origin: ShapeAnnotation } | null>(null);

  // ── Helpers ──
  function samePoint(a: {px:number; py:number}, b: {px:number; py:number}, tolerance = 0.5) {
    return Math.hypot(a.px - b.px, a.py - b.py) <= tolerance;
  }

  function resetSplitState() {
    setSplitStart(null);
    setSplitEnd(null);
    setSplitHover(null);
  }

  function onImageLoad(e: any) {
    const img = e.target as HTMLImageElement;
    setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
  }

  function toImagePoint(e: any): { px: number; py: number } | null {
    if (!imgDims) return null;
    const rect = (e.currentTarget as any).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * imgDims.w;
    const py = ((e.clientY - rect.top) / rect.height) * imgDims.h;
    return { px, py };
  }

  function normalizeShapeRect(a: { px: number; py: number }, b: { px: number; py: number }) {
    return {
      x: Math.min(a.px, b.px),
      y: Math.min(a.py, b.py),
      w: Math.abs(b.px - a.px),
      h: Math.abs(b.py - a.py),
    };
  }

  function circleRectFromPoints(a: { px: number; py: number }, b: { px: number; py: number }) {
    const dx = b.px - a.px;
    const dy = b.py - a.py;
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const end = { px: a.px + Math.sign(dx || 1) * side, py: a.py + Math.sign(dy || 1) * side };
    return normalizeShapeRect(a, end);
  }

  function shapeRect(shape: ShapeAnnotation) {
    return {
      left: shape.x,
      top: shape.y,
      right: shape.x + shape.w,
      bottom: shape.y + shape.h,
    };
  }

  function findShapeAtPoint(point: { px: number; py: number }): string | null {
    const pad = 6;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      const r = shapeRect(s);
      if (s.kind === "circle") {
        const cx = s.x + s.w * 0.5;
        const cy = s.y + s.h * 0.5;
        const rx = Math.max(1, s.w * 0.5);
        const ry = Math.max(1, s.h * 0.5);
        const nx = (point.px - cx) / rx;
        const ny = (point.py - cy) / ry;
        if (nx * nx + ny * ny <= 1.08) return s.id;
      } else if (
        point.px >= r.left - pad &&
        point.px <= r.right + pad &&
        point.py >= r.top - pad &&
        point.py <= r.bottom + pad
      ) {
        return s.id;
      }
    }
    return null;
  }

  function hitShapeResizeHandle(shape: ShapeAnnotation, point: { px: number; py: number }, radius = 8): ShapeResizeHandle | null {
    const r = shapeRect(shape);
    const handles: Array<[ShapeResizeHandle, { px: number; py: number }]> = [
      ["nw", { px: r.left, py: r.top }],
      ["ne", { px: r.right, py: r.top }],
      ["sw", { px: r.left, py: r.bottom }],
      ["se", { px: r.right, py: r.bottom }],
    ];
    for (const [name, h] of handles) {
      if (Math.hypot(point.px - h.px, point.py - h.py) <= radius) return name;
    }
    return null;
  }

  function shapeDimensionLabel(shape: { kind: "rect" | "circle" | "cloud"; x: number; y: number; w: number; h: number }) {
    const p0 = pixelToWorld(mapping, shape.x, shape.y);
    const px = pixelToWorld(mapping, shape.x + shape.w, shape.y);
    const py = pixelToWorld(mapping, shape.x, shape.y + shape.h);
    const wMeters = Math.abs(px.x - p0.x) * worldToM;
    const hMeters = Math.abs(py.y - p0.y) * worldToM;
    if (shape.kind === "circle") {
      const dMeters = Math.max(wMeters, hMeters);
      return `D ${dMeters.toFixed(2)} m`;
    }
    return `${wMeters.toFixed(2)} m x ${hMeters.toFixed(2)} m`;
  }

  function editSelectedText() {
    if (!selectedShapeId || !canEdit) return;
    const current = shapes.find(s => s.id === selectedShapeId);
    if (!current || current.kind !== "text") return;
    const next = window.prompt("Edit text:", current.text || "")?.trim();
    if (!next) return;
    setShapes(prev => prev.map(s => {
      if (s.id !== current.id) return s;
      const font = s.fontSize || 16;
      return { ...s, text: next, w: Math.max(44, next.length * Math.max(7, font * 0.58) + 10), h: Math.max(font + 8, s.h) };
    }));
  }

  function changeSelectedTextSize(delta: number) {
    if (!selectedShapeId || !canEdit) return;
    setShapes(prev => prev.map(s => {
      if (s.id !== selectedShapeId || s.kind !== "text") return s;
      const nextFont = Math.max(10, Math.min(72, (s.fontSize || 16) + delta));
      const textLen = (s.text || "Text").length;
      return { ...s, fontSize: nextFont, h: nextFont + 8, w: Math.max(44, textLen * Math.max(7, nextFont * 0.58) + 10) };
    }));
  }

  function cloudPathFromRect(x: number, y: number, w: number, h: number) {
    const shortSide = Math.max(1, Math.min(w, h));
    const bump = Math.max(5, Math.min(16, shortSide * 0.14));
    const nx = Math.max(3, Math.round(w / Math.max(16, bump * 2.2)));
    const ny = Math.max(3, Math.round(h / Math.max(16, bump * 2.2)));

    let d = `M ${x} ${y}`;

    // Top edge (outward -Y)
    for (let i = 0; i < nx; i++) {
      const x0 = x + (i / nx) * w;
      const x1 = x + ((i + 1) / nx) * w;
      const xm = (x0 + x1) * 0.5;
      d += ` Q ${xm} ${y - bump} ${x1} ${y}`;
    }

    // Right edge (outward +X)
    for (let i = 0; i < ny; i++) {
      const y0 = y + (i / ny) * h;
      const y1 = y + ((i + 1) / ny) * h;
      const ym = (y0 + y1) * 0.5;
      d += ` Q ${x + w + bump} ${ym} ${x + w} ${y1}`;
    }

    // Bottom edge (outward +Y)
    for (let i = 0; i < nx; i++) {
      const x0 = x + w - (i / nx) * w;
      const x1 = x + w - ((i + 1) / nx) * w;
      const xm = (x0 + x1) * 0.5;
      d += ` Q ${xm} ${y + h + bump} ${x1} ${y + h}`;
    }

    // Left edge (outward -X)
    for (let i = 0; i < ny; i++) {
      const y0 = y + h - (i / ny) * h;
      const y1 = y + h - ((i + 1) / ny) * h;
      const ym = (y0 + y1) * 0.5;
      d += ` Q ${x - bump} ${ym} ${x} ${y1}`;
    }

    return `${d} Z`;
  }

  function closestPointOnSegment(point: {px:number; py:number}, a: number[], b: number[]) {
    const abx = b[0] - a[0]; const aby = b[1] - a[1];
    const apx = point.px - a[0]; const apy = point.py - a[1];
    const abLen2 = abx * abx + aby * aby;
    if (abLen2 <= 1e-9) return { px: a[0], py: a[1] };
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLen2));
    return { px: a[0] + t * abx, py: a[1] + t * aby };
  }

  function snapPointToRoomBoundary(room: Room, point: {px:number; py:number}, maxDistPx = 14): {px:number; py:number} | null {
    const pts = room.polygon_px;
    const n = pts.length;
    if (n < 2) return null;
    let best: {px:number; py:number} | null = null;
    let bestD2 = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const a = pts[i]; const b = pts[(i + 1) % n];
      const hit = closestPointOnSegment(point, a, b);
      const dx = hit.px - point.px; const dy = hit.py - point.py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = hit; }
    }
    if (!best || bestD2 > maxDistPx * maxDistPx) return null;
    return best;
  }

  // ── Load rooms ──
  useEffect(() => {
    (async () => {
      try {
        const url = floorPlanId
          ? `/api/projects/${projectId}/floor_plans/${floorPlanId}/rooms`
          : `/api/projects/${projectId}/rooms`;
        const res = await authFetch(url);
        const data = await res.json();
        const raw: Room[] = data.rooms || data;
        const rawShapes: any[] = Array.isArray(data?.shapes) ? data.shapes : [];
        setRooms(
          raw.map((r, i) => ({
            ...r,
            label: (r.label && r.label.trim()) || (r.label_text && r.label_text.trim()) || `Room ${i + 1}`,
          }))
        );
        setShapes(
          rawShapes
            .filter((s) => s && typeof s === "object")
            .map((s) => ({
              id: String(s.id || crypto.randomUUID()),
              kind: (s.kind === "rect" || s.kind === "circle" || s.kind === "cloud" || s.kind === "text") ? s.kind : "rect",
              x: Number(s.x) || 0,
              y: Number(s.y) || 0,
              w: Math.max(1, Number(s.w) || 1),
              h: Math.max(1, Number(s.h) || 1),
              text: typeof s.text === "string" ? s.text : undefined,
              fontSize: Number.isFinite(Number(s.fontSize)) ? Number(s.fontSize) : undefined,
            }))
        );
      } catch (e) { console.error("Failed to load rooms", e); }
      finally { setLoading(false); }
    })();
  }, [projectId, floorPlanId]);

  // ── Load detectors ──
  async function loadDetectors() {
    try {
      const qs = floorPlanId ? `?floor_plan_id=${floorPlanId}` : "";
      const res = await authFetch(`/api/projects/${projectId}/detectors${qs}`);
      const data: Detector[] = await res.json();
      setDetectors(data);
    } catch (e) { console.error("Failed to load detectors", e); }
  }

  useEffect(() => { loadDetectors(); }, [projectId, floorPlanId]);
  useEffect(() => { loadPipesData(); }, [projectId, floorPlanId]);

  // ── Keyboard shortcuts for pipe editing & bulk delete ──
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Delete" || e.key === "Backspace") {
        if ((editorMode === "pipe_select" || editorMode === "pipe_draw") && selectedPipeIdx !== null) {
          deletePipe(selectedPipeIdx);
        } else if (editorMode === "shape_select" && selectedShapeId && canEdit) {
          setShapes(prev => prev.filter(s => s.id !== selectedShapeId));
          setSelectedShapeId(null);
        } else if (selectedDetectorIds.length > 0 && canEdit) {
          deleteDetectorsMany(selectedDetectorIds);
        }
      }
      if (e.key === "Escape") {
        if (pipeDrawStart) { setPipeDrawStart(null); setPipeDrawEnd(null); setPipeJoinHover(null); }
        if (shapeDraft) setShapeDraft(null);
        if (shapeDrag) setShapeDrag(null);
        if (shapeResize) setShapeResize(null);
        if (selectedShapeId) setSelectedShapeId(null);
        if (selectedPipeIdx !== null) setSelectedPipeIdx(null);
        if (selectedDetectorIds.length > 0) setSelectedDetectorIds([]);
        if (measureStart || measureEnd) {
          setMeasureStart(null);
          setMeasureEnd(null);
          setMeasureLocked(false);
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    canEdit,
    editorMode,
    measureEnd,
    measureLocked,
    measureStart,
    pipeDrawStart,
    selectedDetectorIds,
    selectedPipeIdx,
    selectedShapeId,
    shapeDraft,
    shapeDrag,
    shapeResize,
  ]);

  // ── Room functions ──
  function roomCentroidPx(room: Room): { cx: number; cy: number } {
    const pts = room.polygon_px;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return { cx, cy };
  }

  function handleRenameStart(room: Room) {
    setEditingLabelId(room.id);
    setLabelDraft(room.label || "");
  }

  function handleRenameCommit(roomId: string) {
    setRooms(prev => prev.map(r => r.id === roomId ? { ...r, label: labelDraft.trim() || r.label } : r));
    setEditingLabelId(null);
  }

  function handleDeleteRoom(roomId: string) {
    setRooms(prev => prev.filter(r => r.id !== roomId));
    if (selectedId === roomId) setSelectedId(null);
  }

  function handleSplitDotClick(point: {px:number; py:number}) {
    if (!splitMode || !selectedId) return;
    if (!splitStart) { setSplitStart(point); setSplitEnd(null); return; }
    if (samePoint(splitStart, point)) return;
    setSplitEnd(point);
    const target = rooms.find(r => r.id === selectedId);
    if (!target) return;
    const splitRooms = splitPolygon(target, splitStart, point);
    if (!splitRooms) { setSplitStart(point); setSplitEnd(null); return; }
    setRooms(prev => { const others = prev.filter(r => r.id !== target.id); return [...others, ...splitRooms]; });
    setSelectedId(null); resetSplitState(); setSplitMode(false);
  }

  function splitPolygon(room: Room, p1: {px:number;py:number}, p2: {px:number;py:number}): Room[] | null {
    const pts = room.polygon_px; const n = pts.length;
    const intersections: { idx: number; pt: number[]; ptW: number[] }[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i]; const b = pts[(i + 1) % n];
      const inter = lineSegIntersect(p1.px, p1.py, p2.px, p2.py, a[0], a[1], b[0], b[1]);
      if (inter) {
        const w = pixelToWorld(mapping, inter[0], inter[1]);
        intersections.push({ idx: i, pt: inter, ptW: [w.x, w.y] });
      }
    }
    const uniqueIntersections: { idx: number; pt: number[]; ptW: number[] }[] = [];
    for (const inter of intersections) {
      const exists = uniqueIntersections.some(hit => {
        const dx = hit.pt[0] - inter.pt[0]; const dy = hit.pt[1] - inter.pt[1];
        return dx * dx + dy * dy <= 0.25;
      });
      if (!exists) uniqueIntersections.push(inter);
    }
    if (uniqueIntersections.length < 2) return null;
    let ia: typeof uniqueIntersections[0] | null = null;
    let ib: typeof uniqueIntersections[0] | null = null;
    let bestA = Number.POSITIVE_INFINITY, bestB = Number.POSITIVE_INFINITY;
    for (const inter of uniqueIntersections) {
      const da = (inter.pt[0] - p1.px) ** 2 + (inter.pt[1] - p1.py) ** 2;
      if (da < bestA) { bestA = da; ia = inter; }
    }
    for (const inter of uniqueIntersections) {
      if (ia && inter === ia) continue;
      const db = (inter.pt[0] - p2.px) ** 2 + (inter.pt[1] - p2.py) ** 2;
      if (db < bestB) { bestB = db; ib = inter; }
    }
    if (!ia || !ib) return null;
    const poly1Px: number[][] = []; const poly1W: number[][] = [];
    const poly2Px: number[][] = []; const poly2W: number[][] = [];
    const wPts = room.polygon_world;
    poly1Px.push(ia.pt); poly1W.push(ia.ptW);
    for (let i = (ia.idx + 1) % n; i !== (ib.idx + 1) % n; i = (i + 1) % n) { poly1Px.push(pts[i]); poly1W.push(wPts[i]); }
    poly1Px.push(ib.pt); poly1W.push(ib.ptW);
    poly2Px.push(ib.pt); poly2W.push(ib.ptW);
    for (let i = (ib.idx + 1) % n; i !== (ia.idx + 1) % n; i = (i + 1) % n) { poly2Px.push(pts[i]); poly2W.push(wPts[i]); }
    poly2Px.push(ia.pt); poly2W.push(ia.ptW);
    if (poly1Px.length < 3 || poly2Px.length < 3) return null;
    const area1 = Math.abs(polyArea(poly1Px));
    const area2 = Math.abs(polyArea(poly2Px));
    return [
      { id: room.id + "_a", label: (room.label || "Room") + " A", area_px: area1, polygon_px: poly1Px, polygon_world: poly1W },
      { id: room.id + "_b", label: (room.label || "Room") + " B", area_px: area2, polygon_px: poly2Px, polygon_world: poly2W },
    ];
  }

  function polyArea(pts: number[][]): number {
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
    return a / 2;
  }

  function lineSegIntersect(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): number[] | null {
    const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(d) < 1e-10) return null;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
    if (u >= 0 && u <= 1) return [x3 + u * (x4 - x3), y3 + u * (y4 - y3)];
    return null;
  }

  // ── Detector functions (client-side only, persisted on Save) ──
  function addDetectorAt(px: number, py: number) {
    const w = pixelToWorld(mapping, px, py);
    const newDet: Detector = {
      id: crypto.randomUUID(),
      project_id: projectId,
      x: w.x, y: w.y, z: 0,
      rotation_deg: 0,
      dtype: addType,
      locked: false,
      floor_plan_id: floorPlanId || null,
    };
    setDetectors(prev => [...prev, newDet]);
  }

  function deleteDetector(detId: string) {
    setDetectors(prev => prev.filter(d => d.id !== detId));
  }

  function deleteDetectorsMany(ids: string[]) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setDetectors(prev => prev.filter(d => !idSet.has(d.id)));
    setSelectedDetectorIds(prev => prev.filter(id => !idSet.has(id)));
  }

  function moveDetectorsToMany(nextPxById: Record<string, {px:number; py:number}>) {
    const entries = Object.entries(nextPxById);
    if (!entries.length) return;
    setDetectors(prev => prev.map(d => {
      const pt = nextPxById[d.id];
      if (!pt) return d;
      const w = pixelToWorld(mapping, pt.px, pt.py);
      return { ...d, x: w.x, y: w.y };
    }));
  }

  function rotateDetectorsMany(ids: string[], deltaDeg: number) {
    if (!ids.length || !canEdit) return;
    const idSet = new Set(ids);
    setDetectors(prev => prev.map(d => {
      if (!idSet.has(d.id)) return d;
      return { ...d, rotation_deg: normalizeAngleDeg((d.rotation_deg ?? 0) + deltaDeg) };
    }));
  }

  function hitTestDetector(px: number, py: number): string | null {
    const R2 = 12 * 12;
    for (const d of detectors) {
      const p = worldToPixel(mapping, d.x, d.y);
      const dx = p.px - px; const dy = p.py - py;
      if (dx * dx + dy * dy <= R2) return d.id;
    }
    return null;
  }

  function rectFromPoints(a: {px:number; py:number}, b: {px:number; py:number}) {
    return { left: Math.min(a.px, b.px), right: Math.max(a.px, b.px), top: Math.min(a.py, b.py), bottom: Math.max(a.py, b.py) };
  }

  function idsInRect(rect: {left:number; right:number; top:number; bottom:number}) {
    const ids: string[] = [];
    for (const d of detectors) {
      const p = worldToPixel(mapping, d.x, d.y);
      if (p.px >= rect.left && p.px <= rect.right && p.py >= rect.top && p.py <= rect.bottom) ids.push(d.id);
    }
    return ids;
  }

  function beginGroupDrag(ids: string[], at: {px:number; py:number}) {
    if (!ids.length) return;
    const origins: Record<string, { px: number; py: number }> = {};
    for (const d of detectors) { if (ids.includes(d.id)) origins[d.id] = worldToPixel(mapping, d.x, d.y); }
    setGroupDrag({ ids, start: at, origins });
    setGroupPreview(origins);
    setAlignmentGuides({ vertical: [], horizontal: [] });
  }

  function computeAlignmentGuides(
    moving: Record<string, { px: number; py: number }>,
    movingIds: string[],
    threshold = 6,
  ): { vertical: number[]; horizontal: number[] } {
    const movingEntries = Object.entries(moving);
    if (!movingEntries.length) return { vertical: [], horizontal: [] };
    const movingSet = new Set(movingIds);
    const stationary = detectors
      .filter(d => !movingSet.has(d.id))
      .map(d => ({ id: d.id, ...worldToPixel(mapping, d.x, d.y) }));

    const verticalRaw: number[] = [];
    const horizontalRaw: number[] = [];

    for (const [, mp] of movingEntries) {
      for (const sp of stationary) {
        if (Math.abs(mp.px - sp.px) <= threshold) verticalRaw.push(sp.px);
        if (Math.abs(mp.py - sp.py) <= threshold) horizontalRaw.push(sp.py);
      }
    }

    const dedupe = (vals: number[]) => {
      const sorted = [...vals].sort((a, b) => a - b);
      const out: number[] = [];
      for (const v of sorted) {
        if (out.length === 0 || Math.abs(v - out[out.length - 1]) > 2) out.push(v);
      }
      return out;
    };

    return {
      vertical: dedupe(verticalRaw),
      horizontal: dedupe(horizontalRaw),
    };
  }

  // ── Load sprinkler pipes ──
  async function loadPipesData() {
    try {
      const pipesUrl = floorPlanId
        ? `/api/projects/${projectId}/floor_plans/${floorPlanId}/sprinkler_pipes`
        : `/api/projects/${projectId}/sprinkler_pipes`;
      const res = await authFetch(pipesUrl);
      if (res.ok) {
        const pd: PipesData = await res.json();
        setPipesData(pd);
      } else {
        setPipesData(null);
      }
    } catch { setPipesData(null); }
  }

  // ── NBC Auto-place ──
  async function autoPlaceEquipment(equipmentType: string) {
    setIsAutoPlacing(equipmentType);
    try {
      // Save rooms to backend first so auto-place can use them
      await onSave(rooms);
      const url = floorPlanId
        ? `/api/projects/${projectId}/floor_plans/${floorPlanId}/auto_place`
        : `/api/projects/${projectId}/auto_place`;
      const res = await authFetch(url, {
        method: "POST",
        body: JSON.stringify({ equipment_type: equipmentType }),
      });
      const placed: Detector[] = await res.json();

      if (equipmentType === "mcp_hooter") {
        setDetectors(prev => [
          ...prev.filter(d => d.dtype !== "mcb" && d.dtype !== "hooter"),
          ...placed.filter(d => d.dtype === "mcb" || d.dtype === "hooter"),
        ]);
      } else {
        // Merge: keep detectors of other types, replace this type with placed result
        setDetectors(prev => [
          ...prev.filter(d => d.dtype !== equipmentType),
          ...placed.filter(d => d.dtype === equipmentType),
        ]);
      }
    } catch (e) { console.error("Auto-place failed", e); }
    finally { setIsAutoPlacing(null); }
  }

  const [isConnectingPipes, setIsConnectingPipes] = useState(false);
  const [detectedSources, setDetectedSources] = useState<{x:number; y:number}[]>([]);
  const [sourceSelectMode, setSourceSelectMode] = useState(false);
  const [chosenSource, setChosenSource] = useState<{x:number; y:number} | null>(null);
  const [isDetectingSources, setIsDetectingSources] = useState(false);

  /** Step 1: detect sources, show them, and enter source-selection mode. */
  async function startConnectPipes() {
    setIsDetectingSources(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/detect_sources`);
      const srcs: {x:number; y:number}[] = res.ok ? await res.json() : [];
      setDetectedSources(srcs);
      setChosenSource(null);
      setSourceSelectMode(true);
      // If exactly one source detected, pre-select it
      if (srcs.length === 1) setChosenSource(srcs[0]);
    } catch (e) { console.error("Detect sources failed", e); }
    finally { setIsDetectingSources(false); }
  }

  /** Step 2: route pipes with the chosen source (or auto if none). */
  async function connectPipes(source?: {x:number; y:number} | null) {
    setIsConnectingPipes(true);
    setSourceSelectMode(false);
    try {
      const url = floorPlanId
        ? `/api/projects/${projectId}/floor_plans/${floorPlanId}/route_pipes`
        : `/api/projects/${projectId}/route_pipes`;
      const body = source ? { source: { x: source.x, y: source.y } } : undefined;
      const res = await authFetch(url, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) {
        const pd: PipesData = await res.json();
        setPipesData(pd);
      }
    } catch (e) { console.error("Connect pipes failed", e); }
    finally {
      setIsConnectingPipes(false);
      setDetectedSources([]);
      setChosenSource(null);
    }
  }

  // ── Pipe editing helpers ──
  function hitTestPipe(px: number, py: number): number | null {
    if (!pipesData?.pipes) return null;
    const threshold = 8;
    for (let i = 0; i < pipesData.pipes.length; i++) {
      const pipe = pipesData.pipes[i];
      const p1 = worldToPixel(mapping, pipe.from[0], pipe.from[1]);
      const p2 = worldToPixel(mapping, pipe.to[0], pipe.to[1]);
      const dx = p2.px - p1.px, dy = p2.py - p1.py;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1) continue;
      const t = Math.max(0, Math.min(1, ((px - p1.px) * dx + (py - p1.py) * dy) / len2));
      const cx = p1.px + t * dx, cy = p1.py + t * dy;
      if (Math.hypot(px - cx, py - cy) <= threshold) return i;
    }
    return null;
  }

  function closestPointOnPipe(px: number, py: number, threshold = 10): { px: number; py: number; idx: number } | null {
    if (!pipesData?.pipes?.length) return null;
    let best: { px: number; py: number; idx: number } | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pipesData.pipes.length; i++) {
      const pipe = pipesData.pipes[i];
      const p1 = worldToPixel(mapping, pipe.from[0], pipe.from[1]);
      const p2 = worldToPixel(mapping, pipe.to[0], pipe.to[1]);
      const dx = p2.px - p1.px;
      const dy = p2.py - p1.py;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((px - p1.px) * dx + (py - p1.py) * dy) / len2));
      const cx = p1.px + t * dx;
      const cy = p1.py + t * dy;
      const dist = Math.hypot(px - cx, py - cy);
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist;
        best = { px: cx, py: cy, idx: i };
      }
    }
    return best;
  }

  function resolvePipeDrawEnd(
    start: { px: number; py: number },
    end: { px: number; py: number },
    axisSnapThresholdPx = 6,
  ): { end: { px: number; py: number }; axis: "horizontal" | "vertical" | null } {
    const dx = end.px - start.px;
    const dy = end.py - start.py;
    if (Math.abs(dx) <= axisSnapThresholdPx) {
      return { end: { px: start.px, py: end.py }, axis: "vertical" };
    }
    if (Math.abs(dy) <= axisSnapThresholdPx) {
      return { end: { px: end.px, py: start.py }, axis: "horizontal" };
    }
    return { end, axis: null };
  }

  function deletePipe(idx: number) {
    if (!pipesData) return;
    const newPipes = pipesData.pipes.filter((_, i) => i !== idx);
    setPipesData({ ...pipesData, pipes: newPipes });
    setSelectedPipeIdx(null);
  }

  function addPipe(fromPx: {px:number; py:number}, toPx: {px:number; py:number}) {
    const wFrom = pixelToWorld(mapping, fromPx.px, fromPx.py);
    const wTo = pixelToWorld(mapping, toPx.px, toPx.py);
    const newSeg: PipeSegment = {
      from: [wFrom.x, wFrom.y],
      to: [wTo.x, wTo.y],
      diameter: drawPipeDiameter,
    };
    const prev = pipesData || { pipes: [], sources: [] };
    setPipesData({ ...prev, pipes: [...prev.pipes, newSeg] });
  }

  function clearPipes() {
    setPipesData(null);
    setSelectedPipeIdx(null);
    setPipeDrawStart(null);
    setPipeDrawEnd(null);
    setPipeJoinHover(null);
  }

  function setSelectedPipeDiameter(diameter: string) {
    if (!pipesData || selectedPipeIdx === null) return;
    setPipesData(prev => {
      if (!prev || selectedPipeIdx === null) return prev;
      const pipes = [...prev.pipes];
      const current = pipes[selectedPipeIdx];
      if (!current) return prev;
      pipes[selectedPipeIdx] = {
        ...current,
        diameter,
      };
      return { ...prev, pipes };
    });
  }

  async function savePipesData() {
    if (!pipesData) return;
    try {
      const url = floorPlanId
        ? `/api/projects/${projectId}/floor_plans/${floorPlanId}/sprinkler_pipes`
        : `/api/projects/${projectId}/sprinkler_pipes`;
      await authFetch(url, { method: "PUT", body: JSON.stringify(pipesData) });
    } catch (e) { console.error("Save pipes failed", e); }
  }

  function clearEquipmentType(equipmentType: string) {
    if (equipmentType === "mcp_hooter") {
      setDetectors(prev => prev.filter(d => d.dtype !== "mcb" && d.dtype !== "hooter"));
      return;
    }
    setDetectors(prev => prev.filter(d => d.dtype !== equipmentType));
    if (equipmentType === "sprinkler") {
      setPipesData(null);
    }
  }

  async function saveAllEdits() {
    const payload: any = {
      rooms,
      shapes,
      detectors: detectors.map(d => ({
        id: d.id, x: d.x, y: d.y, z: d.z,
        rotation_deg: d.rotation_deg ?? 0,
        dtype: d.dtype, locked: d.locked,
        floor_plan_id: d.floor_plan_id,
      })),
      pipes: pipesData || undefined,
      floor_plan_id: floorPlanId || undefined,
    };
    const res = await authFetch(`/api/projects/${projectId}/bulk_save`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.detectors) setDetectors(data.detectors);
    }
  }

  async function handleSaveChanges() {
    setIsSavingChanges(true);
    try {
      await saveAllEdits();
    } catch (e) { console.error("Save changes failed", e); }
    finally { setIsSavingChanges(false); }
  }

  async function downloadFresh(url: string, filename: string) {
    const targetUrl = /^https?:\/\//i.test(url) ? url : apiUrl(url);
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetch(`${targetUrl}${sep}ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `project_${projectId}_${Date.now()}.dxf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async function handleExportDxf() {
    setIsExportingDxf(true);
    try {
      await saveAllEdits();
      const saveResp = await authFetch(`/api/projects/${projectId}/save`, { method: "POST" });
      const saved = await saveResp.json();
      const outPath = saved?.files?.output_dxf;
      if (!outPath) return;
      await downloadFresh(outPath, `project_${projectId}_${Date.now()}.dxf`);
    } catch (e) {
      console.error("Export DXF failed", e);
    } finally {
      setIsExportingDxf(false);
    }
  }

  // ── Save & Continue ──
  async function handleContinue() {
    setIsContinuing(true);
    try {
      // Save all user state (rooms + detectors + pipes) before finalizing
      const payload: any = {
        rooms,
        shapes,
        detectors: detectors.map(d => ({
          id: d.id, x: d.x, y: d.y, z: d.z,
          rotation_deg: d.rotation_deg ?? 0,
          dtype: d.dtype, locked: d.locked,
          floor_plan_id: d.floor_plan_id,
        })),
        pipes: pipesData || undefined,
        floor_plan_id: floorPlanId || undefined,
      };
      await authFetch(`/api/projects/${projectId}/bulk_save`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      await onContinue(rooms);
    } finally { setIsContinuing(false); }
  }

  async function handleSaveRooms() {
    setIsSavingRooms(true);
    try { await onSave(rooms); } finally { setIsSavingRooms(false); }
  }

  // ── SVG event handlers for room split in "rooms" mode ──
  function handleSvgSplitClick(e: React.MouseEvent<SVGSVGElement>) {
    if (editorMode !== "rooms" || !splitMode || !selectedRoom) return;
    const point = toImagePoint(e);
    if (!point) return;
    const snapped = snapPointToRoomBoundary(selectedRoom, point);
    if (!snapped) return;
    handleSplitDotClick(snapped);
  }

  function handleSvgSplitMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (editorMode !== "rooms" || !splitMode || !selectedRoom) { if (splitHover) setSplitHover(null); return; }
    const point = toImagePoint(e);
    if (!point) { if (splitHover) setSplitHover(null); return; }
    const snapped = snapPointToRoomBoundary(selectedRoom, point);
    setSplitHover(snapped);
  }

  // ── Loading state ──
  if (loading) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center", color: "#6B7280" }}>
        <p>Loading rooms...</p>
      </div>
    );
  }

  const selectedRoom = rooms.find(r => r.id === selectedId);
  const selectedShape = selectedShapeId ? shapes.find(s => s.id === selectedShapeId) || null : null;
  const selectedPipeDiameter = selectedPipeIdx !== null && pipesData?.pipes?.[selectedPipeIdx]
    ? pipesData.pipes[selectedPipeIdx].diameter
    : null;
  const splitPreviewEnd = splitEnd || splitHover;
  const isPanning = editorMode === "pan";

  function canvasCursor() {
    if (editorMode === "pan") return "grab";
    if (editorMode === "add") return "crosshair";
    if (editorMode === "erase") return "not-allowed";
    if (editorMode === "measure") return "crosshair";
    if (editorMode === "shape_rect" || editorMode === "shape_circle" || editorMode === "shape_cloud" || editorMode === "text_add") return "crosshair";
    if (editorMode === "shape_select") return shapeResize ? "nwse-resize" : "pointer";
    if (editorMode === "rooms" && splitMode) return "crosshair";
    if (editorMode === "pipe_draw") return "crosshair";
    if (editorMode === "pipe_select") return "pointer";
    if (groupDrag) return "grabbing";
    return "default";
  }

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Canvas area ── */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", background: "#F7F8FA" }}>
        <TransformWrapper
          minScale={0.02}
          maxScale={24}
          initialScale={0.18}
          centerOnInit
          limitToBounds={false}
          panning={{ disabled: !isPanning }}
          wheel={{ step: 0.08 }}
          doubleClick={{ disabled: true }}
          onTransformed={(_ref: unknown, state: any) => {
            setTransformState({
              scale: typeof state?.scale === "number" ? state.scale : 0.18,
              positionX: typeof state?.positionX === "number" ? state.positionX : 0,
              positionY: typeof state?.positionY === "number" ? state.positionY : 0,
            });
          }}
        >
          {({ zoomIn, zoomOut, resetTransform, setTransform }) => (
            <>
              {/* ── Toolbar ── */}
              <div style={{
                position: "absolute", top: 10, left: 10, right: 10, zIndex: 3,
                display: "flex", flexDirection: "column", gap: 6,
                pointerEvents: "none",
              }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "6px 10px", borderRadius: 12,
                  background: "#F3F4F6", border: "1px solid #D1D5DB",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                  pointerEvents: "auto",
                }}>
                  {canEdit && (
                    <>
                      <button
                        onClick={handleSaveChanges}
                        disabled={isSavingChanges || isExportingDxf}
                        style={cePaintActionBtn}
                        title="Save changes"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                          <polyline points="17 21 17 13 7 13 7 21"/>
                          <polyline points="7 3 7 8 15 8"/>
                        </svg>
                        {isSavingChanges ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={handleExportDxf}
                        disabled={isSavingChanges || isExportingDxf}
                        style={{ ...cePaintActionBtn, background: "#2D6A4F", color: "#fff", borderColor: "#2D6A4F" }}
                        title="Export DXF"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                          <polyline points="7 10 12 15 17 10"/>
                          <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                        {isExportingDxf ? "Exporting..." : "Export DXF"}
                      </button>
                      <div style={{ width: 1, height: 20, background: "#D1D5DB" }} />
                    </>
                  )}
                  <button onClick={() => { setEditorMode("select"); setSplitMode(false); resetSplitState(); }} style={ceToolBtn(editorMode === "select")}>Select</button>
                  {canEdit && <button onClick={() => { setEditorMode("add"); setSplitMode(false); resetSplitState(); }} style={ceToolBtn(editorMode === "add")}>Add</button>}
                  {canEdit && <button onClick={() => { setEditorMode("erase"); setSplitMode(false); resetSplitState(); }} style={ceToolBtn(editorMode === "erase")}>Erase</button>}
                  <button onClick={() => { setEditorMode("pan"); setSplitMode(false); resetSplitState(); }} style={ceToolBtn(editorMode === "pan")}>Pan</button>
                  <button onClick={() => { setEditorMode("measure"); setSplitMode(false); resetSplitState(); setSelectedDetectorIds([]); setMarquee(null); }} style={ceToolBtn(editorMode === "measure")}>
                    Measure
                  </button>
                  {canEdit && (
                    <>
                      <div style={{ width: 1, height: 20, background: "#E8EAED" }} />
                      <button onClick={() => { setEditorMode("shape_select"); setSplitMode(false); resetSplitState(); }} style={ceToolBtn(editorMode === "shape_select")}>Shape Select</button>
                      <button onClick={() => { setEditorMode("shape_rect"); setSplitMode(false); resetSplitState(); }} style={ceToolBtn(editorMode === "shape_rect")}>Rectangle</button>
                      <button onClick={() => { setEditorMode("shape_circle"); setSplitMode(false); resetSplitState(); }} style={ceToolBtn(editorMode === "shape_circle")}>Circle</button>
                      <button onClick={() => { setEditorMode("shape_cloud"); setSplitMode(false); resetSplitState(); }} style={ceToolBtn(editorMode === "shape_cloud")}>Cloud</button>
                      <button onClick={() => { setEditorMode("text_add"); setSplitMode(false); resetSplitState(); }} style={ceToolBtn(editorMode === "text_add")}>Text</button>
                    </>
                  )}
                  {canEdit && (
                  <>
                  <div style={{ width: 1, height: 20, background: "#E8EAED" }} />
                  <button onClick={() => { setEditorMode("pipe_draw"); setSplitMode(false); resetSplitState(); setSelectedPipeIdx(null); setPipeDrawStart(null); setPipeDrawEnd(null); setPipeJoinHover(null); }} style={ceToolBtn(editorMode === "pipe_draw" || editorMode === "pipe_select")}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                    Pipes
                  </button>
                  </>
                  )}
                  {selectedDetectorIds.length > 0 ? (
                    <>
                      <span style={{ fontSize: 12, color: "#6B7280", marginLeft: 4 }}>Selected: {selectedDetectorIds.length}</span>
                      {canEdit && <button onClick={() => rotateDetectorsMany(selectedDetectorIds, -15)} style={ceToolBtn(false)}>Rotate -15°</button>}
                      {canEdit && <button onClick={() => rotateDetectorsMany(selectedDetectorIds, 15)} style={ceToolBtn(false)}>Rotate +15°</button>}
                      {canEdit && <button onClick={() => deleteDetectorsMany(selectedDetectorIds)} style={{ ...ceToolBtn(false), color: "#DC2626", borderColor: "#FECACA" }}>Delete Selected</button>}
                      <button onClick={() => setSelectedDetectorIds([])} style={ceToolBtn(false)}>Clear</button>
                    </>
                  ) : null}
                </div>
                {canEdit ? (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "6px 10px", borderRadius: 12,
                    background: "#F3F4F6", border: "1px solid #D1D5DB",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                    pointerEvents: "auto",
                  }}>
                    {OBJECT_TYPES.map((otype) => (
                      <button
                        key={otype}
                        onClick={() => { setAddType(otype); setEditorMode("add"); }}
                        style={ceObjectBtn(addType === otype)}
                        title={`Place ${objectLabel(otype)}`}
                      >
                        {renderObjectIcon(otype)}
                        <span style={{ fontSize: 11 }}>{objectLabel(otype)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {(editorMode === "pipe_draw" || editorMode === "pipe_select") ? (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "6px 10px", borderRadius: 12,
                    background: "#F3F4F6", border: "1px solid #D1D5DB",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                    pointerEvents: "auto",
                  }}>
                    <button onClick={() => { setEditorMode("pipe_draw"); setSelectedPipeIdx(null); setPipeJoinHover(null); }} style={ceToolBtn(editorMode === "pipe_draw")}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                      Draw
                    </button>
                    <button onClick={() => { setEditorMode("pipe_select"); setPipeDrawStart(null); setPipeDrawEnd(null); setPipeJoinHover(null); }} style={ceToolBtn(editorMode === "pipe_select")}>
                      Select
                    </button>
                    {editorMode === "pipe_draw" ? (
                      <select
                        value={drawPipeDiameter}
                        onChange={(e) => setDrawPipeDiameter(e.target.value)}
                        style={{
                          ...ceToolBtn(false),
                          height: 30,
                          minWidth: 112,
                          padding: "0 8px",
                          borderColor: "rgba(220,38,38,0.3)",
                          color: "#DC2626",
                          background: "#fff",
                        }}
                        title="Thickness for new pipes"
                      >
                        {PIPE_DIAMETERS_MM.map(mm => (
                          <option key={mm} value={`${mm}mm`}>{`Draw ${mm} mm`}</option>
                        ))}
                      </select>
                    ) : null}
                    {selectedPipeIdx !== null ? (
                      <button onClick={() => deletePipe(selectedPipeIdx)} style={{ ...ceToolBtn(false), borderColor: "rgba(220,38,38,0.3)", color: "#DC2626" }}>
                        Delete
                      </button>
                    ) : null}
                    {selectedPipeIdx !== null ? (
                      <select
                        value={selectedPipeDiameter || "25mm"}
                        onChange={(e) => setSelectedPipeDiameter(e.target.value)}
                        style={{
                          ...ceToolBtn(false),
                          height: 30,
                          minWidth: 98,
                          padding: "0 8px",
                          borderColor: "rgba(220,38,38,0.3)",
                          color: "#DC2626",
                          background: "#fff",
                        }}
                        title="Pipe thickness"
                      >
                        {PIPE_DIAMETERS_MM.map(mm => (
                          <option key={mm} value={`${mm}mm`}>{`${mm} mm`}</option>
                        ))}
                      </select>
                    ) : null}
                    {(pipesData?.pipes?.length || 0) > 0 ? (
                      <button onClick={clearPipes} style={{ ...ceToolBtn(false), borderColor: "rgba(220,38,38,0.3)", color: "#DC2626" }}>
                        Clear Pipes
                      </button>
                    ) : null}
                    <span style={{ fontSize: 11, color: "#6B7280" }}>
                      {pipesData?.pipes?.length || 0} pipes
                    </span>
                  </div>
                ) : null}
              </div>

              {/* ── Zoom controls ── */}
              <div style={{
                position: "absolute", bottom: 14, left: 14, zIndex: 3,
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 10px", borderRadius: 12,
                background: "#FFFFFF", border: "1px solid #E8EAED",
                boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
              }}>
                <button onClick={() => zoomOut()} style={ceZoomBtn}>&#8722;</button>
                <input type="range" min={2} max={2400}
                  value={Math.max(2, Math.min(2400, Math.round(transformState.scale * 100)))}
                  onChange={(e) => setTransform(transformState.positionX, transformState.positionY, Number(e.target.value) / 100, 100)}
                  style={{ width: 100 }}
                />
                <button onClick={() => zoomIn()} style={ceZoomBtn}>+</button>
                <button onClick={() => resetTransform()} style={ceZoomBtn}>Fit</button>
                <span style={{ fontSize: 12, color: "#6B7280", minWidth: 40, textAlign: "right" }}>
                  {Math.round(transformState.scale * 100)}%
                </span>
              </div>

              <TransformComponent
                wrapperStyle={{
                  width: "100%", height: "100%", borderRadius: "14px",
                  border: "1px solid #E8EAED",
                  background: "#FAFBFC",
                }}
              >
                <div style={{ position: "relative", display: "inline-block" }}>
                  <img
                    src={renderUrl}
                    alt="Floor plan"
                    style={{ display: "block", userSelect: "none", pointerEvents: "none", borderRadius: 8 }}
                    draggable={false}
                    onLoad={onImageLoad}
                  />
                  {imgDims ? (
                    <svg
                      width={imgDims.w}
                      height={imgDims.h}
                      viewBox={`0 0 ${imgDims.w} ${imgDims.h}`}
                      style={{ position: "absolute", left: 0, top: 0, cursor: canvasCursor() }}
                      onClick={(e) => {
                        // Source selection mode: click to place custom source
                        if (sourceSelectMode) {
                          const pt = toImagePoint(e);
                          if (!pt) return;
                          const w = pixelToWorld(mapping, pt.px, pt.py);
                          setChosenSource({ x: w.x, y: w.y });
                          return;
                        }
                        if (editorMode === "rooms" && splitMode && selectedRoom) {
                          const pt = toImagePoint(e);
                          if (!pt) return;
                          const snapped = snapPointToRoomBoundary(selectedRoom, pt);
                          if (snapped) handleSplitDotClick(snapped);
                        }
                      }}
                      onMouseDown={(e) => {
                        const point = toImagePoint(e);
                        if (!point) return;
                        const { px, py } = point;
                        if (editorMode === "shape_rect" || editorMode === "shape_circle" || editorMode === "shape_cloud") {
                          if (!canEdit) return;
                          setSelectedShapeId(null);
                          setShapeDrag(null);
                          setShapeResize(null);
                          setShapeDraft({
                            kind: editorMode === "shape_rect" ? "rect" : editorMode === "shape_circle" ? "circle" : "cloud",
                            start: point,
                            end: point,
                          });
                          return;
                        }
                        if (editorMode === "text_add") {
                          if (!canEdit) return;
                          const text = window.prompt("Enter text:", "Text");
                          if (!text || !text.trim()) return;
                          const clean = text.trim();
                          const fontSize = 16;
                          const estW = Math.max(44, clean.length * 9 + 10);
                          const estH = fontSize + 8;
                          const shape: ShapeAnnotation = {
                            id: crypto.randomUUID(),
                            kind: "text",
                            x: px,
                            y: py - estH,
                            w: estW,
                            h: estH,
                            text: clean,
                            fontSize,
                          };
                          setShapes(prev => [...prev, shape]);
                          setSelectedShapeId(shape.id);
                          setEditorMode("shape_select");
                          return;
                        }
                        if (editorMode === "shape_select") {
                          const selected = selectedShapeId ? shapes.find(s => s.id === selectedShapeId) || null : null;
                          if (selected) {
                            const hitHandle = hitShapeResizeHandle(selected, point);
                            if (hitHandle && canEdit) {
                              setShapeResize({ id: selected.id, handle: hitHandle, start: point, origin: selected });
                              return;
                            }
                          }
                          const hitId = findShapeAtPoint(point);
                          if (hitId) {
                            setSelectedShapeId(hitId);
                            const hitShape = shapes.find(s => s.id === hitId) || null;
                            if (hitShape?.kind === "text" && e.detail >= 2 && canEdit) {
                              const next = window.prompt("Edit text:", hitShape.text || "")?.trim();
                              if (next) {
                                const font = hitShape.fontSize || 16;
                                setShapes(prev => prev.map(s => s.id === hitId ? { ...s, text: next, w: Math.max(44, next.length * Math.max(7, font * 0.58) + 10), h: Math.max(font + 8, s.h) } : s));
                              }
                              return;
                            }
                            if (canEdit) {
                              if (hitShape) setShapeDrag({ id: hitId, start: point, origin: hitShape });
                            }
                          } else {
                            setSelectedShapeId(null);
                          }
                          return;
                        }
                        if (editorMode === "measure") {
                          if (!measureStart || measureLocked) {
                            setMeasureStart({ px, py });
                            setMeasureEnd({ px, py });
                            setMeasureLocked(false);
                          } else {
                            setMeasureEnd({ px, py });
                            setMeasureLocked(true);
                          }
                          return;
                        }
                        if (editorMode === "rooms") return;
                        // Pipe draw mode
                        if (editorMode === "pipe_draw") {
                          if (!pipeDrawStart) {
                            const join = closestPointOnPipe(px, py, 10);
                            const startPt = join ? { px: join.px, py: join.py } : { px, py };
                            setPipeDrawStart(startPt);
                            setPipeDrawEnd(startPt);
                            setPipeJoinHover(join ? startPt : null);
                          }
                          return;
                        }
                        // Pipe select mode
                        if (editorMode === "pipe_select") {
                          const pIdx = hitTestPipe(px, py);
                          setSelectedPipeIdx(pIdx);
                          return;
                        }
                        const detId = hitTestDetector(px, py);
                        if (editorMode === "select") {
                          if (detId) {
                            if (selectedDetectorIds.includes(detId)) beginGroupDrag(selectedDetectorIds, point);
                            else { setSelectedDetectorIds([detId]); beginGroupDrag([detId], point); }
                          } else { setMarquee({ sx: px, sy: py, ex: px, ey: py }); }
                          return;
                        }
                        if (editorMode === "add") { if (canEdit) addDetectorAt(px, py); return; }
                        if (editorMode === "erase") {
                          if (detId) { if (canEdit) deleteDetector(detId); }
                          else { setMarquee({ sx: px, sy: py, ex: px, ey: py }); }
                          return;
                        }
                      }}
                      onMouseMove={(e) => {
                        const point = toImagePoint(e);
                        if (!point) return;
                        if (shapeDraft) {
                          setShapeDraft({ ...shapeDraft, end: point });
                          return;
                        }
                        if (shapeResize) {
                          const o = shapeResize.origin;
                          const left = o.x;
                          const top = o.y;
                          const right = o.x + o.w;
                          const bottom = o.y + o.h;
                          const anchor = {
                            px: shapeResize.handle.includes("w") ? right : left,
                            py: shapeResize.handle.includes("n") ? bottom : top,
                          };
                          const raw = o.kind === "circle"
                            ? circleRectFromPoints(anchor, point)
                            : normalizeShapeRect(anchor, point);
                          const minSize = o.kind === "text" ? 20 : 8;
                          const next = { ...o, x: raw.x, y: raw.y, w: Math.max(minSize, raw.w), h: Math.max(minSize, raw.h) };
                          setShapes(prev => prev.map(s => (s.id === o.id ? next : s)));
                          return;
                        }
                        if (shapeDrag) {
                          const dx = point.px - shapeDrag.start.px;
                          const dy = point.py - shapeDrag.start.py;
                          const o = shapeDrag.origin;
                          setShapes(prev => prev.map(s => (s.id === o.id ? { ...s, x: o.x + dx, y: o.y + dy } : s)));
                          return;
                        }
                        if (editorMode === "rooms" && splitMode && selectedRoom) {
                          const snapped = snapPointToRoomBoundary(selectedRoom, point);
                          setSplitHover(snapped);
                          return;
                        }
                        if (editorMode === "measure") {
                          if (measureStart && !measureLocked) setMeasureEnd(point);
                          return;
                        }
                        setHoverPoint(point);
                        // In pipe draw mode, show join hover point on nearby lines even before first click.
                        if (editorMode === "pipe_draw") {
                          const join = closestPointOnPipe(point.px, point.py, 10);
                          setPipeJoinHover(join ? { px: join.px, py: join.py } : null);
                          if (pipeDrawStart) {
                            if (join) setPipeDrawEnd({ px: join.px, py: join.py });
                            else setPipeDrawEnd(point);
                          }
                          return;
                        }
                        if (editorMode !== "select" && editorMode !== "erase") return;
                        if (marquee) {
                          setMarquee({ ...marquee, ex: point.px, ey: point.py });
                          setAlignmentGuides({ vertical: [], horizontal: [] });
                          return;
                        }
                        if (!groupDrag) return;
                        const dx = point.px - groupDrag.start.px;
                        const dy = point.py - groupDrag.start.py;
                        const next: Record<string, { px: number; py: number }> = {};
                        for (const detId of groupDrag.ids) {
                          const base = groupDrag.origins[detId];
                          if (base) next[detId] = { px: base.px + dx, py: base.py + dy };
                        }
                        setGroupPreview(next);
                        setAlignmentGuides(computeAlignmentGuides(next, groupDrag.ids));
                      }}
                      onMouseUp={() => {
                        if (shapeDraft) {
                          const rect = shapeDraft.kind === "circle"
                            ? circleRectFromPoints(shapeDraft.start, shapeDraft.end)
                            : normalizeShapeRect(shapeDraft.start, shapeDraft.end);
                          setShapeDraft(null);
                          if (rect.w >= 8 && rect.h >= 8 && canEdit) {
                            const id = crypto.randomUUID();
                            setShapes(prev => [...prev, { id, kind: shapeDraft.kind, ...rect }]);
                            setSelectedShapeId(id);
                            setEditorMode("shape_select");
                          }
                          return;
                        }
                        if (shapeDrag) {
                          setShapeDrag(null);
                          return;
                        }
                        if (shapeResize) {
                          setShapeResize(null);
                          return;
                        }
                        if (editorMode === "measure") return;
                        // Finalize pipe draw
                        if (editorMode === "pipe_draw" && pipeDrawStart && pipeDrawEnd) {
                          const dist = Math.hypot(pipeDrawEnd.px - pipeDrawStart.px, pipeDrawEnd.py - pipeDrawStart.py);
                          if (dist > 5) {
                            const joinedEnd = closestPointOnPipe(pipeDrawEnd.px, pipeDrawEnd.py, 10);
                            const endPt = joinedEnd
                              ? { px: joinedEnd.px, py: joinedEnd.py }
                              : resolvePipeDrawEnd(pipeDrawStart, pipeDrawEnd).end;
                            addPipe(pipeDrawStart, endPt);
                          }
                          setPipeDrawStart(null);
                          setPipeDrawEnd(null);
                          setPipeJoinHover(null);
                          return;
                        }
                        if (editorMode !== "select" && editorMode !== "erase") return;
                        if (marquee) {
                          const rect = rectFromPoints({ px: marquee.sx, py: marquee.sy }, { px: marquee.ex, py: marquee.ey });
                          if (editorMode === "erase" && canEdit) {
                            const ids = idsInRect(rect);
                            deleteDetectorsMany(ids);
                          } else {
                            setSelectedDetectorIds(idsInRect(rect));
                          }
                          setMarquee(null);
                          setAlignmentGuides({ vertical: [], horizontal: [] });
                          return;
                        }
                        if (groupDrag && groupPreview) {
                          moveDetectorsToMany(groupPreview);
                          setGroupDrag(null);
                          setGroupPreview(null);
                          setAlignmentGuides({ vertical: [], horizontal: [] });
                        }
                      }}
                      onMouseLeave={() => {
                        setHoverPoint(null);
                        if (editorMode === "rooms") setSplitHover(null);
                        if (marquee) setMarquee(null);
                        if (groupDrag) setGroupDrag(null);
                        if (groupPreview) setGroupPreview(null);
                        if (shapeDrag) setShapeDrag(null);
                        if (shapeResize) setShapeResize(null);
                        if (pipeDrawStart) { setPipeDrawStart(null); setPipeDrawEnd(null); }
                        setPipeJoinHover(null);
                        setAlignmentGuides({ vertical: [], horizontal: [] });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (!canEdit) return;
                        if (editorMode === "rooms") return;
                        const point = toImagePoint(e);
                        if (!point) return;
                        const detId = hitTestDetector(point.px, point.py);
                        if (detId) deleteDetector(detId);
                      }}
                    >
                      {/* Sprinkler pipes */}
                      {pipesData?.pipes?.map((pipe, i) => {
                        const p1 = worldToPixel(mapping, pipe.from[0], pipe.from[1]);
                        const p2 = worldToPixel(mapping, pipe.to[0], pipe.to[1]);
                        const isSel = selectedPipeIdx === i;
                        const baseW = pipeStrokeWidthPx(pipe.diameter);
                        return (
                          <g key={`pipe-${i}`}
                            onClick={(e) => {
                              if (editorMode === "pipe_select") { e.stopPropagation(); setSelectedPipeIdx(isSel ? null : i); }
                            }}
                            style={{ cursor: editorMode === "pipe_select" ? "pointer" : "inherit" }}
                          >
                            {isSel ? (
                              <line x1={p1.px} y1={p1.py} x2={p2.px} y2={p2.py}
                                stroke="#ffe58f" strokeWidth={baseW + 3} opacity={0.5} />
                            ) : null}
                            <line x1={p1.px} y1={p1.py} x2={p2.px} y2={p2.py}
                              stroke={isSel ? "#f59e0b" : "#DC2626"} strokeWidth={isSel ? Math.max(3, baseW + 0.8) : baseW} opacity={isSel ? 1 : 0.7} />
                            {(editorMode === "pipe_select" || editorMode === "pipe_draw") ? (
                              <line x1={p1.px} y1={p1.py} x2={p2.px} y2={p2.py}
                                stroke="transparent" strokeWidth={12} />
                            ) : null}
                          </g>
                        );
                      })}
                      {/* Pipe draw preview */}
                      {editorMode === "pipe_draw" && pipeDrawStart && pipeDrawEnd ? (() => {
                        const drawW = pipeStrokeWidthPx(drawPipeDiameter);
                        const resolved = resolvePipeDrawEnd(pipeDrawStart, pipeDrawEnd);
                        const snappedEnd = resolved.end;
                        const highlightAxis = resolved.axis;
                        return (
                          <>
                            {highlightAxis ? (
                              <line x1={pipeDrawStart.px} y1={pipeDrawStart.py} x2={snappedEnd.px} y2={snappedEnd.py}
                                stroke="#22C55E" strokeWidth={drawW + 1.2} strokeDasharray="8 4" opacity={0.35} />
                            ) : null}
                            <line x1={pipeDrawStart.px} y1={pipeDrawStart.py} x2={snappedEnd.px} y2={snappedEnd.py}
                              stroke={highlightAxis ? "#16A34A" : "#DC2626"} strokeWidth={drawW} strokeDasharray="8 4" opacity={0.9} />
                          </>
                        );
                      })() : null}
                      {editorMode === "pipe_draw" && pipeJoinHover ? (
                        <circle cx={pipeJoinHover.px} cy={pipeJoinHover.py} r={4.5} fill="#FFFFFF" stroke="#DC2626" strokeWidth={2} />
                      ) : null}
                      {pipesData?.sources?.map((src, i) => {
                        const p = worldToPixel(mapping, src.x, src.y);
                        return (
                          <g key={`src-${i}`}>
                            <rect x={p.px - 7} y={p.py - 7} width={14} height={14} rx={2} fill="#B91C1C" opacity={0.85} />
                            <line x1={p.px - 4} y1={p.py} x2={p.px + 4} y2={p.py} stroke="#fff" strokeWidth={1.8} />
                            <line x1={p.px} y1={p.py - 4} x2={p.px} y2={p.py + 4} stroke="#fff" strokeWidth={1.8} />
                          </g>
                        );
                      })}

                      {/* Detected source markers (during source selection) */}
                      {sourceSelectMode && detectedSources.map((src, i) => {
                        const p = worldToPixel(mapping, src.x, src.y);
                        const isChosen = chosenSource && Math.abs(chosenSource.x - src.x) < 1 && Math.abs(chosenSource.y - src.y) < 1;
                        return (
                          <g key={`dsrc-${i}`} style={{ cursor: "pointer" }}
                            onClick={(e) => { e.stopPropagation(); setChosenSource(src); }}
                          >
                            <circle cx={p.px} cy={p.py} r={18} fill="none" stroke={isChosen ? "#16A34A" : "#F59E0B"} strokeWidth={3} strokeDasharray={isChosen ? "none" : "6 3"} />
                            <circle cx={p.px} cy={p.py} r={6} fill={isChosen ? "#16A34A" : "#F59E0B"} />
                            <text x={p.px} y={p.py - 24} textAnchor="middle" fill={isChosen ? "#16A34A" : "#F59E0B"} fontSize={12} fontWeight={700}>
                              {isChosen ? "✓ Selected" : `Source ${i + 1}`}
                            </text>
                          </g>
                        );
                      })}

                      {/* User-placed custom source marker */}
                      {sourceSelectMode && chosenSource && !detectedSources.some(s => Math.abs(s.x - chosenSource.x) < 1 && Math.abs(s.y - chosenSource.y) < 1) && (() => {
                        const p = worldToPixel(mapping, chosenSource.x, chosenSource.y);
                        return (
                          <g>
                            <circle cx={p.px} cy={p.py} r={18} fill="none" stroke="#16A34A" strokeWidth={3} />
                            <circle cx={p.px} cy={p.py} r={6} fill="#16A34A" />
                            <text x={p.px} y={p.py - 24} textAnchor="middle" fill="#16A34A" fontSize={12} fontWeight={700}>
                              ✓ Custom Source
                            </text>
                          </g>
                        );
                      })()}

                      {/* Shape annotations */}
                      {shapes.map((s) => {
                        const isSelected = selectedShapeId === s.id;
                        if (s.kind === "text") {
                          return (
                            <g key={s.id}>
                              <text x={s.x + 2} y={s.y + (s.fontSize || 16)} fill="#1F2937" fontSize={s.fontSize || 16} fontWeight={600}>
                                {s.text || "Text"}
                              </text>
                              {isSelected ? (
                                <rect
                                  x={s.x}
                                  y={s.y}
                                  width={s.w}
                                  height={s.h}
                                  fill="none"
                                  stroke="#2563EB"
                                  strokeWidth={1.4}
                                  strokeDasharray="6 4"
                                />
                              ) : null}
                            </g>
                          );
                        }
                        if (s.kind === "circle") {
                          return (
                            <ellipse
                              key={s.id}
                              cx={s.x + s.w * 0.5}
                              cy={s.y + s.h * 0.5}
                              rx={Math.max(1, s.w * 0.5)}
                              ry={Math.max(1, s.h * 0.5)}
                              fill="rgba(59,130,246,0.08)"
                              stroke={isSelected ? "#2563EB" : "#1F2937"}
                              strokeWidth={isSelected ? 2.2 : 1.8}
                              strokeDasharray={isSelected ? "6 4" : undefined}
                            />
                          );
                        }
                        if (s.kind === "cloud") {
                          return (
                            <path
                              key={s.id}
                              d={cloudPathFromRect(s.x, s.y, s.w, s.h)}
                              fill="rgba(34,211,238,0.08)"
                              stroke={isSelected ? "#06B6D4" : "#0891B2"}
                              strokeWidth={isSelected ? 2.2 : 1.8}
                              strokeDasharray={isSelected ? "6 4" : undefined}
                            />
                          );
                        }
                        return (
                          <rect
                            key={s.id}
                            x={s.x}
                            y={s.y}
                            width={s.w}
                            height={s.h}
                            fill="rgba(16,185,129,0.08)"
                            stroke={isSelected ? "#2563EB" : "#1F2937"}
                            strokeWidth={isSelected ? 2.2 : 1.8}
                            strokeDasharray={isSelected ? "6 4" : undefined}
                          />
                        );
                      })}

                      {/* Draft shape + live dimensions while drawing */}
                      {shapeDraft ? (() => {
                        const rect = shapeDraft.kind === "circle"
                          ? circleRectFromPoints(shapeDraft.start, shapeDraft.end)
                          : normalizeShapeRect(shapeDraft.start, shapeDraft.end);
                        const label = shapeDimensionLabel({ kind: shapeDraft.kind, ...rect });
                        return (
                          <g style={{ pointerEvents: "none" }}>
                            {shapeDraft.kind === "circle" ? (
                              <ellipse
                                cx={rect.x + rect.w * 0.5}
                                cy={rect.y + rect.h * 0.5}
                                rx={Math.max(1, rect.w * 0.5)}
                                ry={Math.max(1, rect.h * 0.5)}
                                fill="rgba(59,130,246,0.12)"
                                stroke="#2563EB"
                                strokeWidth={2}
                                strokeDasharray="8 4"
                              />
                            ) : shapeDraft.kind === "cloud" ? (
                              <path
                                d={cloudPathFromRect(rect.x, rect.y, rect.w, rect.h)}
                                fill="rgba(34,211,238,0.12)"
                                stroke="#0891B2"
                                strokeWidth={2}
                                strokeDasharray="8 4"
                              />
                            ) : (
                              <rect
                                x={rect.x}
                                y={rect.y}
                                width={rect.w}
                                height={rect.h}
                                fill="rgba(59,130,246,0.12)"
                                stroke="#2563EB"
                                strokeWidth={2}
                                strokeDasharray="8 4"
                              />
                            )}
                            <rect x={rect.x} y={rect.y - 22} width={124} height={18} rx={7} fill="rgba(37,99,235,0.92)" />
                            <text x={rect.x + 62} y={rect.y - 9} textAnchor="middle" fill="#ffffff" fontSize={11} fontWeight={700}>{label}</text>
                          </g>
                        );
                      })() : null}

                      {/* Resize handles for selected shape */}
                      {selectedShape && editorMode === "shape_select" ? (() => {
                        const left = selectedShape.x;
                        const top = selectedShape.y;
                        const right = selectedShape.x + selectedShape.w;
                        const bottom = selectedShape.y + selectedShape.h;
                        const handlePts = [
                          { px: left, py: top },
                          { px: right, py: top },
                          { px: left, py: bottom },
                          { px: right, py: bottom },
                        ];
                        return (
                          <g>
                            {handlePts.map((h, i) => (
                              <rect key={`shape-handle-${i}`} x={h.px - 4} y={h.py - 4} width={8} height={8} rx={1} fill="#ffffff" stroke="#2563EB" strokeWidth={1.4} />
                            ))}
                          </g>
                        );
                      })() : null}

                      {/* Alignment guides while moving elements */}
                      {groupDrag ? (
                        <g style={{ pointerEvents: "none" }}>
                          {alignmentGuides.vertical.map((x, i) => (
                            <line
                              key={`guide-v-${i}-${Math.round(x)}`}
                              x1={x}
                              y1={0}
                              x2={x}
                              y2={imgDims?.h || 0}
                              stroke="#2D6A4F"
                              strokeWidth={1.5}
                              strokeDasharray="6 4"
                              opacity={0.75}
                            />
                          ))}
                          {alignmentGuides.horizontal.map((y, i) => (
                            <line
                              key={`guide-h-${i}-${Math.round(y)}`}
                              x1={0}
                              y1={y}
                              x2={imgDims?.w || 0}
                              y2={y}
                              stroke="#2D6A4F"
                              strokeWidth={1.5}
                              strokeDasharray="6 4"
                              opacity={0.75}
                            />
                          ))}
                        </g>
                      ) : null}

                      {/* Detectors */}
                      {detectors.map(d => {
                        const p = groupPreview?.[d.id] || worldToPixel(mapping, d.x, d.y);
                        const isSel = selectedDetectorIds.includes(d.id);
                        const isSprinkler = (d.dtype || "").toLowerCase() === "sprinkler";
                        const rotationDeg = d.rotation_deg ?? 0;
                        return (
                          <g key={d.id}>
                            {isSel ? (
                              <>
                                <circle cx={p.px} cy={p.py} r={16} fill="rgba(255,229,143,0.20)" />
                                <circle cx={p.px} cy={p.py} r={15} fill="none" stroke="#ffe58f" strokeWidth={3} strokeDasharray="6 4" />
                              </>
                            ) : null}
                            <g transform={`rotate(${rotationDeg} ${p.px} ${p.py})`}>
                              {renderPlacedObject(d.dtype, p.px, p.py, mapping, worldToM)}
                            </g>
                            {!isSprinkler ? <circle cx={p.px} cy={p.py} r={11} fill="none" stroke={isSel ? "#ffe58f" : "#ffffff"} strokeWidth={isSel ? 3 : 2} /> : null}
                            {isSel ? <circle cx={p.px} cy={p.py} r={3} fill="#fff7d1" /> : null}
                          </g>
                        );
                      })}

                      {/* Marquee selection */}
                      {marquee ? (() => {
                        const rect = rectFromPoints({ px: marquee.sx, py: marquee.sy }, { px: marquee.ex, py: marquee.ey });
                        const isEraseMarquee = editorMode === "erase";
                        return (
                          <rect x={rect.left} y={rect.top}
                            width={Math.max(1, rect.right - rect.left)} height={Math.max(1, rect.bottom - rect.top)}
                            fill={isEraseMarquee ? "rgba(220,38,38,0.15)" : "rgba(45,106,79,0.12)"}
                            stroke={isEraseMarquee ? "#DC2626" : "#2D6A4F"}
                            strokeWidth={2} strokeDasharray="6 4" />
                        );
                      })() : null}

                      {/* Add detector preview */}
                      {editorMode === "add" && hoverPoint ? (
                        <g>
                          <circle cx={hoverPoint.px} cy={hoverPoint.py} r={13} fill="none" stroke="#2D6A4F" strokeWidth={2} strokeDasharray="5 4" />
                          <line x1={hoverPoint.px - 9} y1={hoverPoint.py} x2={hoverPoint.px + 9} y2={hoverPoint.py} stroke="#2D6A4F" strokeWidth={2} />
                          <line x1={hoverPoint.px} y1={hoverPoint.py - 9} x2={hoverPoint.px} y2={hoverPoint.py + 9} stroke="#2D6A4F" strokeWidth={2} />
                        </g>
                      ) : null}

                      {/* Measure stencil */}
                      {measureStart && measureEnd ? (() => {
                        const worldA = pixelToWorld(mapping, measureStart.px, measureStart.py);
                        const worldB = pixelToWorld(mapping, measureEnd.px, measureEnd.py);
                        const dWorld = Math.hypot(worldB.x - worldA.x, worldB.y - worldA.y);
                        const dMeters = dWorld * worldToM;
                        const midX = (measureStart.px + measureEnd.px) * 0.5;
                        const midY = (measureStart.py + measureEnd.py) * 0.5;
                        return (
                          <g style={{ pointerEvents: "none" }}>
                            <line
                              x1={measureStart.px}
                              y1={measureStart.py}
                              x2={measureEnd.px}
                              y2={measureEnd.py}
                              stroke="#2563EB"
                              strokeWidth={2.5}
                              strokeDasharray="8 4"
                            />
                            <circle cx={measureStart.px} cy={measureStart.py} r={5} fill="#DBEAFE" stroke="#2563EB" strokeWidth={2} />
                            <circle cx={measureEnd.px} cy={measureEnd.py} r={5} fill="#DBEAFE" stroke="#2563EB" strokeWidth={2} />
                            <rect x={midX - 60} y={midY - 24} width={120} height={22} rx={8} fill="rgba(37,99,235,0.92)" />
                            <text x={midX} y={midY - 9} textAnchor="middle" fill="#ffffff" fontSize={12} fontWeight={700}>
                              {`${dMeters.toFixed(2)} m`}
                            </text>
                          </g>
                        );
                      })() : null}
                    </svg>
                  ) : null}
                </div>
              </TransformComponent>
            </>
          )}
        </TransformWrapper>
      </div>

      {/* ── Sidebar ── */}
      <div style={{
        width: 320, flexShrink: 0, borderLeft: "1px solid #E8EAED",
        background: "#FFFFFF",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: "1px solid #E8EAED", flexShrink: 0 }}>
          <button
            onClick={() => setSidebarTab("equipment")}
            style={{
              flex: 1, padding: "12px 0", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
              background: "#FFFFFF",
              color: "#2D6A4F",
              borderBottom: "2px solid #2D6A4F",
            }}
          >
            Equipment ({detectors.length})
          </button>
        </div>

          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            <div style={{ padding: "10px 14px 6px" }}>
              <p style={{ margin: 0, fontSize: 12, color: "#6B7280", lineHeight: 1.4 }}>
                {canEdit
                  ? "Auto-place equipment based on NBC rules, or manually place using the toolbar."
                  : "Equipment placement (view only). You need editor or admin role to modify."}
              </p>
            </div>

            {/* Per-equipment auto-place buttons */}
            {canEdit && (
            <div style={{ padding: "6px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
              {(() => {
                const EQUIPMENT_BUTTONS: { key: string; dtype: string; label: string; icon: React.ReactNode }[] = [
                  {
                    key: "auto_detection_alarm", dtype: "smoke",
                    label: "Smoke Detectors",
                    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><text x="12" y="16" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor" stroke="none">S</text></svg>,
                  },
                  {
                    key: "auto_sprinkler", dtype: "sprinkler",
                    label: "Sprinklers",
                    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v6"/><path d="M5 10l7 4 7-4"/><path d="M5 14l2 6"/><path d="M19 14l-2 6"/><path d="M12 14v8"/></svg>,
                  },
                  {
                    key: "yard_hydrant", dtype: "fire_hose",
                    label: "External Hydrant",
                    icon: <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><rect x="2.5" y="10" width="7.5" height="4" fill="none" stroke="currentColor" strokeWidth="1.8"/><line x1="2.7" y1="12" x2="11.6" y2="12" stroke="currentColor" strokeWidth="1.2" opacity="0.9"/><rect x="8.6" y="7.6" width="3.6" height="8.8" fill="currentColor"/><circle cx="14.2" cy="12" r="3.9" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M10.3 12 C 12.1 10.3, 14.8 13.7, 17 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M19.6 8.4 Q21 12 19.6 15.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><line x1="20.9" y1="8.8" x2="20.9" y2="15.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>,
                  },
                  {
                    key: "mcp_hooter", dtype: "mcp_hooter",
                    label: "MCP + Hooter",
                    icon: <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><rect x="2.5" y="8" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.6"/><circle cx="6" cy="11.5" r="1.4" fill="currentColor"/><path d="M14 15.8h7v2.2h-7z" fill="currentColor" opacity="0.35"/><path d="M15 14h5.5Q20.5 9.8 18 9q-2.5.8-3 5z" fill="currentColor"/><line x1="18" y1="6.6" x2="18" y2="4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
                  },
                ];

                const nbcMap: Record<string, NBCEquipmentItem> = {};
                for (const eq of nbcEquipment) { nbcMap[eq.key] = eq; }

                const detCounts: Record<string, number> = {};
                for (const d of detectors) { detCounts[d.dtype] = (detCounts[d.dtype] || 0) + 1; }

                return EQUIPMENT_BUTTONS.map(btn => {
                  const nbcInfo = nbcMap[btn.key];
                  const isRequired = nbcInfo?.required ?? false;
                  const isPlacing = isAutoPlacing === btn.dtype;
                  const placedCount = btn.dtype === "mcp_hooter"
                    ? (detCounts["mcb"] || 0) + (detCounts["hooter"] || 0)
                    : (detCounts[btn.dtype] || 0);

                  return (
                    <div key={btn.key} style={{
                      padding: "10px 12px", borderRadius: 10,
                      background: "#FAFBFC", border: "1px solid #E8EAED",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <div style={{ color: isRequired ? "#2D6A4F" : "#9CA3AF", flexShrink: 0 }}>{btn.icon}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A2E" }}>{btn.label}</div>
                          <div style={{ fontSize: 11, color: "#6B7280", marginTop: 1 }}>
                            {nbcInfo ? (isRequired ? "Required by NBC" : "Not required") : "NBC status unknown"}
                            {placedCount > 0 ? ` \u00B7 ${placedCount} placed` : ""}
                          </div>
                        </div>
                        {isRequired ? (
                          <span style={{
                            fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                            background: "#ECFDF5", color: "#059669", border: "1px solid rgba(5,150,105,0.2)",
                            textTransform: "uppercase", letterSpacing: "0.05em", flexShrink: 0,
                          }}>Required</span>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => autoPlaceEquipment(btn.dtype)}
                          disabled={!!isAutoPlacing || rooms.length === 0}
                          style={{
                            flex: 1, padding: "6px 10px", borderRadius: 8,
                            border: "none",
                            background: isPlacing ? "#9CA3AF" : isRequired ? "#2D6A4F" : "#6B7280",
                            color: "#fff", fontWeight: 600, fontSize: 11,
                            cursor: (!!isAutoPlacing || rooms.length === 0) ? "wait" : "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                            opacity: (!!isAutoPlacing && !isPlacing) ? 0.5 : 1,
                          }}
                        >
                          {isPlacing ? (
                            <>
                              <div style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                              Placing...
                            </>
                          ) : (
                            <>{placedCount > 0 ? "Re-place" : "Auto-place"}</>
                          )}
                        </button>
                        {placedCount > 0 ? (
                          <button
                            onClick={() => clearEquipmentType(btn.dtype)}
                            disabled={!!isAutoPlacing}
                            style={{
                              padding: "6px 10px", borderRadius: 8,
                              border: "1px solid rgba(220,38,38,0.2)",
                              background: "#FEF2F2", color: "#DC2626",
                              fontWeight: 600, fontSize: 11, cursor: "pointer",
                            }}
                          >
                            Clear
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
            )}

            {/* Connect Pipes button */}
            {canEdit && (() => {
              const sprinklerCount = detectors.filter(d => d.dtype === "sprinkler").length;
              if (sprinklerCount === 0) return null;
              return (
                <div style={{ padding: "6px 14px" }}>
                  <div style={{
                    padding: "10px 12px", borderRadius: 10,
                    background: "#FEF2F2", border: "1px solid rgba(220,38,38,0.2)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <div style={{ color: "#DC2626", flexShrink: 0 }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="2" y1="12" x2="22" y2="12" />
                          <polyline points="15 5 22 12 15 19" />
                        </svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A2E" }}>Sprinkler Pipelines</div>
                        <div style={{ fontSize: 11, color: "#6B7280", marginTop: 1 }}>
                          {pipesData?.pipes?.length ? `${pipesData.pipes.length} pipe segments connected` : `${sprinklerCount} sprinklers ready to connect`}
                        </div>
                      </div>
                    </div>

                    {/* Source selection panel (shown after detect) */}
                    {sourceSelectMode ? (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A2E", marginBottom: 4 }}>
                          Select Pipeline Source
                        </div>
                        <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 6 }}>
                          {detectedSources.length > 0
                            ? `${detectedSources.length} source(s) detected (highlighted on drawing). Click one to select, or click anywhere on the drawing to place a custom source.`
                            : "No sources detected in DXF. Click on the drawing to place a source manually."}
                        </div>
                        {detectedSources.map((src, i) => {
                          const isChosen = chosenSource && Math.abs(chosenSource.x - src.x) < 1 && Math.abs(chosenSource.y - src.y) < 1;
                          return (
                            <button
                              key={i}
                              onClick={() => setChosenSource(src)}
                              style={{
                                width: "100%", padding: "5px 8px", borderRadius: 6, marginBottom: 3,
                                border: isChosen ? "2px solid #16A34A" : "1px solid rgba(220,38,38,0.2)",
                                background: isChosen ? "rgba(22,163,74,0.08)" : "#fff",
                                color: isChosen ? "#16A34A" : "#374151",
                                fontWeight: isChosen ? 700 : 500, fontSize: 11, cursor: "pointer",
                                textAlign: "left",
                              }}
                            >
                              {isChosen ? "✓ " : ""}Source {i + 1} ({src.x.toFixed(0)}, {src.y.toFixed(0)})
                            </button>
                          );
                        })}
                        {chosenSource && !detectedSources.some(s => Math.abs(s.x - chosenSource.x) < 1 && Math.abs(s.y - chosenSource.y) < 1) && (
                          <div style={{ fontSize: 11, color: "#16A34A", fontWeight: 600, marginTop: 4 }}>
                            ✓ Custom source placed at ({chosenSource.x.toFixed(0)}, {chosenSource.y.toFixed(0)})
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                          <button
                            onClick={() => connectPipes(chosenSource)}
                            disabled={isConnectingPipes}
                            style={{
                              flex: 1, padding: "7px 10px", borderRadius: 8,
                              border: "none",
                              background: isConnectingPipes ? "#9CA3AF" : "#16A34A",
                              color: "#fff", fontWeight: 600, fontSize: 11,
                              cursor: isConnectingPipes ? "wait" : "pointer",
                              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                            }}
                          >
                            {isConnectingPipes ? (
                              <>
                                <div style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                                Routing...
                              </>
                            ) : (
                              <>{chosenSource ? "Route with Source" : "Route (auto)"}</>
                            )}
                          </button>
                          <button
                            onClick={() => { setSourceSelectMode(false); setDetectedSources([]); setChosenSource(null); }}
                            style={{
                              padding: "7px 10px", borderRadius: 8,
                              border: "1px solid rgba(220,38,38,0.2)",
                              background: "#fff", color: "#6B7280",
                              fontWeight: 600, fontSize: 11, cursor: "pointer",
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={startConnectPipes}
                        disabled={isConnectingPipes || isDetectingSources || !!isAutoPlacing}
                        style={{
                          width: "100%", padding: "7px 10px", borderRadius: 8,
                          border: "none",
                          background: (isConnectingPipes || isDetectingSources) ? "#9CA3AF" : "#DC2626",
                          color: "#fff", fontWeight: 600, fontSize: 11,
                          cursor: (isConnectingPipes || isDetectingSources || !!isAutoPlacing) ? "wait" : "pointer",
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                        }}
                      >
                        {isDetectingSources ? (
                          <>
                            <div style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                            Detecting Sources...
                          </>
                        ) : isConnectingPipes ? (
                          <>
                            <div style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                            Connecting...
                          </>
                        ) : (
                          <>{pipesData?.pipes?.length ? "Re-connect Pipes" : "Connect Pipes"}</>
                        )}
                      </button>
                    )}

                    {pipesData?.pipes?.length && !sourceSelectMode ? (
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <button
                          onClick={() => { setEditorMode("pipe_draw"); setSidebarTab("equipment"); }}
                          style={{
                            flex: 1, padding: "6px 10px", borderRadius: 8,
                            border: "1px solid rgba(220,38,38,0.2)",
                            background: editorMode === "pipe_draw" ? "rgba(220,38,38,0.12)" : "#FEF2F2",
                            color: "#DC2626", fontWeight: 600, fontSize: 11, cursor: "pointer",
                          }}
                        >
                          + Draw Pipe
                        </button>
                        <button
                          onClick={() => { setEditorMode("pipe_select"); setSidebarTab("equipment"); }}
                          style={{
                            flex: 1, padding: "6px 10px", borderRadius: 8,
                            border: "1px solid rgba(220,38,38,0.2)",
                            background: editorMode === "pipe_select" ? "rgba(220,38,38,0.12)" : "#FEF2F2",
                            color: "#DC2626", fontWeight: 600, fontSize: 11, cursor: "pointer",
                          }}
                        >
                          Select / Delete
                        </button>
                        <button
                          onClick={clearPipes}
                          style={{
                            padding: "6px 10px", borderRadius: 8,
                            border: "1px solid rgba(220,38,38,0.25)",
                            background: "#FFFFFF",
                            color: "#DC2626", fontWeight: 700, fontSize: 11, cursor: "pointer",
                          }}
                        >
                          Clear Pipes
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })()}

            {/* Equipment summary */}
            <div style={{ padding: "6px 14px" }}>
              {detectors.length === 0 ? (
                <div style={{ textAlign: "center", padding: "16px 0", color: "#9CA3AF", fontSize: 12 }}>
                  No equipment placed yet.
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#6B7280", padding: "4px 0" }}>
                  {detectors.length} total items placed
                </div>
              )}
            </div>
          </div>

        {editorMode === "measure" ? (
          <div style={{ padding: "0 14px 8px", fontSize: 12, color: "#6B7280", display: "flex", alignItems: "center", gap: 8 }}>
            Click first point, click second to lock. Click again to start a new measurement.
            {(measureStart || measureEnd) ? (
              <button
                onClick={() => { setMeasureStart(null); setMeasureEnd(null); setMeasureLocked(false); }}
                style={{ ...ceRoomBtn, padding: "4px 8px", fontSize: 11 }}
              >
                Clear Measure
              </button>
            ) : null}
          </div>
        ) : null}
        {(editorMode === "shape_rect" || editorMode === "shape_circle" || editorMode === "shape_cloud" || editorMode === "shape_select" || editorMode === "text_add") ? (
          <div style={{ padding: "0 14px 8px", fontSize: 12, color: "#6B7280", display: "flex", alignItems: "center", gap: 8 }}>
            {editorMode === "shape_select"
              ? "Drag shapes to move. Drag corner handles to resize."
              : editorMode === "text_add"
                ? "Click on drawing to place text."
                : editorMode === "shape_cloud"
                  ? "Click and drag to draw cloud outline stencil. Dimensions are shown while drawing."
                  : "Click and drag to draw shape. Dimensions are shown while drawing."}
            {(editorMode === "shape_select" && selectedShapeId) ? (
              <button
                onClick={() => { setShapes(prev => prev.filter(s => s.id !== selectedShapeId)); setSelectedShapeId(null); }}
                style={{ ...ceRoomBtn, padding: "4px 8px", fontSize: 11 }}
              >
                Delete Shape
              </button>
            ) : null}
            {(editorMode === "shape_select" && selectedShape?.kind === "text") ? (
              <>
                <button
                  onClick={editSelectedText}
                  style={{ ...ceRoomBtn, padding: "4px 8px", fontSize: 11 }}
                >
                  Edit Text
                </button>
                <button
                  onClick={() => changeSelectedTextSize(-2)}
                  style={{ ...ceRoomBtn, padding: "4px 8px", fontSize: 11 }}
                >
                  A-
                </button>
                <button
                  onClick={() => changeSelectedTextSize(2)}
                  style={{ ...ceRoomBtn, padding: "4px 8px", fontSize: 11 }}
                >
                  A+
                </button>
                <span style={{ fontSize: 11, color: "#4B5563" }}>{selectedShape.fontSize || 16}px</span>
              </>
            ) : null}
          </div>
        ) : null}

      </div>
    </div>
  );
}

const ceToolBtn = (active: boolean): CSSProperties => ({
  borderRadius: 8, border: active ? "1px solid #2D6A4F" : "1px solid #E8EAED",
  background: active ? "rgba(45,106,79,0.10)" : "#FFFFFF",
  color: active ? "#2D6A4F" : "#1A1A2E",
  height: 30, minWidth: 50, padding: "0 10px",
  cursor: "pointer", fontSize: 12, fontWeight: 600,
  display: "inline-flex", alignItems: "center", gap: 5,
});

const cePaintActionBtn: CSSProperties = {
  borderRadius: 8,
  border: "1px solid #D1D5DB",
  background: "#FFFFFF",
  color: "#1A1A2E",
  height: 30,
  minWidth: 70,
  padding: "0 10px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
};

const ceObjectBtn = (active: boolean): CSSProperties => ({
  borderRadius: 8, border: active ? "1px solid #2D6A4F" : "1px solid #E8EAED",
  background: active ? "rgba(45,106,79,0.10)" : "#FFFFFF",
  color: active ? "#2D6A4F" : "#1A1A2E",
  height: 30, minWidth: 70, padding: "0 8px",
  cursor: "pointer", fontWeight: 600,
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
});

const ceZoomBtn: CSSProperties = {
  borderRadius: 8, border: "1px solid #E8EAED",
  background: "#FFFFFF", color: "#1A1A2E",
  height: 30, minWidth: 34, padding: "0 10px",
  cursor: "pointer", fontSize: 13, fontWeight: 600,
};

const ceRoomBtn: CSSProperties = {
  padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600,
  background: "#FAFBFC", border: "1px solid #E8EAED",
  color: "#1A1A2E", cursor: "pointer",
};

const roomBtnStyle: CSSProperties = {
  padding: "4px 10px", borderRadius: 8, fontSize: 11, fontWeight: 600,
  background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)",
  color: "#D8F3DC", cursor: "pointer",
};



const styles: Record<string, CSSProperties> = {
  workspace: {
    height: "95vh",
    display: "grid",
    gridTemplateColumns: "380px 1fr",
    gridTemplateRows: "1fr",
    gap: "14px",
    padding: "14px",
    background: "#F0F2F5",
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
    background: "rgba(45, 106, 79, 0.04)",
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
    background: "rgba(82, 183, 136, 0.04)",
    filter: "blur(96px)",
    pointerEvents: "none"
  },
  sidebar: {
    zIndex: 1,
    borderRadius: "20px",
    border: "1px solid #E8EAED",
    background: "#FFFFFF",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
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
    color: "#9CA3AF",
    marginBottom: "4px"
  },
  projectTitle: {
    display: "block",
    fontSize: "18px",
    lineHeight: 1.25,
    color: "#1A1A2E"
  },
  statusRow: {
    marginTop: "10px",
    fontSize: "12px",
    color: "#6B7280",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px",
    borderRadius: "10px",
    background: "#FAFBFC",
    border: "1px solid #E8EAED"
  },
  statusValue: {
    fontWeight: 600,
    color: "#059669"
  },
  errorBox: {
    marginTop: "10px",
    whiteSpace: "pre-wrap",
    background: "#FEF2F2",
    border: "1px solid rgba(220,38,38,0.2)",
    color: "#DC2626",
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
    color: "#1A1A2E"
  },
  divider: {
    margin: "16px 0",
    border: 0,
    borderTop: "1px solid #E8EAED"
  },
  fieldLabel: {
    display: "block",
    fontSize: "12px",
    color: "#6B7280",
    marginBottom: "6px"
  },
  helpText: {
    fontSize: "12px",
    color: "#6B7280",
    lineHeight: 1.45
  },
  canvasPanel: {
    position: "relative",
    zIndex: 1,
    borderRadius: "20px",
    border: "1px solid #E8EAED",
    background: "#FFFFFF",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    overflow: "hidden",
    minHeight: 0
  },
  questionnaireCenterWrap: {
    zIndex: 1,
    minHeight: "calc(100vh - 28px)",
    display: "grid",
    placeItems: "center",
    padding: "24px"
  },
  questionnaireCard: {
    width: "min(680px, 100%)",
    borderRadius: "20px",
    border: "1px solid #E8EAED",
    background: "#FFFFFF",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    padding: "18px"
  },
  runningCard: {
    width: "min(620px, 100%)",
    borderRadius: "22px",
    border: "1px solid #E8EAED",
    background: "#FFFFFF",
    boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
    padding: "30px 22px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    position: "relative",
    overflow: "hidden",
    color: "#1A1A2E"
  },
  globalLoaderOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 30,
    background: "rgba(0, 0, 0, 0.3)",
    backdropFilter: "blur(4px)",
    display: "grid",
    placeItems: "center",
    pointerEvents: "all"
  },
  globalLoaderCard: {
    width: "min(320px, calc(100% - 32px))",
    borderRadius: "16px",
    border: "1px solid #E8EAED",
    background: "#FFFFFF",
    boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
    padding: "16px 18px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    color: "#1A1A2E"
  },
  emptyState: {
    height: "100%",
    display: "grid",
    placeItems: "center",
    textAlign: "center",
    color: "#6B7280",
    padding: "24px"
  },
  emptyTitle: {
    margin: 0,
    marginBottom: "6px",
    fontSize: "24px",
    color: "#1A1A2E"
  },
  emptySubtitle: {
    margin: 0,
    maxWidth: "520px",
    lineHeight: 1.5,
    color: "#9CA3AF"
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
  renderUrl, mapping, detectors: detectorsProp, projectId, isReady, pipesData: pipesProp, floorPlanId, exportDxfUrl, exportPngUrl, onSave, onChanged, worldToM = 0.001, canEdit = true,
}: {
  renderUrl: string;
  mapping: Mapping;
  detectors: Detector[];
  projectId: string;
  isReady: boolean;
  pipesData: PipesData | null;
  floorPlanId?: string | null;
  exportDxfUrl: string | null;
  exportPngUrl: string | null;
  onSave: ()=>void;
  onChanged: ()=>void;
  worldToM?: number;
  canEdit?: boolean;
}) {
  const [imgDims, setImgDims] = useState<{w:number;h:number}|null>(null);
  const readOnly = isReady;
  const [tool, setTool] = useState<"select"|"add"|"erase"|"pan"|"measure">(isReady ? "pan" : "select");
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
  const [measureStart, setMeasureStart] = useState<{px:number; py:number} | null>(null);
  const [measureEnd, setMeasureEnd] = useState<{px:number; py:number} | null>(null);
  const [measureLocked, setMeasureLocked] = useState(false);

  // Local mutable copies of detectors and pipes (client-side editing)
  const [detectors, setDetectors] = useState<Detector[]>(detectorsProp);
  const [pipesData, setPipesData] = useState<PipesData | null>(pipesProp);
  useEffect(() => { setDetectors(detectorsProp); }, [detectorsProp]);
  useEffect(() => { setPipesData(pipesProp); }, [pipesProp]);

  function onImageLoad(e: any) {
    const img = e.target as HTMLImageElement;
    setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
  }

  function addDetectorAt(px: number, py: number) {
    const w = pixelToWorld(mapping, px, py);
    setDetectors(prev => [...prev, {
      id: crypto.randomUUID(),
      project_id: projectId,
      x: w.x, y: w.y, z: 0,
      rotation_deg: 0,
      dtype: addType,
      locked: false,
      floor_plan_id: floorPlanId || null,
    }]);
  }
  async function saveEdits() {
    setIsSaving(true);
    try {
      const payload: any = {
        detectors: detectors.map(d => ({
          id: d.id, x: d.x, y: d.y, z: d.z,
          rotation_deg: d.rotation_deg ?? 0,
          dtype: d.dtype, locked: d.locked,
          floor_plan_id: d.floor_plan_id,
        })),
        pipes: pipesData || undefined,
        floor_plan_id: floorPlanId || undefined,
      };
      const res = await authFetch(`/api/projects/${projectId}/bulk_save`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.detectors) setDetectors(data.detectors);
      }
    } catch (e) { console.error("Save failed", e); }
    finally { setIsSaving(false); }
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

      // Save data first, then generate DXF via /save, then download
      await saveEdits();
      const saveResp = await authFetch(`/api/projects/${projectId}/save`, { method: "POST" });
      const saved = await saveResp.json();
      const freshUrl = saved?.files?.output_dxf ? apiUrl(saved.files.output_dxf) : exportDxfUrl;
      if (!freshUrl) return;
      await downloadFresh(freshUrl, `project_${projectId}_${Date.now()}.dxf`);
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

    // Draw sprinkler pipes
    if (pipesData?.pipes) {
      ctx.strokeStyle = "#DC2626";
      ctx.globalAlpha = 0.7;
      for (const pipe of pipesData.pipes) {
        const p1 = worldToPixel(mapping, pipe.from[0], pipe.from[1]);
        const p2 = worldToPixel(mapping, pipe.to[0], pipe.to[1]);
        ctx.lineWidth = pipeStrokeWidthPx(pipe.diameter);
        ctx.beginPath();
        ctx.moveTo(p1.px, p1.py);
        ctx.lineTo(p2.px, p2.py);
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;
    }
    if (pipesData?.sources) {
      for (const src of pipesData.sources) {
        const p = worldToPixel(mapping, src.x, src.y);
        ctx.fillStyle = "#B91C1C";
        ctx.globalAlpha = 0.85;
        ctx.fillRect(p.px - 7, p.py - 7, 14, 14);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(p.px - 4, p.py);
        ctx.lineTo(p.px + 4, p.py);
        ctx.moveTo(p.px, p.py - 4);
        ctx.lineTo(p.px, p.py + 4);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }
    }

    for (const d of detectors) {
      const p = worldToPixel(mapping, d.x, d.y);
      const rotationRad = ((d.rotation_deg ?? 0) * Math.PI) / 180;
      ctx.save();
      ctx.translate(p.px, p.py);
      ctx.rotate(rotationRad);
      drawPlacedObjectOnCanvas(ctx, d.dtype, 0, 0, mapping, worldToM);
      ctx.restore();
      if ((d.dtype || "").toLowerCase() !== "sprinkler") {
        ctx.beginPath();
        ctx.arc(p.px, p.py, 11, 0, Math.PI * 2);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
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


  function moveDetectorTo(detId: string, px: number, py: number) {
    const w = pixelToWorld(mapping, px, py);
    setDetectors(prev => prev.map(d => d.id === detId ? { ...d, x: w.x, y: w.y } : d));
  }

  function moveDetectorsToMany(nextPxById: Record<string, {px:number; py:number}>) {
    const entries = Object.entries(nextPxById);
    if (!entries.length) return;
    setDetectors(prev => prev.map(d => {
      const pt = nextPxById[d.id];
      if (!pt) return d;
      const w = pixelToWorld(mapping, pt.px, pt.py);
      return { ...d, x: w.x, y: w.y };
    }));
  }

  function rotateDetectorsMany(ids: string[], deltaDeg: number) {
    if (!ids.length || !canEdit) return;
    const idSet = new Set(ids);
    setDetectors(prev => prev.map(d => {
      if (!idSet.has(d.id)) return d;
      return { ...d, rotation_deg: normalizeAngleDeg((d.rotation_deg ?? 0) + deltaDeg) };
    }));
  }

  function deleteDetector(detId: string) {
    setDetectors(prev => prev.filter(d => d.id !== detId));
  }

  function deleteDetectorsMany(ids: string[]) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setDetectors(prev => prev.filter(d => !idSet.has(d.id)));
    setSelectedIds(prev => prev.filter(id => !idSet.has(id)));
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
    if (tool === "measure") return "crosshair";
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
                background: "rgba(9, 24, 14, 0.78)",
                backdropFilter: "blur(8px)"
              }}
            >
              {!readOnly && <button onClick={() => setTool("select")} style={toolBtn(tool === "select")}>Select</button>}
              {!readOnly && canEdit && <button onClick={() => setTool("add")} style={toolBtn(tool === "add")}>Add</button>}
              {!readOnly && canEdit && <button onClick={() => setTool("erase")} style={toolBtn(tool === "erase")}>Erase</button>}
              <button onClick={() => setTool("pan")} style={toolBtn(tool === "pan")}>Pan</button>
              <button onClick={() => setTool("measure")} style={toolBtn(tool === "measure")}>Measure</button>
              {tool === "measure" && (measureStart || measureEnd) ? (
                <button onClick={() => { setMeasureStart(null); setMeasureEnd(null); setMeasureLocked(false); }} style={toolBtn(false)}>Clear Measure</button>
              ) : null}
              {!readOnly && canEdit && (
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
              )}
              {!readOnly && (
              <>
                <span style={{ fontSize: 12, color: "#D8F3DC", marginLeft: 2 }}>
                  Selected: {selectedIds.length}
                </span>
                {selectedIds.length > 0 ? (
                  <>
                    {canEdit && <button onClick={() => rotateDetectorsMany(selectedIds, -15)} style={toolBtn(false)}>Rotate -15°</button>}
                    {canEdit && <button onClick={() => rotateDetectorsMany(selectedIds, 15)} style={toolBtn(false)}>Rotate +15°</button>}
                    {canEdit && <button onClick={() => deleteDetectorsMany(selectedIds)} style={{ ...toolBtn(false), color: "#FF6B6B" }}>Delete Selected</button>}
                    <button onClick={() => setSelectedIds([])} style={toolBtn(false)}>Clear</button>
                  </>
                ) : null}
              </>
              )}
              {isReady && canEdit ? (
                <>
                  {exportDxfUrl ? (
                    <button
                      onClick={() => exportLatest("dxf")}
                      disabled={isExporting !== null}
                      style={{ ...toolBtn(false), textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    >
                      {isExporting === "dxf" ? "Exporting DXF..." : "Export DXF"}
                    </button>
                  ) : null}
                  {exportPngUrl ? (
                    <button
                      onClick={() => exportLatest("png")}
                      disabled={isExporting !== null}
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
                background: "rgba(9, 24, 14, 0.78)",
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
              <span style={{ fontSize: 12, color: "#D8F3DC", minWidth: 44, textAlign: "right" }}>
                {Math.round(transformState.scale * 100)}%
              </span>
            </div>

            <TransformComponent
              wrapperStyle={{
                width:"100%",
                height:"100%",
                borderRadius: "14px",
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(4, 18, 10, 0.48)"
              }}
            >
              <div style={{ position:"relative", display:"inline-block" }}>
                <img src={renderUrl} onLoad={onImageLoad} style={{ display:"block", userSelect:"none", pointerEvents:"none", borderRadius: "8px" }} />

                {imgDims ? (
                  <svg
                    width={imgDims.w}
                    height={imgDims.h}
                    viewBox={`0 0 ${imgDims.w} ${imgDims.h}`}
                    style={{ position:"absolute", left:0, top:0, cursor: readOnly ? "default" : canvasCursor() }}
                    onMouseDown={(e)=> {
                      const point = toImagePoint(e);
                      if (!point) return;
                      const { px, py } = point;
                      if (tool === "measure") {
                        if (!measureStart || measureLocked) {
                          setMeasureStart({ px, py });
                          setMeasureEnd({ px, py });
                          setMeasureLocked(false);
                        } else {
                          setMeasureEnd({ px, py });
                          setMeasureLocked(true);
                        }
                        return;
                      }
                      if (readOnly) return;
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
                        if (canEdit) addDetectorAt(px, py);
                        return;
                      }
                      if (tool === "erase") {
                        if (id) { if (canEdit) deleteDetector(id); }
                        else { setMarquee({ sx: px, sy: py, ex: px, ey: py }); }
                        return;
                      }
                    }}
                    onMouseMove={(e)=> {
                      const point = toImagePoint(e);
                      if (!point) return;
                      if (tool === "measure") {
                        if (measureStart && !measureLocked) setMeasureEnd(point);
                        return;
                      }
                      if (readOnly) return;
                      setHoverPoint(point);
                      if (tool !== "select" && tool !== "erase") return;
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
                      if (tool === "measure") return;
                      if (readOnly) return;
                      if (tool !== "select" && tool !== "erase") return;
                      if (marquee) {
                        const p1 = { px: marquee.sx, py: marquee.sy };
                        const p2 = { px: marquee.ex, py: marquee.ey };
                        const rect = rectFromPoints(p1, p2);
                        if (tool === "erase" && canEdit) {
                          deleteDetectorsMany(idsInRect(rect));
                        } else {
                          setSelectedIds(idsInRect(rect));
                        }
                        setMarquee(null);
                        return;
                      }
                      if (!groupDrag || !groupPreview) return;
                      moveDetectorsToMany(groupPreview);
                      setGroupDrag(null);
                      setGroupPreview(null);
                    }}
                    onMouseLeave={()=> {
                      setHoverPoint(null);
                      if (marquee) setMarquee(null);
                      if (groupDrag) setGroupDrag(null);
                      if (groupPreview) setGroupPreview(null);
                    }}
                    onContextMenu={(e)=> {
                      e.preventDefault();
                      if (readOnly || !canEdit) return;
                    }}
                  >
                    {/* Sprinkler pipes */}
                    {pipesData?.pipes?.map((pipe, i) => {
                      const p1 = worldToPixel(mapping, pipe.from[0], pipe.from[1]);
                      const p2 = worldToPixel(mapping, pipe.to[0], pipe.to[1]);
                      return (
                        <line key={`pipe-${i}`} x1={p1.px} y1={p1.py} x2={p2.px} y2={p2.py}
                          stroke="#DC2626" strokeWidth={pipeStrokeWidthPx(pipe.diameter)} opacity={0.7} />
                      );
                    })}
                    {pipesData?.sources?.map((src, i) => {
                      const p = worldToPixel(mapping, src.x, src.y);
                      return (
                        <g key={`src-${i}`}>
                          <rect x={p.px - 7} y={p.py - 7} width={14} height={14} rx={2} fill="#B91C1C" opacity={0.85} />
                          <line x1={p.px - 4} y1={p.py} x2={p.px + 4} y2={p.py} stroke="#fff" strokeWidth={1.8} />
                          <line x1={p.px} y1={p.py - 4} x2={p.px} y2={p.py + 4} stroke="#fff" strokeWidth={1.8} />
                        </g>
                      );
                    })}
                    {detectors.map((d)=> {
                      const p = groupPreview?.[d.id] || worldToPixel(mapping, d.x, d.y);
                      const isSelected = selectedIds.includes(d.id);
                      const isSprinkler = (d.dtype || "").toLowerCase() === "sprinkler";
                      const rotationDeg = d.rotation_deg ?? 0;
                      return (
                        <g key={d.id}>
                          {isSelected ? (
                            <>
                              <circle cx={p.px} cy={p.py} r={16} fill="rgba(255, 229, 143, 0.20)" />
                              <circle cx={p.px} cy={p.py} r={15} fill="none" stroke="#ffe58f" strokeWidth={3} strokeDasharray="6 4" />
                            </>
                          ) : null}
                          <g transform={`rotate(${rotationDeg} ${p.px} ${p.py})`}>
                            {renderPlacedObject(d.dtype, p.px, p.py, mapping, worldToM)}
                          </g>
                          {!isSprinkler ? <circle cx={p.px} cy={p.py} r={11} fill="none" stroke={isSelected ? "#ffe58f" : "#ffffff"} strokeWidth={isSelected ? 3 : 2} /> : null}
                          {isSelected ? (
                            <circle cx={p.px} cy={p.py} r={3} fill="#fff7d1" />
                          ) : null}
                        </g>
                      );
                    })}
                    {marquee ? (() => {
                      const rect = rectFromPoints({ px: marquee.sx, py: marquee.sy }, { px: marquee.ex, py: marquee.ey });
                      const isEraseMarquee = tool === "erase";
                      return (
                        <rect
                          x={rect.left}
                          y={rect.top}
                          width={Math.max(1, rect.right - rect.left)}
                          height={Math.max(1, rect.bottom - rect.top)}
                          fill={isEraseMarquee ? "rgba(220,38,38,0.15)" : "rgba(82, 183, 136, 0.15)"}
                          stroke={isEraseMarquee ? "#DC2626" : "#52B788"}
                          strokeWidth={2}
                          strokeDasharray="6 4"
                        />
                      );
                    })() : null}
                    {tool === "add" && hoverPoint ? (
                      <g>
                        <circle cx={hoverPoint.px} cy={hoverPoint.py} r={13} fill="none" stroke="#52B788" strokeWidth={2} strokeDasharray="5 4" />
                        <line x1={hoverPoint.px - 9} y1={hoverPoint.py} x2={hoverPoint.px + 9} y2={hoverPoint.py} stroke="#52B788" strokeWidth={2} />
                        <line x1={hoverPoint.px} y1={hoverPoint.py - 9} x2={hoverPoint.px} y2={hoverPoint.py + 9} stroke="#52B788" strokeWidth={2} />
                      </g>
                    ) : null}

                    {measureStart && measureEnd ? (() => {
                      const worldA = pixelToWorld(mapping, measureStart.px, measureStart.py);
                      const worldB = pixelToWorld(mapping, measureEnd.px, measureEnd.py);
                      const dWorld = Math.hypot(worldB.x - worldA.x, worldB.y - worldA.y);
                        const dMeters = dWorld * worldToM;
                      const midX = (measureStart.px + measureEnd.px) * 0.5;
                      const midY = (measureStart.py + measureEnd.py) * 0.5;
                      return (
                        <g style={{ pointerEvents: "none" }}>
                          <line
                            x1={measureStart.px}
                            y1={measureStart.py}
                            x2={measureEnd.px}
                            y2={measureEnd.py}
                            stroke="#2563EB"
                            strokeWidth={2.5}
                            strokeDasharray="8 4"
                          />
                          <circle cx={measureStart.px} cy={measureStart.py} r={5} fill="#DBEAFE" stroke="#2563EB" strokeWidth={2} />
                          <circle cx={measureEnd.px} cy={measureEnd.py} r={5} fill="#DBEAFE" stroke="#2563EB" strokeWidth={2} />
                          <rect x={midX - 60} y={midY - 24} width={120} height={22} rx={8} fill="rgba(37,99,235,0.92)" />
                          <text x={midX} y={midY - 9} textAnchor="middle" fill="#ffffff" fontSize={12} fontWeight={700}>
                            {`${dMeters.toFixed(2)} m`}
                          </text>
                        </g>
                      );
                    })() : null}
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
  background: "rgba(18, 35, 24, 0.9)",
  color: "#F0FFF4",
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
    border: active ? "1px solid rgba(82, 183, 136, 0.82)" : "1px solid rgba(255,255,255,0.2)",
    background: active ? "linear-gradient(180deg, #40916C 0%, #2D6A4F 100%)" : "rgba(18, 35, 24, 0.9)",
    color: "#F0FFF4",
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
  if (key === "sprinkler") return "#DC2626";
  if (key === "fire_hose") return "#DC2626";
  if (key === "internal_hydrant") return "#D946EF";
  if (key === "beam_detector") return "#FF00CC";
  if (key === "reflector") return "#2563EB";
  return "#ff5a7e";
}

function scaledDeviceRadiusPx(mapping: Mapping, worldToM: number, cx: number, cy: number, fallbackPx: number, radiusMeters = 0.02) {
  if (!Number.isFinite(worldToM) || worldToM <= 0) return fallbackPx;
  const radiusWorld = radiusMeters / worldToM;
  if (!Number.isFinite(radiusWorld) || radiusWorld <= 0) return fallbackPx;

  const centerWorld = pixelToWorld(mapping, cx, cy);
  const edgePx = worldToPixel(mapping, centerWorld.x + radiusWorld, centerWorld.y);
  const radiusPx = Math.hypot(edgePx.px - cx, edgePx.py - cy);
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) return fallbackPx;
  return radiusPx;
}

function renderPlacedObject(dtype: string, cx: number, cy: number, mapping: Mapping, worldToM: number) {
  const key = (dtype || "").toLowerCase();

  if (key === "panel") {
    return (
      <>
        <rect x={cx - 14} y={cy - 8} width={28} height={16} rx={1.5} fill="none" stroke="#1A7A3A" strokeWidth={1.8} />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#1A7A3A" style={{ pointerEvents: "none" }}>FACP</text>
      </>
    );
  }

  if (key === "hooter") {
    return (
      <>
        {/* base */}
        <rect x={cx - 10} y={cy + 4} width={20} height={4} rx={1.5} fill="#F9A8A8" />
        <rect x={cx - 8} y={cy + 1} width={16} height={4} rx={1} fill="#F9A8A8" />
        {/* dome */}
        <path d={`M ${cx - 6} ${cy + 1} Q ${cx - 6} ${cy - 7} ${cx} ${cy - 8} Q ${cx + 6} ${cy - 7} ${cx + 6} ${cy + 1} Z`} fill="#EF5350" />
        {/* rays */}
        <line x1={cx} y1={cy - 10} x2={cx} y2={cy - 14} stroke="#F9A8A8" strokeWidth={2} strokeLinecap="round" />
        <line x1={cx - 5} y1={cy - 9} x2={cx - 7} y2={cy - 12} stroke="#F9A8A8" strokeWidth={1.6} strokeLinecap="round" />
        <line x1={cx + 5} y1={cy - 9} x2={cx + 7} y2={cy - 12} stroke="#F9A8A8" strokeWidth={1.6} strokeLinecap="round" />
        <line x1={cx - 8} y1={cy - 5} x2={cx - 11} y2={cy - 7} stroke="#F9A8A8" strokeWidth={1.4} strokeLinecap="round" />
        <line x1={cx + 8} y1={cy - 5} x2={cx + 11} y2={cy - 7} stroke="#F9A8A8" strokeWidth={1.4} strokeLinecap="round" />
      </>
    );
  }

  if (key === "mcb") {
    return (
      <>
        <rect x={cx - 9} y={cy - 9} width={18} height={18} rx={1.5} fill="none" stroke="#1A7A3A" strokeWidth={1.8} />
        <circle cx={cx} cy={cy} r={3.5} fill="#2563EB" />
      </>
    );
  }

  if (key === "sprinkler") {
    const radiusPx = Math.max(4, scaledDeviceRadiusPx(mapping, worldToM, cx, cy, 9, 0.01));
    const arm = Math.max(2.8, radiusPx * 0.67);
    const strokeW = Math.max(1.2, Math.min(2.2, radiusPx * 0.4));
    const haloW = strokeW + 1.4;
    return (
      <>
        <line x1={cx - arm} y1={cy} x2={cx + arm} y2={cy} stroke="#FFFFFF" strokeOpacity={0.96} strokeWidth={haloW} strokeLinecap="round" />
        <line x1={cx} y1={cy - arm} x2={cx} y2={cy + arm} stroke="#FFFFFF" strokeOpacity={0.96} strokeWidth={haloW} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={radiusPx} fill="none" stroke="#DC2626" strokeWidth={strokeW} />
        <line x1={cx - arm} y1={cy} x2={cx + arm} y2={cy} stroke="#DC2626" strokeWidth={strokeW} strokeLinecap="round" />
        <line x1={cx} y1={cy - arm} x2={cx} y2={cy + arm} stroke="#DC2626" strokeWidth={strokeW} strokeLinecap="round" />
      </>
    );
  }

  if (key === "fire_hose") {
    return (
      <>
        <rect x={cx - 16} y={cy - 3.4} width={9} height={6.8} fill="none" stroke="#DC2626" strokeWidth={2.1} />
        <line x1={cx - 15.8} y1={cy} x2={cx - 3.8} y2={cy} stroke="#FFFFFF" strokeWidth={1.4} strokeOpacity={0.92} />
        <rect x={cx - 9.5} y={cy - 8.4} width={4.8} height={16.8} fill="#DC2626" />
        <circle cx={cx - 1.8} cy={cy} r={6.2} fill="none" stroke="#DC2626" strokeWidth={2.1} />
        <path d={`M ${cx - 8} ${cy} C ${cx - 4.6} ${cy - 2.8}, ${cx + 1.6} ${cy + 2.8}, ${cx + 6.8} ${cy}`} fill="none" stroke="#DC2626" strokeWidth={1.8} strokeLinecap="round" />
        <path d={`M ${cx + 7.6} ${cy - 4.8} Q ${cx + 9.4} ${cy} ${cx + 7.6} ${cy + 4.8}`} fill="none" stroke="#DC2626" strokeWidth={2.1} strokeLinecap="round" />
        <line x1={cx + 9.6} y1={cy - 4.2} x2={cx + 9.6} y2={cy + 4.2} stroke="#DC2626" strokeWidth={2.1} strokeLinecap="round" />
      </>
    );
  }

  if (key === "internal_hydrant") {
    return (
      <>
        <rect x={cx - 14} y={cy - 9} width={28} height={18} fill="none" stroke="#D946EF" strokeWidth={2.1} />
        <polygon points={`${cx - 13.2},${cy + 8.2} ${cx - 13.2},${cy - 7.8} ${cx + 9.8},${cy + 8.2}`} fill="#E879F9" fillOpacity={0.95} />
        <polyline points={`${cx - 7.8},${cy - 4.2} ${cx - 3.9},${cy - 1.8} ${cx + 0.1},${cy + 0.6} ${cx + 4.1},${cy + 3} ${cx + 8.1},${cy + 5.4}`} fill="none" stroke="#B91CFF" strokeWidth={1.4} strokeLinecap="square" strokeLinejoin="miter" />
      </>
    );
  }

  if (key === "beam_detector") {
    return (
      <>
        <rect x={cx - 18} y={cy - 10} width={36} height={20} fill="none" stroke="#FF00CC" strokeWidth={1.8} />
        <path d={`M ${cx - 15} ${cy + 10} L ${cx} ${cy + 2} L ${cx + 15} ${cy + 10}`} fill="none" stroke="#FF00CC" strokeWidth={1.4} />
        <line x1={cx - 12} y1={cy + 10} x2={cx - 5} y2={cy + 6} stroke="#FF00CC" strokeWidth={1} />
        <line x1={cx - 8} y1={cy + 10} x2={cx - 1} y2={cy + 6} stroke="#FF00CC" strokeWidth={1} />
        <line x1={cx - 4} y1={cy + 10} x2={cx + 3} y2={cy + 6} stroke="#FF00CC" strokeWidth={1} />
        <line x1={cx} y1={cy + 10} x2={cx + 7} y2={cy + 6} stroke="#FF00CC" strokeWidth={1} />
        <line x1={cx + 4} y1={cy + 10} x2={cx + 11} y2={cy + 6} stroke="#FF00CC" strokeWidth={1} />
        <text x={cx} y={cy - 1} textAnchor="middle" fontSize={11} fontWeight={700} fill="#FF00CC">B</text>
      </>
    );
  }

  if (key === "reflector") {
    return (
      <>
        <rect x={cx - 16} y={cy - 8} width={32} height={16} fill="none" stroke="#2563EB" strokeWidth={1.8} />
        <path d={`M ${cx - 14} ${cy + 8} L ${cx} ${cy + 2} L ${cx + 14} ${cy + 8}`} fill="none" stroke="#2563EB" strokeWidth={1.4} />
        <line x1={cx} y1={cy + 2} x2={cx} y2={cy + 8} stroke="#2563EB" strokeWidth={1.2} />
        <text x={cx} y={cy - 1} textAnchor="middle" fontSize={11} fontWeight={700} fill="#2563EB">R</text>
      </>
    );
  }

  if (key === "smoke" || key === "heat") {
    const radiusPx = scaledDeviceRadiusPx(mapping, worldToM, cx, cy, 9);
    return (
      <>
        <circle cx={cx} cy={cy} r={radiusPx} fill="none" stroke="#ff5a7e" strokeWidth={2.2} />
        <text x={cx} y={cy + 3} textAnchor="middle" fontSize={10} fontWeight={700} fill="#ff5a7e">S</text>
      </>
    );
  }

  return (
    <>
      <circle cx={cx} cy={cy} r={9} fill="none" stroke="#ff5a7e" strokeWidth={2.2} />
      <text x={cx} y={cy + 3} textAnchor="middle" fontSize={10} fontWeight={700} fill="#ff5a7e">S</text>
    </>
  );
}

function drawPlacedObjectOnCanvas(ctx: CanvasRenderingContext2D, dtype: string, cx: number, cy: number, mapping: Mapping, worldToM: number) {
  const key = (dtype || "").toLowerCase();

  if (key === "panel") {
    ctx.strokeStyle = "#1A7A3A";
    ctx.lineWidth = 1.8;
    ctx.strokeRect(cx - 14, cy - 8, 28, 16);
    ctx.fillStyle = "#1A7A3A";
    ctx.font = "700 9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("FACP", cx, cy);
    return;
  }

  if (key === "hooter") {
    // base
    ctx.fillStyle = "#F9A8A8";
    ctx.beginPath();
    ctx.roundRect(cx - 10, cy + 4, 20, 4, 1.5);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(cx - 8, cy + 1, 16, 4, 1);
    ctx.fill();
    // dome
    ctx.fillStyle = "#EF5350";
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy + 1);
    ctx.quadraticCurveTo(cx - 6, cy - 7, cx, cy - 8);
    ctx.quadraticCurveTo(cx + 6, cy - 7, cx + 6, cy + 1);
    ctx.closePath();
    ctx.fill();
    // rays
    ctx.lineCap = "round";
    ctx.strokeStyle = "#F9A8A8";
    const rays: [number,number,number,number,number][] = [
      [cx, cy-10, cx, cy-14, 2],
      [cx-5, cy-9, cx-7, cy-12, 1.6],
      [cx+5, cy-9, cx+7, cy-12, 1.6],
      [cx-8, cy-5, cx-11, cy-7, 1.4],
      [cx+8, cy-5, cx+11, cy-7, 1.4],
    ];
    for (const [x1,y1,x2,y2,w] of rays) {
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    return;
  }

  if (key === "mcb") {
    ctx.strokeStyle = "#1A7A3A";
    ctx.lineWidth = 1.8;
    ctx.strokeRect(cx - 9, cy - 9, 18, 18);
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "#2563EB";
    ctx.fill();
    return;
  }

  if (key === "sprinkler") {
    const radiusPx = Math.max(4, scaledDeviceRadiusPx(mapping, worldToM, cx, cy, 9, 0.01));
    const arm = Math.max(2.8, radiusPx * 0.67);
    const strokeW = Math.max(1.2, Math.min(2.2, radiusPx * 0.4));
    const haloW = strokeW + 1.4;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy);
    ctx.lineTo(cx + arm, cy);
    ctx.moveTo(cx, cy - arm);
    ctx.lineTo(cx, cy + arm);
    ctx.strokeStyle = "rgba(255,255,255,0.96)";
    ctx.lineWidth = haloW;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
    ctx.strokeStyle = "#DC2626";
    ctx.lineWidth = strokeW;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy);
    ctx.lineTo(cx + arm, cy);
    ctx.moveTo(cx, cy - arm);
    ctx.lineTo(cx, cy + arm);
    ctx.strokeStyle = "#DC2626";
    ctx.lineWidth = strokeW;
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (key === "fire_hose") {
    ctx.save();
    ctx.strokeStyle = "#DC2626";
    ctx.lineWidth = 2.1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.strokeRect(cx - 16, cy - 3.4, 9, 6.8);
    ctx.beginPath();
    ctx.moveTo(cx - 15.8, cy);
    ctx.lineTo(cx - 3.8, cy);
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.fillStyle = "#DC2626";
    ctx.fillRect(cx - 9.5, cy - 8.4, 4.8, 16.8);

    ctx.strokeStyle = "#DC2626";
    ctx.lineWidth = 2.1;
    ctx.beginPath();
    ctx.arc(cx - 1.8, cy, 6.2, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - 8, cy);
    ctx.bezierCurveTo(cx - 4.6, cy - 2.8, cx + 1.6, cy + 2.8, cx + 6.8, cy);
    ctx.lineWidth = 1.8;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx + 7.6, cy - 4.8);
    ctx.lineWidth = 2.1;
    ctx.quadraticCurveTo(cx + 9.4, cy, cx + 7.6, cy + 4.8);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx + 9.6, cy - 4.2);
    ctx.lineTo(cx + 9.6, cy + 4.2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (key === "internal_hydrant") {
    ctx.save();
    ctx.strokeStyle = "#D946EF";
    ctx.lineWidth = 2.1;
    ctx.strokeRect(cx - 14, cy - 9, 28, 18);

    ctx.fillStyle = "rgba(232,121,249,0.95)";
    ctx.beginPath();
    ctx.moveTo(cx - 13.2, cy + 8.2);
    ctx.lineTo(cx - 13.2, cy - 7.8);
    ctx.lineTo(cx + 9.8, cy + 8.2);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "#B91CFF";
    ctx.lineWidth = 1.4;
    ctx.lineCap = "square";
    ctx.lineJoin = "miter";
    ctx.beginPath();
    ctx.moveTo(cx - 7.8, cy - 4.2);
    ctx.lineTo(cx - 3.9, cy - 1.8);
    ctx.lineTo(cx + 0.1, cy + 0.6);
    ctx.lineTo(cx + 4.1, cy + 3);
    ctx.lineTo(cx + 8.1, cy + 5.4);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (key === "beam_detector") {
    ctx.strokeStyle = "#FF00CC";
    ctx.lineWidth = 1.8;
    ctx.strokeRect(cx - 18, cy - 10, 36, 20);

    ctx.beginPath();
    ctx.moveTo(cx - 15, cy + 10);
    ctx.lineTo(cx, cy + 2);
    ctx.lineTo(cx + 15, cy + 10);
    ctx.strokeStyle = "#FF00CC";
    ctx.lineWidth = 1.4;
    ctx.stroke();

    const hatch: [number, number, number, number][] = [
      [cx - 12, cy + 10, cx - 5, cy + 6],
      [cx - 8, cy + 10, cx - 1, cy + 6],
      [cx - 4, cy + 10, cx + 3, cy + 6],
      [cx, cy + 10, cx + 7, cy + 6],
      [cx + 4, cy + 10, cx + 11, cy + 6],
    ];
    ctx.strokeStyle = "#FF00CC";
    ctx.lineWidth = 1;
    for (const [x1, y1, x2, y2] of hatch) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.fillStyle = "#FF00CC";
    ctx.font = "700 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("B", cx, cy - 1);
    return;
  }

  if (key === "reflector") {
    ctx.strokeStyle = "#2563EB";
    ctx.lineWidth = 1.8;
    ctx.strokeRect(cx - 16, cy - 8, 32, 16);

    ctx.beginPath();
    ctx.moveTo(cx - 14, cy + 8);
    ctx.lineTo(cx, cy + 2);
    ctx.lineTo(cx + 14, cy + 8);
    ctx.strokeStyle = "#2563EB";
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx, cy + 2);
    ctx.lineTo(cx, cy + 8);
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = "#2563EB";
    ctx.font = "700 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("R", cx, cy - 1);
    return;
  }

  if (key === "smoke" || key === "heat") {
    const radiusPx = scaledDeviceRadiusPx(mapping, worldToM, cx, cy, 9);
    ctx.beginPath();
    ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
    ctx.strokeStyle = "#ff5a7e";
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.fillStyle = "#ff5a7e";
    ctx.font = "700 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("S", cx, cy + 0.5);
    return;
  }

  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.strokeStyle = "#ff5a7e";
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.fillStyle = "#ff5a7e";
  ctx.font = "700 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("S", cx, cy + 0.5);
}

function objectLabel(dtype: ObjectType): string {
  if (dtype === "mcb") return "MCP";
  if (dtype === "panel") return "FACP";
  if (dtype === "sprinkler") return "Sprinkler";
  if (dtype === "fire_hose") return "External Hydrant";
  if (dtype === "internal_hydrant") return "Internal Hydrant";
  if (dtype === "beam_detector") return "Beam Det.";
  if (dtype === "reflector") return "Reflector";
  return dtype.charAt(0).toUpperCase() + dtype.slice(1);
}

function objectToolBtn(active: boolean): CSSProperties {
  return {
    borderRadius: 10,
    border: active ? "1px solid rgba(82, 183, 136, 0.82)" : "1px solid rgba(255,255,255,0.2)",
    background: active ? "linear-gradient(180deg, #40916C 0%, #2D6A4F 100%)" : "rgba(18, 35, 24, 0.9)",
    color: "#F0FFF4",
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
      <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden>
        <rect x="1" y="2" width="16" height="10" rx="1" fill="none" stroke="#fff" strokeWidth="1.2" />
        <text x="9" y="9" textAnchor="middle" fontSize="5" fontWeight="700" fill="#fff">FACP</text>
      </svg>
    );
  }
  if (dtype === "hooter") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <rect x="3" y="11" width="10" height="2.2" rx="1" fill="#F9A8A8" />
        <rect x="4" y="9" width="8" height="2.5" rx="0.8" fill="#F9A8A8" />
        <path d="M5 9 Q5 4 8 3.5 Q11 4 11 9 Z" fill="#EF5350" />
        <line x1="8" y1="2" x2="8" y2="0.5" stroke="#F9A8A8" strokeWidth="1.2" strokeLinecap="round" />
        <line x1="5.5" y1="2.8" x2="4.5" y2="1.4" stroke="#F9A8A8" strokeWidth="1" strokeLinecap="round" />
        <line x1="10.5" y1="2.8" x2="11.5" y2="1.4" stroke="#F9A8A8" strokeWidth="1" strokeLinecap="round" />
      </svg>
    );
  }
  if (dtype === "mcb") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <rect x="2" y="2" width="10" height="10" rx="1" fill="none" stroke="#fff" strokeWidth="1.2" />
        <circle cx="7" cy="7" r="2.2" fill="#60A5FA" />
      </svg>
    );
  }
  if (dtype === "sprinkler") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="4.2" fill="none" stroke="#DC2626" strokeWidth="1.2" />
        <line x1="4.2" y1="7" x2="9.8" y2="7" stroke="#DC2626" strokeWidth="1.2" />
        <line x1="7" y1="4.2" x2="7" y2="9.8" stroke="#DC2626" strokeWidth="1.2" />
      </svg>
    );
  }

  if (dtype === "fire_hose") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <rect x="0.8" y="6.1" width="4.8" height="3.8" fill="none" stroke="#EF4444" strokeWidth="1.4" />
        <line x1="1" y1="8" x2="6.8" y2="8" stroke="#FFFFFF" strokeWidth="1" opacity="0.9" />
        <rect x="4.6" y="3.6" width="2.4" height="8.8" fill="#EF4444" />
        <circle cx="8.5" cy="8" r="3.2" fill="none" stroke="#EF4444" strokeWidth="1.4" />
        <path d="M5.3 8 C 6.8 6.8, 9.3 9.2, 11.1 8" fill="none" stroke="#EF4444" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M12.9 5.8 Q14 8 12.9 10.2" fill="none" stroke="#EF4444" strokeWidth="1.4" strokeLinecap="round" />
        <line x1="14.3" y1="6.2" x2="14.3" y2="9.8" stroke="#EF4444" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }

  if (dtype === "internal_hydrant") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <rect x="1.1" y="2" width="13.8" height="12" fill="none" stroke="#E879F9" strokeWidth="1.4" />
        <polygon points="1.8,13.2 1.8,3.2 12.9,13.2" fill="#D946EF" />
        <polyline points="4.5,5.5 6.3,6.6 8.2,7.7 10.1,8.8 12,9.9" fill="none" stroke="#A21CAF" strokeWidth="0.9" strokeLinecap="square" strokeLinejoin="miter" />
      </svg>
    );
  }

  if (dtype === "beam_detector") {
    return (
      <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden>
        <rect x="1.2" y="1" width="15.6" height="12" fill="none" stroke="#FF00CC" strokeWidth="1.2" />
        <path d="M2.3 13 L9 8.8 L15.7 13" fill="none" stroke="#FF00CC" strokeWidth="1" />
        <text x="9" y="7.2" textAnchor="middle" fontSize="5" fontWeight="700" fill="#FF00CC">B</text>
      </svg>
    );
  }

  if (dtype === "reflector") {
    return (
      <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden>
        <rect x="1.2" y="1.6" width="15.6" height="10.8" fill="none" stroke="#2563EB" strokeWidth="1.2" />
        <path d="M2.5 12.2 L9 8.8 L15.5 12.2" fill="none" stroke="#2563EB" strokeWidth="1" />
        <line x1="9" y1="8.8" x2="9" y2="12.2" stroke="#2563EB" strokeWidth="1" />
        <text x="9" y="7" textAnchor="middle" fontSize="5" fontWeight="700" fill="#2563EB">R</text>
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="4.2" fill="none" stroke="#ff5a7e" strokeWidth="1.2" />
      <text x="7" y="9" textAnchor="middle" fontSize="5" fontWeight="700" fill="#ff5a7e">S</text>
    </svg>
  );
}
