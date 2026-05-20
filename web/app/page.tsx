"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { clearAuth, getName, getTenantName, getTenantRole, apiFetch, apiUpload } from "./lib/auth";
import { useRouter } from "next/navigation";

/* ── types ─────────────────────────────────── */

type Project = {
  id: string;
  name: string;
  status: string;
  error?: string | null;
  nbc_evaluation?: any;
};

type BOQMetaLite = {
  quote_number?: string | null;
  quote_title?: string | null;
  client_name?: string | null;
  valid_until?: string | null;
};

type NBCQuestion = {
  id: string;
  type: "select" | "number" | "boolean";
  label: string;
  options?: string[];
};

type NBCEquipment = {
  key: string;
  label: string;
  required: boolean;
  supported: boolean;
  notes: string[];
};

type NavKey =
  | "dashboard"
  | "projects"
  | "quotes"
  | "calendar"
  | "analytics"
  | "billing"
  | "team"
  | "settings"
  | "help";

type IconName =
  | "dashboard"
  | "projects"
  | "tasks"
  | "calendar"
  | "analytics"
  | "billing"
  | "team"
  | "settings"
  | "help"
  | "logout"
  | "search"
  | "bell"
  | "box"
  | "check"
  | "clock"
  | "alert"
  | "plus"
  | "download"
  | "chevronRight"
  | "play"
  | "pause"
  | "creditCard"
  | "receipt"
  | "wallet";

const NAV_MAIN: Array<{ key: NavKey; label: string; icon: IconName }> = [
  { key: "dashboard", label: "Dashboard", icon: "dashboard" },
  { key: "projects", label: "Projects", icon: "projects" },
  { key: "quotes", label: "Quotes / BOQ", icon: "receipt" },
  { key: "team", label: "Team", icon: "team" },
];

const NAV_BOTTOM: Array<{ key: NavKey | "logout"; label: string; icon: IconName }> = [
  { key: "settings", label: "Settings", icon: "settings" },
  { key: "help", label: "Help", icon: "help" },
  { key: "logout", label: "Logout", icon: "logout" },
];

/* ── palette ───────────────────────────────── */

const C = {
  sidebar: "#1A3C34",
  sidebarHover: "rgba(255,255,255,0.08)",
  sidebarActive: "rgba(255,255,255,0.14)",
  primary: "#2D6A4F",
  primaryLight: "#52B788",
  primaryLighter: "#D8F3DC",
  accent: "#40916C",
  bg: "#F0F2F5",
  card: "#FFFFFF",
  cardBorder: "#E8EAED",
  text: "#1A1A2E",
  textSecondary: "#6B7280",
  textMuted: "#9CA3AF",
  white: "#FFFFFF",
  success: "#059669",
  warning: "#D97706",
  danger: "#DC2626",
  info: "#2563EB",
};

/* ── project status display mapping ─────────────────────────────── */
type DisplayStatus = "New" | "Awaiting floor plan review" | "Mask review" | "Ready";

function displayStatus(raw: string | null | undefined): DisplayStatus {
  const s = (raw || "").toLowerCase();
  if (
    s === "ready" ||
    s === "ready_no_mask" ||
    s === "awaiting_room_review" ||
    s === "masked"
  )
    return "Ready";
  if (s === "awaiting_floor_review") return "Awaiting floor plan review";
  if (
    s === "awaiting_alignment_review" ||
    s === "mask_failed"
  )
    return "Mask review";
  return "New";
}

function statusColor(d: DisplayStatus): { fg: string; bg: string } {
  switch (d) {
    case "Ready":
      return { fg: C.success, bg: "#ECFDF5" };
    case "Awaiting floor plan review":
      return { fg: C.warning, bg: "#FFFBEB" };
    case "Mask review":
      return { fg: C.info, bg: "#EFF6FF" };
    case "New":
    default:
      return { fg: C.textSecondary, bg: "#F3F4F6" };
  }
}

/* ── component ─────────────────────────────── */

export default function Dashboard() {
  const router = useRouter();
  const [active, setActive] = useState<NavKey>("dashboard");
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userName, setUserName] = useState("User");
  const [tenantName, setTenantName] = useState("");
  const [tenantRole, setTenantRole] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [boqMetaByProject, setBoqMetaByProject] = useState<Record<string, BOQMetaLite>>({});

  // NBC Wizard state
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStepIdx, setWizardStepIdx] = useState(0);
  // step 0: project name + DWG upload (required), step 1: common questions, step 2: followup questions, step 3: evaluation result
  const [wizardProjectName, setWizardProjectName] = useState("New Building");
  const [wizardUnit, setWizardUnit] = useState("mm");
  const [nbcQuestions, setNbcQuestions] = useState<NBCQuestion[]>([]);
  const [nbcFollowups, setNbcFollowups] = useState<NBCQuestion[]>([]);
  const [nbcAnswers, setNbcAnswers] = useState<Record<string, any>>({});
  const [nbcEvaluation, setNbcEvaluation] = useState<any>(null);
  const [nbcOccupancyLabels, setNbcOccupancyLabels] = useState<Record<string, string>>({});
  const [wizardSubmitting, setWizardSubmitting] = useState(false);
  const [wizardDwgFile, setWizardDwgFile] = useState<File | null>(null);

  useEffect(() => {
    setUserName(getName() || "User");
    setTenantName(getTenantName() || "");
    setTenantRole(getTenantRole() || "");
  }, []);

  async function loadProjects() {
    setIsLoading(true);
    try {
      const rows: Project[] = await apiFetch("/api/projects");
      setProjects(rows);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Could not load projects right now.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if ((active !== "quotes" && active !== "dashboard") || projects.length === 0) return;
    let alive = true;
    (async () => {
      try {
        const pairs = await Promise.all(
          projects.map(async (p) => {
            try {
              const meta: BOQMetaLite = await apiFetch(`/api/projects/${p.id}/boq/meta`);
              return [p.id, meta] as const;
            } catch {
              return [p.id, {} as BOQMetaLite] as const;
            }
          })
        );
        if (!alive) return;
        const next: Record<string, BOQMetaLite> = {};
        for (const [pid, meta] of pairs) next[pid] = meta;
        setBoqMetaByProject(next);
      } catch {
        // Best-effort metadata load; quotes list still renders project rows.
      }
    })();

    return () => {
      alive = false;
    };
  }, [active, projects]);

  async function openWizard() {
    setShowWizard(true);
    setWizardStepIdx(0);
    setWizardProjectName("New Building");
    setWizardUnit("mm");
    setNbcAnswers({});
    setNbcFollowups([]);
    setNbcEvaluation(null);
    setWizardDwgFile(null);
    try {
      const [qs, labels] = await Promise.all([
        apiFetch("/api/nbc/questions"),
        apiFetch("/api/nbc/occupancy_types"),
      ]);
      setNbcQuestions(qs);
      setNbcOccupancyLabels(labels);
    } catch {}
  }

  async function wizardSelectOccupancy(subtype: string) {
    setNbcAnswers((prev) => ({ ...prev, occupancy_subtype: subtype }));
    try {
      const followups: NBCQuestion[] = await apiFetch(`/api/nbc/followup_fields?occupancy_subtype=${encodeURIComponent(subtype)}`);
      setNbcFollowups(followups);
    } catch {
      setNbcFollowups([]);
    }
  }

  function setNbcAnswer(id: string, value: any) {
    setNbcAnswers((prev) => ({ ...prev, [id]: value }));
  }

  async function wizardEvaluate() {
    try {
      const result = await apiFetch("/api/nbc/evaluate", {
        method: "POST",
        body: JSON.stringify({ answers: nbcAnswers }),
      });
      setNbcEvaluation(result);
      setWizardStepIdx(3);
    } catch (e: any) {
      setError(e?.message || "Evaluation failed");
    }
  }

  async function wizardCreateProject() {
    setWizardSubmitting(true);
    setError(null);
    try {
      const j: Project = await apiFetch("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: wizardProjectName, nbc_answers: nbcAnswers, unit: wizardUnit }),
      });
      setProjects((prev) => [j, ...prev]);
      setShowWizard(false);

      // Upload DWG if one was selected during the wizard
      if (wizardDwgFile) {
        const fd = new FormData();
        fd.append("file", wizardDwgFile);
        await apiUpload(`/api/projects/${j.id}/upload`, fd);
      }

      // Navigate to the project workspace
      router.push(`/p/${j.id}`);
    } catch (e: any) {
      setError(e?.message || "Could not create project.");
    } finally {
      setWizardSubmitting(false);
    }
  }

  async function createProject() {
    openWizard();
  }

  const stats = useMemo(() => {
    const total = projects.length;
    const ready = projects.filter((p) => p.status === "ready").length;
    const failed = projects.filter((p) => p.status === "failed").length;
    const inProgress = total - ready - failed;
    return { total, ready, failed, inProgress };
  }, [projects]);

  const recentQuotes = useMemo(() => {
    return projects
      .map((p) => {
        const meta = boqMetaByProject[p.id] || {};
        const hasQuote = !!(meta.quote_number || meta.quote_title || meta.client_name);
        return hasQuote
          ? {
              id: p.id,
              projectName: p.name,
              quoteNumber: meta.quote_number || "",
              quoteTitle: meta.quote_title || "",
              clientName: meta.client_name || "",
            }
          : null;
      })
      .filter((x): x is { id: string; projectName: string; quoteNumber: string; quoteTitle: string; clientName: string } => x !== null)
      .slice(0, 5);
  }, [projects, boqMetaByProject]);

  const quoteCount = useMemo(
    () =>
      projects.filter((p) => {
        const meta = boqMetaByProject[p.id] || {};
        return !!(meta.quote_number || meta.quote_title || meta.client_name);
      }).length,
    [projects, boqMetaByProject]
  );

  type ActivityItem = { id: string; user_name: string; action: string; target_type: string; target_id: string; target_name: string; created_at: number };
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  async function loadActivity() {
    try {
      const items: ActivityItem[] = await apiFetch("/api/activity?limit=20");
      setActivity(items);
    } catch {}
  }

  useEffect(() => { loadActivity(); }, []);

  function signOut() {
    clearAuth();
    router.push("/login");
  }

  return (
    <main style={S.shell}>
      {/* ── sidebar ── */}
      <aside style={S.sidebar}>
        <div style={S.brandRow}>
          <div style={S.brandIcon}>
            <Icon name="box" />
          </div>
          <span style={S.brandText}>Mepit.AI</span>
        </div>

        <div style={S.sidebarLabel}>MENU</div>
        <nav style={S.nav}>
          {NAV_MAIN.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActive(item.key)}
              style={navStyle(active === item.key)}
            >
              <span style={S.navIcon}>
                <Icon name={item.icon} />
              </span>
              <span>{item.label}</span>
              {active === item.key && <span style={S.navDot} />}
            </button>
          ))}
        </nav>

        <div style={S.navSpacer} />

        <nav style={S.nav}>
          {NAV_BOTTOM.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => (item.key === "logout" ? signOut() : setActive(item.key as NavKey))}
              style={navStyle(false)}
            >
              <span style={S.navIcon}>
                <Icon name={item.icon} />
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

      </aside>

      {/* ── main content ── */}
      <section style={S.content}>
        {/* header row */}
        <header style={S.header}>
          <div style={S.searchBox}>
            <span style={S.searchIcon}>
              <Icon name="search" />
            </span>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={active === "quotes" ? "Search quote or project …" : "Search project …"}
              style={S.searchInput}
            />
          </div>

          <div style={S.headerRight}>
            <button type="button" style={S.iconBtn}>
              <Icon name="bell" />
            </button>
            <div style={S.headerUser}>
              <div style={S.headerAvatar}>{userName.charAt(0).toUpperCase()}</div>
              <div>
                <div style={S.headerUserName}>{userName}</div>
                <div style={S.headerUserRole}>{tenantName ? `${tenantName} · ${tenantRole || "member"}` : "Personal"}</div>
              </div>
            </div>
          </div>
        </header>

        {/* ═══════ TAB: DASHBOARD ═══════ */}
        {active === "dashboard" && (
          <>
            {/* dashboard title row */}
            <div style={S.titleRow}>
              <div>
                <h1 style={S.pageTitle}>Dashboard</h1>
                <p style={S.pageSubtitle}>
                  Overview of your projects and team activity.
                </p>
              </div>
              <div style={S.titleActions}>
                <button type="button" onClick={createProject} style={S.addBtn}>
                  <Icon name="plus" />
                  <span>New Project</span>
                </button>
              </div>
            </div>

            {error && <div style={S.errorBanner}>{error}</div>}

            {/* count strip */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              <div style={{ ...S.card, padding: "18px 20px", display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: C.primaryLighter, color: C.primary, display: "grid", placeItems: "center" }}>
                  <Icon name="projects" />
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: "uppercase", letterSpacing: 0.5 }}>Projects</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: C.text, lineHeight: 1.1 }}>{stats.total}</div>
                </div>
              </div>
              <div style={{ ...S.card, padding: "18px 20px", display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: "#EFF6FF", color: C.info, display: "grid", placeItems: "center" }}>
                  <Icon name="receipt" />
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: "uppercase", letterSpacing: 0.5 }}>Quotes</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: C.text, lineHeight: 1.1 }}>{quoteCount}</div>
                </div>
              </div>
            </div>

            {/* row 2: recent quotes + recent projects */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {/* recent quotes */}
              <div style={S.card}>
                <div style={S.cardHeader}>
                  <span style={S.cardTitle}>Recent Quotes</span>
                  <button type="button" onClick={() => setActive("quotes")} style={{ ...S.importBtn, padding: "6px 12px", fontSize: 12 }}>
                    <span>View all</span><Icon name="chevronRight" />
                  </button>
                </div>
                {recentQuotes.length === 0 ? (
                  <div style={S.emptyRow}>No quotes yet. Open a project’s BOQ to create one.</div>
                ) : (
                  recentQuotes.map((q, idx) => (
                    <div key={q.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: idx === recentQuotes.length - 1 ? "none" : `1px solid ${C.cardBorder}` }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {q.quoteTitle || "BOQ"}
                        </div>
                        <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {(q.quoteNumber || "Q-DRAFT")} · {q.clientName || q.projectName}
                        </div>
                      </div>
                      <a href={`/p/${q.id}/boq`} style={S.openLink}>Open <Icon name="chevronRight" /></a>
                    </div>
                  ))
                )}
              </div>

              {/* recent projects */}
              <div style={S.card}>
                <div style={S.cardHeader}>
                  <span style={S.cardTitle}>Recent Projects</span>
                  <button type="button" onClick={() => setActive("projects")} style={{ ...S.importBtn, padding: "6px 12px", fontSize: 12 }}>
                    <span>View all</span><Icon name="chevronRight" />
                  </button>
                </div>
                {projects.length === 0 ? (
                  <div style={S.emptyRow}>No projects yet. Click “New Project” to get started.</div>
                ) : (
                  projects.slice(0, 5).map((p, idx) => {
                    const d = displayStatus(p.status);
                    const { fg, bg } = statusColor(d);
                    return (
                      <div key={p.id} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: idx === Math.min(projects.length, 5) - 1 ? "none" : `1px solid ${C.cardBorder}` }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                          <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.id}</div>
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 600, color: fg, background: bg, padding: "4px 10px", borderRadius: 999, whiteSpace: "nowrap" }}>{d}</span>
                        <a href={`/p/${p.id}`} style={S.openLink}>Open <Icon name="chevronRight" /></a>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* row 3: team activity + quick actions */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, marginTop: 16 }}>
              {/* activity feed */}
              <div style={S.card}>
                <div style={S.cardHeader}>
                  <span style={S.cardTitle}>Team Activity</span>
                  <button type="button" onClick={loadActivity} style={{ ...S.importBtn, padding: "6px 12px", fontSize: 12 }}>
                    <Icon name="download" /><span>Refresh</span>
                  </button>
                </div>
                <div style={{ maxHeight: 380, overflowY: "auto" }}>
                  {activity.length === 0 ? (
                    <div style={S.emptyRow}>No activity yet. Actions like creating projects, uploading files, and running the pipeline will show up here.</div>
                  ) : (
                    activity.map((a) => {
                      const actionLabels: Record<string, string> = {
                        created_project: "created project",
                        uploaded_file: "uploaded file",
                        ran_pipeline: "ran pipeline on",
                        saved_project: "saved",
                        invited_member: "invited",
                        removed_member: "removed",
                        changed_role: "changed role of",
                      };
                      const label = actionLabels[a.action] || a.action.replace(/_/g, " ");
                      const timeAgo = (() => {
                        const diff = Date.now() / 1000 - a.created_at;
                        if (diff < 60) return "just now";
                        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
                        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
                        return `${Math.floor(diff / 86400)}d ago`;
                      })();
                      return (
                        <div key={a.id} style={{ display: "flex", gap: 12, padding: "12px 20px", borderBottom: `1px solid ${C.cardBorder}`, alignItems: "flex-start" }}>
                          <div style={{ width: 32, height: 32, borderRadius: 999, background: C.primary, color: C.white, display: "grid", placeItems: "center", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                            {a.user_name.charAt(0).toUpperCase()}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, color: C.text }}>
                              <strong>{a.user_name}</strong> {label} {a.target_name && <strong>{a.target_name}</strong>}
                            </div>
                            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{timeAgo}</div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* quick actions */}
              <div style={S.card}>
                <div style={S.cardHeader}><span style={S.cardTitle}>Quick Actions</span></div>
                <div style={{ display: "flex", flexDirection: "column", padding: 12, gap: 8 }}>
                  <button type="button" onClick={createProject} style={{ ...S.addBtn, justifyContent: "flex-start", width: "100%" }}>
                    <Icon name="plus" /><span>New Project</span>
                  </button>
                  <button type="button" onClick={() => setActive("projects")} style={{ ...S.importBtn, justifyContent: "flex-start", width: "100%" }}>
                    <Icon name="projects" /><span>Browse Projects</span>
                  </button>
                  <button type="button" onClick={() => setActive("quotes")} style={{ ...S.importBtn, justifyContent: "flex-start", width: "100%" }}>
                    <Icon name="receipt" /><span>Open Quotes / BOQ</span>
                  </button>
                  <button type="button" onClick={() => setActive("team")} style={{ ...S.importBtn, justifyContent: "flex-start", width: "100%" }}>
                    <Icon name="team" /><span>Manage Team</span>
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ═══════ TAB: PROJECTS ═══════ */}
        {active === "projects" && (
          <>
            <div style={S.titleRow}>
              <div>
                <h1 style={S.pageTitle}>Projects</h1>
                <p style={S.pageSubtitle}>Manage all your projects in one place.</p>
              </div>
              <div style={S.titleActions}>
                <button type="button" onClick={createProject} style={S.addBtn}>
                  <Icon name="plus" />
                  <span>New Project</span>
                </button>
                <button type="button" onClick={loadProjects} disabled={isLoading} style={S.importBtn}>
                  <Icon name="download" />
                  <span>{isLoading ? "Loading…" : "Refresh"}</span>
                </button>
              </div>
            </div>

            {error && <div style={S.errorBanner}>{error}</div>}

            {/* projects table */}
            <div style={S.card}>
              <div style={S.cardHeader}>
                <div>
                  <span style={S.cardTitle}>All Projects</span>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textSecondary }}>
                    Open an existing workspace or create a new one.
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" onClick={loadProjects} disabled={isLoading} style={S.importBtn}>
                    <Icon name="download" />
                    <span>{isLoading ? "…" : "Export"}</span>
                  </button>
                </div>
              </div>

              <div style={S.tableScrollWrapper}>
              <div style={{ ...S.tableHead, gridTemplateColumns: "1fr 140px 120px" }}>
                <span>Project Name</span>
                <span>Created</span>
                <span style={{ textAlign: "right" }}>Action</span>
              </div>

              {projects.length === 0 ? (
                <div style={S.emptyRow}>
                  No projects yet. Create your first project above.
                </div>
              ) : (
                projects.map((p, idx) => (
                  <div key={p.id} style={{ ...S.tableRow, gridTemplateColumns: "1fr 140px 120px", background: idx % 2 === 0 ? C.card : "#FAFBFC" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 2 }}>{p.id}</div>
                    </div>
                    <div style={{ fontSize: 12, color: C.textSecondary }}>—</div>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <a href={`/p/${p.id}`} style={S.openLink}>Open <Icon name="chevronRight" /></a>
                    </div>
                  </div>
                ))
              )}
              </div>

              {projects.length > 0 && (
                <div style={{ padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `1px solid ${C.cardBorder}` }}>
                  <span style={{ fontSize: 12, color: C.textSecondary }}>Showing {projects.length} project{projects.length !== 1 ? "s" : ""}</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button type="button" style={{ ...S.paginationBtn, opacity: 0.4 }}>Prev</button>
                    <button type="button" style={{ ...S.paginationBtn, background: C.primary, color: C.white, borderColor: C.primary }}>1</button>
                    <button type="button" style={{ ...S.paginationBtn, opacity: 0.4 }}>Next</button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* ═══════ TAB: QUOTES / BOQ ═══════ */}
        {active === "quotes" && (
          <>
            <div style={S.titleRow}>
              <div>
                <h1 style={S.pageTitle}>Quotes / BOQ</h1>
                <p style={S.pageSubtitle}>See all project BOQs and open them for editing.</p>
              </div>
            </div>

            <div style={S.card}>
              <div style={S.cardHeader}>
                <div>
                  <span style={S.cardTitle}>All Quotes</span>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textSecondary }}>
                    Quote details are pulled from each project BOQ.
                  </p>
                </div>
                <button type="button" onClick={loadProjects} disabled={isLoading} style={S.importBtn}>
                  <Icon name="download" />
                  <span>{isLoading ? "Loading…" : "Refresh"}</span>
                </button>
              </div>

              <div style={S.tableScrollWrapper}>
                <div style={{ ...S.tableHead, gridTemplateColumns: "1.2fr 1fr 120px 120px" }}>
                  <span>Project / Quote</span>
                  <span>Client</span>
                  <span>Valid Until</span>
                  <span style={{ textAlign: "right" }}>Action</span>
                </div>

                {projects.length === 0 ? (
                  <div style={S.emptyRow}>No projects yet. Create a project to generate BOQ quotes.</div>
                ) : (
                  projects
                    .filter((p) => {
                      const q = searchQuery.trim().toLowerCase();
                      if (!q) return true;
                      const meta = boqMetaByProject[p.id] || {};
                      return (
                        p.name.toLowerCase().includes(q) ||
                        (meta.quote_number || "").toLowerCase().includes(q) ||
                        (meta.quote_title || "").toLowerCase().includes(q) ||
                        (meta.client_name || "").toLowerCase().includes(q)
                      );
                    })
                    .map((p, idx) => {
                      const meta = boqMetaByProject[p.id] || {};
                      return (
                        <div key={p.id} style={{ ...S.tableRow, gridTemplateColumns: "1.2fr 1fr 120px 120px", background: idx % 2 === 0 ? C.card : "#FAFBFC" }}>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{p.name}</div>
                            <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 2 }}>
                              {(meta.quote_number || "Q-DRAFT")} · {(meta.quote_title || "BOQ")}
                            </div>
                          </div>
                          <div style={{ fontSize: 12, color: C.textSecondary }}>{meta.client_name || "—"}</div>
                          <div style={{ fontSize: 12, color: C.textSecondary }}>{meta.valid_until || "—"}</div>
                          <div style={{ display: "flex", justifyContent: "flex-end" }}>
                            <a href={`/p/${p.id}/boq`} style={S.openLink}>Edit BOQ <Icon name="chevronRight" /></a>
                          </div>
                        </div>
                      );
                    })
                )}
              </div>
            </div>
          </>
        )}

        {/* ═══════ TAB: TEAM ═══════ */}
        {active === "team" && <TeamTab tenantRole={tenantRole} onTenantSwitch={async () => {
          // Refresh tenant info and project list after switching teams
          try {
            const me = await apiFetch("/api/auth/me");
            if (me.tenant) {
              setTenantName(me.tenant.name || "");
              setTenantRole(me.tenant.role || "");
            }
          } catch {}
          await loadProjects();
        }} />}

        {/* ═══════ PLACEHOLDER TABS ═══════ */}
        {!["dashboard", "projects", "quotes", "team"].includes(active) && (
          <div style={S.card}>
            <div style={{ padding: 40, textAlign: "center" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>
                <Icon name={NAV_MAIN.find((n) => n.key === active)?.icon || "dashboard"} />
              </div>
              <h2 style={{ margin: 0, fontWeight: 800, color: C.text }}>
                {NAV_MAIN.find((n) => n.key === active)?.label || active}
              </h2>
              <p style={{ color: C.textSecondary, marginTop: 8, fontSize: 14 }}>
                This section is coming soon. Use <b>Dashboard</b> or <b>Projects</b> to manage your workspaces.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* ═══════ NBC WIZARD MODAL ═══════ */}
      {showWizard && (
        <div style={WZ.overlay} onClick={() => setShowWizard(false)}>
          <div style={WZ.modal} onClick={(e) => e.stopPropagation()}>
            <div style={WZ.header}>
              <span style={WZ.headerTitle}>
                {wizardStepIdx === 0 && "New Project — Upload Drawing"}
                {wizardStepIdx === 1 && "Building Details"}
                {wizardStepIdx === 2 && "Additional Details"}
                {wizardStepIdx === 3 && "NBC Compliance Results"}
              </span>
              <button type="button" style={WZ.closeBtn} onClick={() => setShowWizard(false)}>&times;</button>
            </div>

            {/* Step indicator */}
            <div style={WZ.stepRow}>
              {[0, 1, 2, 3].map((s) => (
                <div key={s} style={{ ...WZ.stepDot, background: wizardStepIdx >= s ? C.primary : C.cardBorder }} />
              ))}
            </div>

            <div style={WZ.body}>
              {/* STEP 0: Project name + DWG upload */}
              {wizardStepIdx === 0 && (
                <div style={WZ.stepContent}>
                  <label style={WZ.label}>Project Name</label>
                  <input
                    value={wizardProjectName}
                    onChange={(e) => setWizardProjectName(e.target.value)}
                    placeholder="Enter project name"
                    style={WZ.input}
                    autoFocus
                  />
                  <div style={{ marginTop: 8 }}>
                    <label style={WZ.label}>Drawing Unit <span style={{ color: C.danger }}>*</span></label>
                    <select
                      value={wizardUnit}
                      onChange={(e) => setWizardUnit(e.target.value)}
                      style={WZ.select}
                    >
                      <option value="m">Meters (m)</option>
                      <option value="mm">Millimeters (mm)</option>
                      <option value="in">Inches (in)</option>
                      <option value="ft">Feet (ft)</option>
                    </select>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <label style={WZ.label}>Upload DWG/DXF Drawing <span style={{ color: C.danger }}>*</span></label>
                    <div style={{
                      marginTop: 6, padding: "20px 16px", borderRadius: 12, textAlign: "center",
                      border: `2px dashed ${wizardDwgFile ? C.primary : C.cardBorder}`,
                      background: wizardDwgFile ? "#ECFDF5" : "#FAFBFC",
                      cursor: "pointer", transition: "all 0.15s",
                    }}>
                      <label style={{ cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                        {wizardDwgFile ? (
                          <>
                            <div style={{ width: 40, height: 40, borderRadius: 10, background: C.primary, display: "grid", placeItems: "center" }}>
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{wizardDwgFile.name}</div>
                            <div style={{ fontSize: 11, color: C.success }}>File selected — click to change</div>
                          </>
                        ) : (
                          <>
                            <div style={{ width: 40, height: 40, borderRadius: 10, background: "#F3F4F6", display: "grid", placeItems: "center" }}>
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                              </svg>
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Click to upload DWG or DXF file</div>
                            <div style={{ fontSize: 11, color: C.textMuted }}>Required to proceed</div>
                          </>
                        )}
                        <input
                          type="file"
                          accept=".dxf,.dwg"
                          style={{ display: "none" }}
                          onChange={(e) => setWizardDwgFile(e.target.files?.[0] || null)}
                        />
                      </label>
                    </div>
                  </div>
                  <div style={WZ.btnRow}>
                    <button type="button" style={WZ.secondaryBtn} onClick={() => setShowWizard(false)}>Cancel</button>
                    <button type="button" style={WZ.primaryBtn} onClick={() => setWizardStepIdx(1)} disabled={!wizardProjectName.trim() || !wizardDwgFile}>
                      Next
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 1: Common questions */}
              {wizardStepIdx === 1 && (
                <div style={WZ.stepContent}>
                  {nbcQuestions.map((q) => (
                    <div key={q.id} style={WZ.fieldGroup}>
                      <label style={WZ.label}>{q.label}</label>
                      {q.type === "select" && q.options && (
                        <select
                          value={nbcAnswers[q.id] ?? ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setNbcAnswer(q.id, val);
                            if (q.id === "occupancy_subtype") wizardSelectOccupancy(val);
                          }}
                          style={WZ.select}
                        >
                          <option value="">— Select —</option>
                          {q.options.map((opt) => (
                            <option key={opt} value={opt}>
                              {nbcOccupancyLabels[opt] || opt.replace(/_/g, " ")}
                            </option>
                          ))}
                        </select>
                      )}
                      {q.type === "number" && (
                        <input
                          type="number"
                          value={nbcAnswers[q.id] ?? ""}
                          onChange={(e) => setNbcAnswer(q.id, e.target.value === "" ? "" : Number(e.target.value))}
                          style={WZ.input}
                          placeholder="0"
                        />
                      )}
                      {q.type === "boolean" && (
                        <div style={WZ.toggleRow}>
                          <button
                            type="button"
                            onClick={() => setNbcAnswer(q.id, true)}
                            style={{ ...WZ.toggleBtn, ...(nbcAnswers[q.id] === true ? WZ.toggleActive : {}) }}
                          >Yes</button>
                          <button
                            type="button"
                            onClick={() => setNbcAnswer(q.id, false)}
                            style={{ ...WZ.toggleBtn, ...(nbcAnswers[q.id] === false ? WZ.toggleActive : {}) }}
                          >No</button>
                        </div>
                      )}
                    </div>
                  ))}
                  <div style={WZ.btnRow}>
                    <button type="button" style={WZ.secondaryBtn} onClick={() => setWizardStepIdx(0)}>Back</button>
                    <button
                      type="button"
                      style={WZ.primaryBtn}
                      onClick={() => nbcFollowups.length > 0 ? setWizardStepIdx(2) : wizardEvaluate()}
                      disabled={!nbcAnswers.occupancy_subtype}
                    >
                      {nbcFollowups.length > 0 ? "Next" : "Evaluate"}
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 2: Followup questions */}
              {wizardStepIdx === 2 && (
                <div style={WZ.stepContent}>
                  <p style={{ fontSize: 13, color: C.textSecondary, margin: "0 0 12px" }}>
                    Additional details for <b>{nbcOccupancyLabels[nbcAnswers.occupancy_subtype] || nbcAnswers.occupancy_subtype}</b>
                  </p>
                  {nbcFollowups.map((q) => (
                    <div key={q.id} style={WZ.fieldGroup}>
                      <label style={WZ.label}>{q.label}</label>
                      {q.type === "number" && (
                        <input
                          type="number"
                          value={nbcAnswers[q.id] ?? ""}
                          onChange={(e) => setNbcAnswer(q.id, e.target.value === "" ? "" : Number(e.target.value))}
                          style={WZ.input}
                          placeholder="0"
                        />
                      )}
                      {q.type === "boolean" && (
                        <div style={WZ.toggleRow}>
                          <button
                            type="button"
                            onClick={() => setNbcAnswer(q.id, true)}
                            style={{ ...WZ.toggleBtn, ...(nbcAnswers[q.id] === true ? WZ.toggleActive : {}) }}
                          >Yes</button>
                          <button
                            type="button"
                            onClick={() => setNbcAnswer(q.id, false)}
                            style={{ ...WZ.toggleBtn, ...(nbcAnswers[q.id] === false ? WZ.toggleActive : {}) }}
                          >No</button>
                        </div>
                      )}
                    </div>
                  ))}
                  <div style={WZ.btnRow}>
                    <button type="button" style={WZ.secondaryBtn} onClick={() => setWizardStepIdx(1)}>Back</button>
                    <button type="button" style={WZ.primaryBtn} onClick={wizardEvaluate}>Evaluate</button>
                  </div>
                </div>
              )}

              {/* STEP 3: Evaluation results */}
              {wizardStepIdx === 3 && nbcEvaluation && (
                <div style={WZ.stepContent}>
                  {nbcEvaluation.matched_category && (
                    <div style={WZ.resultBanner}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Matched Category</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: C.primary, marginTop: 4 }}>{nbcEvaluation.matched_category}</div>
                    </div>
                  )}

                  {nbcEvaluation.warnings && nbcEvaluation.warnings.length > 0 && (
                    <div style={WZ.warningBox}>
                      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>Warnings</div>
                      {nbcEvaluation.warnings.map((w: string, i: number) => (
                        <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>&#9888; {w}</div>
                      ))}
                    </div>
                  )}

                  <div style={{ fontSize: 13, fontWeight: 800, color: C.text, marginTop: 12, marginBottom: 8 }}>
                    Fire Safety Equipment
                  </div>

                  <div style={WZ.equipGrid}>
                    {(nbcEvaluation.equipment || []).map((eq: NBCEquipment) => {
                      const isRequired = eq.required;
                      const isSupported = eq.supported;
                      return (
                        <div key={eq.key} style={{ ...WZ.equipCard, borderColor: isRequired ? (isSupported ? C.primary : C.warning) : C.cardBorder }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: C.text, flex: 1 }}>{eq.label}</span>
                            {isRequired ? (
                              isSupported ? (
                                <span style={{ ...WZ.chip, background: "#ECFDF5", color: C.success, borderColor: "rgba(5,150,105,0.2)" }}>Supported</span>
                              ) : (
                                <span style={{ ...WZ.chip, background: "#FEF3C7", color: C.warning, borderColor: "rgba(217,119,6,0.2)" }}>Coming Soon</span>
                              )
                            ) : (
                              <span style={{ ...WZ.chip, background: "#F3F4F6", color: C.textMuted, borderColor: "rgba(156,163,175,0.2)" }}>Not Required</span>
                            )}
                          </div>
                          {eq.notes.length > 0 && (
                            <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 6 }}>
                              {eq.notes.map((n, ni) => <div key={ni}>{n}</div>)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {error && <div style={{ ...S.errorBanner, marginTop: 12 }}>{error}</div>}

                  {wizardDwgFile && (
                    <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 10, background: "#ECFDF5", border: "1px solid rgba(5,150,105,0.2)", display: "flex", alignItems: "center", gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.success} strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                      <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>{wizardDwgFile.name}</span>
                    </div>
                  )}

                  <div style={WZ.btnRow}>
                    <button type="button" style={WZ.secondaryBtn} onClick={() => nbcFollowups.length > 0 ? setWizardStepIdx(2) : setWizardStepIdx(1)}>
                      Back
                    </button>
                    <button type="button" style={WZ.primaryBtn} onClick={wizardCreateProject} disabled={wizardSubmitting}>
                      {wizardSubmitting ? "Creating…" : "Create Project"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        input::placeholder { color: ${C.textMuted}; }
        a:hover { opacity: 0.85; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: ${C.cardBorder}; border-radius: 3px; }
        * { box-sizing: border-box; }
      `}</style>
    </main>
  );
}

/* ── KPI Card ────────────────────────────── */

function KpiCard({
  label,
  value,
  sub,
  color,
  bgColor,
  icon,
}: {
  label: string;
  value: number;
  sub: string;
  color: string;
  bgColor: string;
  icon: IconName;
}) {
  return (
    <div style={{ ...S.kpiCard, background: bgColor }}>
      <div style={S.kpiTop}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary }}>{label}</div>
          <div style={{ fontSize: 28, fontWeight: 900, color, marginTop: 4 }}>{value}</div>
        </div>
        <div style={{ ...S.kpiIcon, borderColor: color + "33", color }}>
          <Icon name={icon} />
        </div>
      </div>
      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 8 }}>
        <span style={{ color: C.success }}>&#9650;</span> {sub}
      </div>
    </div>
  );
}

/* ── Billing Tab ─────────────────────────── */

function BillingTab() {
  const plans = [
    { name: "Free", price: "$0", period: "/mo", features: ["3 Projects", "1 GB Storage", "Community Support", "Basic Analytics"], current: false },
    { name: "Pro", price: "$29", period: "/mo", features: ["Unlimited Projects", "50 GB Storage", "Priority Support", "Advanced Analytics", "Team Collaboration", "API Access"], current: true },
    { name: "Enterprise", price: "$99", period: "/mo", features: ["Unlimited Everything", "500 GB Storage", "Dedicated Support", "Custom Integrations", "SSO & SAML", "SLA Guarantee", "On-premise Option"], current: false },
  ];

  const invoices = [
    { id: "INV-2026-003", date: "Mar 1, 2026", amount: "$29.00", status: "Upcoming" },
    { id: "INV-2026-002", date: "Feb 1, 2026", amount: "$29.00", status: "Paid" },
    { id: "INV-2026-001", date: "Jan 1, 2026", amount: "$29.00", status: "Paid" },
    { id: "INV-2025-012", date: "Dec 1, 2025", amount: "$29.00", status: "Paid" },
    { id: "INV-2025-011", date: "Nov 1, 2025", amount: "$0.00", status: "Paid" },
  ];

  return (
    <>
      <div style={S.titleRow}>
        <div>
          <h1 style={S.pageTitle}>Billing</h1>
          <p style={S.pageSubtitle}>Manage your subscription, payment methods, and invoices.</p>
        </div>
      </div>

      {/* current plan banner */}
      <div style={{ ...S.card, background: `linear-gradient(135deg, ${C.sidebar} 0%, ${C.primary} 100%)`, color: C.white, border: "none" }}>
        <div style={{ padding: "28px 28px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.08em" }}>Current Plan</div>
            <div style={{ fontSize: 28, fontWeight: 900, marginTop: 4 }}>Pro Plan</div>
            <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>Your next billing date is <b>April 1, 2026</b></div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 36, fontWeight: 900 }}>$29<span style={{ fontSize: 14, fontWeight: 600, opacity: 0.7 }}>/mo</span></div>
            <button type="button" style={{ marginTop: 8, borderRadius: 8, border: "1px solid rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.12)", color: C.white, fontWeight: 700, fontSize: 12, padding: "8px 20px", cursor: "pointer" }}>Manage Subscription</button>
          </div>
        </div>
      </div>

      {/* usage stats */}
      <div style={S.kpiRow}>
        <div style={{ ...S.kpiCard, background: C.card }}>
          <div style={S.kpiTop}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary }}>Projects Used</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: C.primary, marginTop: 4 }}>12 <span style={{ fontSize: 14, fontWeight: 600, color: C.textMuted }}>/ &#8734;</span></div>
            </div>
            <div style={{ ...S.kpiIcon, borderColor: C.primary + "33", color: C.primary }}><Icon name="box" /></div>
          </div>
          <div style={{ marginTop: 10, height: 4, borderRadius: 2, background: C.cardBorder }}>
            <div style={{ height: "100%", width: "24%", borderRadius: 2, background: C.primary }} />
          </div>
        </div>
        <div style={{ ...S.kpiCard, background: C.card }}>
          <div style={S.kpiTop}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary }}>Storage Used</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: C.info, marginTop: 4 }}>18.4 <span style={{ fontSize: 14, fontWeight: 600, color: C.textMuted }}>/ 50 GB</span></div>
            </div>
            <div style={{ ...S.kpiIcon, borderColor: C.info + "33", color: C.info }}><Icon name="download" /></div>
          </div>
          <div style={{ marginTop: 10, height: 4, borderRadius: 2, background: C.cardBorder }}>
            <div style={{ height: "100%", width: "37%", borderRadius: 2, background: C.info }} />
          </div>
        </div>
        <div style={{ ...S.kpiCard, background: C.card }}>
          <div style={S.kpiTop}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary }}>Team Members</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: C.accent, marginTop: 4 }}>4 <span style={{ fontSize: 14, fontWeight: 600, color: C.textMuted }}>/ 25</span></div>
            </div>
            <div style={{ ...S.kpiIcon, borderColor: C.accent + "33", color: C.accent }}><Icon name="team" /></div>
          </div>
          <div style={{ marginTop: 10, height: 4, borderRadius: 2, background: C.cardBorder }}>
            <div style={{ height: "100%", width: "16%", borderRadius: 2, background: C.accent }} />
          </div>
        </div>
        <div style={{ ...S.kpiCard, background: C.card }}>
          <div style={S.kpiTop}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary }}>API Calls</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: C.warning, marginTop: 4 }}>8.2k <span style={{ fontSize: 14, fontWeight: 600, color: C.textMuted }}>/ 50k</span></div>
            </div>
            <div style={{ ...S.kpiIcon, borderColor: C.warning + "33", color: C.warning }}><Icon name="analytics" /></div>
          </div>
          <div style={{ marginTop: 10, height: 4, borderRadius: 2, background: C.cardBorder }}>
            <div style={{ height: "100%", width: "16%", borderRadius: 2, background: C.warning }} />
          </div>
        </div>
      </div>

      {/* plans + payment method */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* pricing plans */}
        <div style={S.card}>
          <div style={S.cardHeader}>
            <span style={S.cardTitle}>Plans</span>
          </div>
          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
            {plans.map((plan) => (
              <div key={plan.name} style={{ borderRadius: 12, border: plan.current ? `2px solid ${C.primary}` : `1px solid ${C.cardBorder}`, padding: "16px", background: plan.current ? C.primaryLighter : C.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 800, color: C.text, fontSize: 14 }}>{plan.name}{plan.current && <span style={{ ...S.badge, marginLeft: 8 }}>Current</span>}</div>
                  <div style={{ fontSize: 12, color: C.textSecondary, marginTop: 4 }}>{plan.features.slice(0, 3).join(" · ")}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: C.text }}>{plan.price}<span style={{ fontSize: 12, fontWeight: 500, color: C.textMuted }}>{plan.period}</span></div>
                  {!plan.current && (
                    <button type="button" style={{ marginTop: 6, borderRadius: 6, border: `1px solid ${C.primary}`, background: "transparent", color: C.primary, fontSize: 11, fontWeight: 700, padding: "5px 12px", cursor: "pointer" }}>
                      {plan.price === "$0" ? "Downgrade" : "Upgrade"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* payment method */}
        <div style={S.card}>
          <div style={S.cardHeader}>
            <span style={S.cardTitle}>Payment Method</span>
            <button type="button" style={S.addMemberBtn}>+ Add Card</button>
          </div>
          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
            {/* visa card */}
            <div style={{ borderRadius: 14, background: `linear-gradient(135deg, ${C.sidebar}, #2D5A4F)`, padding: "20px 24px", color: C.white }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>VISA</span>
                <Icon name="creditCard" />
              </div>
              <div style={{ marginTop: 20, fontSize: 16, fontWeight: 700, letterSpacing: "0.12em", fontVariantNumeric: "tabular-nums" }}>
                •••• •••• •••• 4242
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
                <div>
                  <div style={{ fontSize: 9, textTransform: "uppercase", opacity: 0.6, letterSpacing: "0.08em" }}>Card Holder</div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>Michael Johnson</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, textTransform: "uppercase", opacity: 0.6, letterSpacing: "0.08em" }}>Expires</div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>09/28</div>
                </div>
              </div>
            </div>

            {/* billing address */}
            <div style={{ borderRadius: 12, border: `1px solid ${C.cardBorder}`, padding: "14px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Billing Address</div>
              <div style={{ fontSize: 12, color: C.textSecondary, marginTop: 4, lineHeight: 1.6 }}>
                123 Architecture Lane<br />
                Suite 456<br />
                San Francisco, CA 94102
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* invoices */}
      <div style={S.card}>
        <div style={S.cardHeader}>
          <span style={S.cardTitle}>Invoice History</span>
          <button type="button" style={S.importBtn}><Icon name="download" /><span>Export All</span></button>
        </div>
        <div style={S.tableScrollWrapper}>
        <div style={{ ...S.tableHead, gridTemplateColumns: "1fr 140px 120px 100px 100px" }}>
          <span>Invoice</span>
          <span>Date</span>
          <span>Amount</span>
          <span>Status</span>
          <span style={{ textAlign: "right" }}>Action</span>
        </div>
        {invoices.map((inv, idx) => (
          <div key={inv.id} style={{ ...S.tableRow, gridTemplateColumns: "1fr 140px 120px 100px 100px", background: idx % 2 === 0 ? C.card : "#FAFBFC" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{inv.id}</div>
            <div style={{ fontSize: 12, color: C.textSecondary }}>{inv.date}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{inv.amount}</div>
            <div>
              <span style={{
                display: "inline-flex", borderRadius: 999, padding: "3px 10px", fontSize: 11, fontWeight: 700,
                background: inv.status === "Paid" ? "#ECFDF5" : "#FEF3C7",
                color: inv.status === "Paid" ? C.success : C.warning,
                border: `1px solid ${inv.status === "Paid" ? "rgba(5,150,105,0.2)" : "rgba(217,119,6,0.2)"}`,
              }}>{inv.status}</span>
            </div>
            <div style={{ textAlign: "right" }}>
              <button type="button" style={{ background: "none", border: "none", color: C.primary, fontWeight: 700, fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>
                Download
              </button>
            </div>
          </div>
        ))}
        </div>
      </div>
    </>
  );
}

/* ── styles ───────────────────────────────── */

const S: Record<string, CSSProperties> = {
  shell: {
    minHeight: "100vh",
    display: "grid",
    gridTemplateColumns: "250px 1fr",
    background: C.bg,
  },

  /* sidebar */
  sidebar: {
    background: C.sidebar,
    color: C.white,
    display: "flex",
    flexDirection: "column",
    padding: "20px 14px",
    gap: 4,
    position: "sticky",
    top: 0,
    height: "100vh",
    overflowY: "auto",
  },
  brandRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "4px 8px 16px",
  },
  brandIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    background: "rgba(255,255,255,0.15)",
    display: "grid",
    placeItems: "center",
    color: C.primaryLight,
  },
  brandText: {
    fontWeight: 800,
    fontSize: 18,
    color: C.white,
    letterSpacing: "-0.02em",
  },
  sidebarLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.1em",
    color: "rgba(255,255,255,0.4)",
    padding: "12px 10px 6px",
  },
  nav: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  navIcon: {
    width: 20,
    height: 20,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  navDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    background: C.primaryLight,
    marginLeft: "auto",
  },
  navSpacer: { flex: 1 },

  downloadCta: {
    marginTop: 12,
    borderRadius: 14,
    background: "rgba(255,255,255,0.08)",
    padding: "16px 14px",
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  },
  downloadIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    background: "rgba(255,255,255,0.12)",
    display: "grid",
    placeItems: "center",
    marginBottom: 4,
    color: C.primaryLight,
  },
  downloadBtn: {
    marginTop: 8,
    borderRadius: 8,
    border: "none",
    background: C.primaryLight,
    color: C.sidebar,
    fontWeight: 700,
    fontSize: 12,
    padding: "8px 20px",
    cursor: "pointer",
  },

  /* content */
  content: {
    padding: "20px 28px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
    overflowY: "auto",
    maxHeight: "100vh",
  },

  /* header */
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  searchBox: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: C.card,
    borderRadius: 12,
    border: `1px solid ${C.cardBorder}`,
    padding: "10px 16px",
    flex: 1,
    maxWidth: 400,
  },
  searchIcon: { color: C.textMuted, display: "inline-flex", width: 18, height: 18 },
  searchInput: {
    border: "none",
    outline: "none",
    background: "transparent",
    fontSize: 13,
    color: C.text,
    width: "100%",
  },
  headerRight: { display: "flex", alignItems: "center", gap: 16 },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    border: `1px solid ${C.cardBorder}`,
    background: C.card,
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
    color: C.textSecondary,
  },
  headerUser: { display: "flex", alignItems: "center", gap: 10 },
  headerAvatar: {
    width: 38,
    height: 38,
    borderRadius: 999,
    background: C.primary,
    color: C.white,
    display: "grid",
    placeItems: "center",
    fontWeight: 700,
    fontSize: 15,
  },
  headerUserName: { fontSize: 13, fontWeight: 700, color: C.text },
  headerUserRole: { fontSize: 11, color: C.textSecondary },

  /* title row */
  titleRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  pageTitle: {
    margin: 0,
    fontSize: 24,
    fontWeight: 900,
    color: C.text,
    letterSpacing: "-0.02em",
  },
  pageSubtitle: {
    margin: "4px 0 0",
    fontSize: 13,
    color: C.textSecondary,
  },
  titleActions: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  projectInput: {
    borderRadius: 10,
    border: `1px solid ${C.cardBorder}`,
    background: C.card,
    padding: "10px 14px",
    fontSize: 13,
    color: C.text,
    outline: "none",
    minWidth: 180,
  },
  addBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    borderRadius: 10,
    border: "none",
    background: C.primary,
    color: C.white,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(45,106,79,0.3)",
  },
  importBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    borderRadius: 10,
    border: `1px solid ${C.cardBorder}`,
    background: C.card,
    color: C.text,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },

  errorBanner: {
    borderRadius: 12,
    border: "1px solid rgba(220,38,38,0.2)",
    background: "rgba(254,226,226,0.7)",
    padding: "12px 16px",
    color: C.danger,
    fontWeight: 600,
    fontSize: 13,
  },

  /* kpi */
  kpiRow: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 16,
  },
  kpiCard: {
    borderRadius: 16,
    padding: "20px",
    border: `1px solid ${C.cardBorder}`,
  },
  kpiTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  kpiIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    border: "2px solid",
    display: "grid",
    placeItems: "center",
  },

  /* cards */
  card: {
    background: C.card,
    borderRadius: 16,
    border: `1px solid ${C.cardBorder}`,
    overflow: "hidden",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: `1px solid ${C.cardBorder}`,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 800,
    color: C.text,
  },
  badge: {
    fontSize: 10,
    fontWeight: 700,
    color: C.primary,
    background: C.primaryLighter,
    borderRadius: 6,
    padding: "3px 8px",
  },

  /* analytics chart */
  analyticsChart: {
    display: "flex",
    alignItems: "flex-end",
    gap: 8,
    padding: "20px",
    height: 160,
  },
  barCol: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    height: "100%",
  },
  bar: {
    width: "100%",
    minHeight: 12,
    transition: "height 0.4s ease",
  },

  /* reminders */
  reminderCard: {
    display: "flex",
    gap: 12,
    padding: "16px 20px",
    alignItems: "flex-start",
  },
  reminderDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    background: C.primaryLight,
    marginTop: 4,
    flexShrink: 0,
  },
  reminderBtn: {
    marginTop: 10,
    borderRadius: 8,
    border: "none",
    background: C.primary,
    color: C.white,
    fontWeight: 700,
    fontSize: 12,
    padding: "8px 14px",
    cursor: "pointer",
  },

  /* task list  */
  taskList: {
    padding: "12px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  taskItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    cursor: "pointer",
  },
  taskCheck: {
    width: 18,
    height: 18,
    borderRadius: 4,
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
  },

  /* team */
  addMemberBtn: {
    fontSize: 12,
    fontWeight: 700,
    color: C.primary,
    background: "none",
    border: `1px solid ${C.primary}`,
    borderRadius: 8,
    padding: "6px 12px",
    cursor: "pointer",
  },
  teamList: {
    padding: "12px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  teamRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  teamAvatar: {
    width: 34,
    height: 34,
    borderRadius: 999,
    color: C.white,
    display: "grid",
    placeItems: "center",
    fontWeight: 700,
    fontSize: 14,
  },

  /* progress ring */
  progressCenter: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "24px 20px",
    gap: 16,
  },
  progressRing: {
    position: "relative",
    width: 120,
    height: 120,
  },
  progressText: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    fontSize: 22,
    fontWeight: 900,
    color: C.text,
  },
  progressLegend: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: C.textSecondary,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: C.primary,
    display: "inline-block",
  },

  /* timer */
  timerCenter: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "30px 20px",
    gap: 16,
  },
  timerDisplay: {
    fontSize: 36,
    fontWeight: 900,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.02em",
  },
  timerControls: { display: "flex", gap: 8 },
  timerBtn: {
    width: 42,
    height: 42,
    borderRadius: 999,
    border: "2px solid rgba(255,255,255,0.25)",
    background: "rgba(255,255,255,0.1)",
    color: C.white,
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
  },

  /* grid layouts */
  gridRow3: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 16,
  },
  gridRow3b: {
    display: "grid",
    gridTemplateColumns: "1.2fr 0.8fr 0.8fr",
    gap: 16,
  },

  /* table */
  tableScrollWrapper: {
    maxHeight: 480,
    overflowY: "auto",
    overflowX: "auto",
  },
  tableHead: {
    display: "grid",
    gridTemplateColumns: "1fr 160px 120px",
    gap: 12,
    padding: "10px 20px",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: C.textMuted,
    background: "#FAFAFA",
    borderBottom: `1px solid ${C.cardBorder}`,
    fontWeight: 600,
    position: "sticky",
    top: 0,
    zIndex: 1,
  },
  tableRow: {
    display: "grid",
    gridTemplateColumns: "1fr 160px 120px",
    gap: 12,
    alignItems: "center",
    padding: "14px 20px",
    borderBottom: `1px solid ${C.cardBorder}`,
  },
  emptyRow: {
    padding: "24px 20px",
    color: C.textSecondary,
    fontWeight: 600,
    textAlign: "center",
    fontSize: 13,
  },
  openLink: {
    textDecoration: "none",
    border: `1px solid ${C.primary}`,
    borderRadius: 8,
    color: C.primary,
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    background: "transparent",
  },
  paginationBtn: {
    borderRadius: 6,
    border: `1px solid ${C.cardBorder}`,
    background: C.card,
    color: C.text,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
};

/* ── helpers ──────────────────────────────── */

/* ── Wizard styles ───────────────────────── */
const WZ: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    display: "grid",
    placeItems: "center",
    zIndex: 1000,
  },
  modal: {
    background: C.card,
    borderRadius: 20,
    width: "100%",
    maxWidth: 620,
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 24px 48px rgba(0,0,0,0.18)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "18px 24px",
    borderBottom: `1px solid ${C.cardBorder}`,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 800,
    color: C.text,
  },
  closeBtn: {
    background: "none",
    border: "none",
    fontSize: 22,
    color: C.textMuted,
    cursor: "pointer",
    padding: "4px 8px",
    lineHeight: 1,
  },
  stepRow: {
    display: "flex",
    gap: 6,
    justifyContent: "center",
    padding: "14px 24px 0",
  },
  stepDot: {
    width: 32,
    height: 4,
    borderRadius: 999,
    transition: "background 0.2s",
  },
  body: {
    padding: "0 24px 24px",
    overflowY: "auto",
    flex: 1,
  },
  stepContent: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    paddingTop: 16,
  },
  fieldGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: 700,
    color: C.textSecondary,
  },
  input: {
    borderRadius: 10,
    border: `1px solid ${C.cardBorder}`,
    padding: "10px 14px",
    fontSize: 13,
    color: C.text,
    outline: "none",
    background: C.card,
  },
  select: {
    borderRadius: 10,
    border: `1px solid ${C.cardBorder}`,
    padding: "10px 14px",
    fontSize: 13,
    color: C.text,
    outline: "none",
    background: C.card,
    cursor: "pointer",
  },
  toggleRow: {
    display: "flex",
    gap: 8,
  },
  toggleBtn: {
    borderRadius: 8,
    border: `1px solid ${C.cardBorder}`,
    background: C.card,
    color: C.textSecondary,
    padding: "8px 20px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  toggleActive: {
    background: C.primary,
    color: C.white,
    borderColor: C.primary,
  },
  btnRow: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 8,
  },
  primaryBtn: {
    borderRadius: 10,
    border: "none",
    background: C.primary,
    color: C.white,
    padding: "10px 24px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(45,106,79,0.3)",
  },
  secondaryBtn: {
    borderRadius: 10,
    border: `1px solid ${C.cardBorder}`,
    background: C.card,
    color: C.text,
    padding: "10px 24px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  resultBanner: {
    borderRadius: 12,
    border: `1px solid rgba(45,106,79,0.2)`,
    background: "#E8F5E9",
    padding: "14px 16px",
  },
  warningBox: {
    borderRadius: 12,
    border: "1px solid rgba(217,119,6,0.2)",
    background: "#FEF3C7",
    padding: "12px 16px",
    color: C.warning,
    marginTop: 8,
  },
  equipGrid: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  equipCard: {
    borderRadius: 10,
    border: "1px solid",
    padding: "12px 14px",
    background: C.card,
  },
  chip: {
    display: "inline-flex",
    borderRadius: 999,
    padding: "3px 10px",
    fontSize: 10,
    fontWeight: 700,
    border: "1px solid",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
};

function navStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    borderRadius: 10,
    border: "none",
    background: active ? C.sidebarActive : "transparent",
    padding: "10px 10px",
    cursor: "pointer",
    color: active ? C.white : "rgba(255,255,255,0.7)",
    fontWeight: active ? 700 : 500,
    fontSize: 13,
    textAlign: "left",
    transition: "background 0.15s",
  };
}

function statusChip(status: string): CSSProperties {
  const n = (status || "").toLowerCase();
  const isReady = n === "ready";
  const isRunning = n === "running";
  const isFailed = n === "failed";

  const bg = isReady
    ? "#ECFDF5"
    : isRunning
      ? "#EFF6FF"
      : isFailed
        ? "#FEF2F2"
        : "#F3F4F6";
  const color = isReady
    ? C.success
    : isRunning
      ? C.info
      : isFailed
        ? C.danger
        : C.textSecondary;
  const border = isReady
    ? "rgba(5,150,105,0.2)"
    : isRunning
      ? "rgba(37,99,235,0.2)"
      : isFailed
        ? "rgba(220,38,38,0.2)"
        : "rgba(156,163,175,0.2)";

  return {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    border: `1px solid ${border}`,
    padding: "4px 12px",
    fontSize: 12,
    fontWeight: 700,
    textTransform: "capitalize",
    background: bg,
    color,
  };
}

/* ── Team Tab ──────────────────────────────── */

type TeamMember = {
  member_id: string;
  user_id: string;
  name: string;
  email: string;
  role: string;
  created_at: number;
};

type Tenant = {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
  created_at: number;
};

function TeamTab({ tenantRole, onTenantSwitch }: { tenantRole: string; onTenantSwitch?: () => Promise<void> }) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [activeTenant, setActiveTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invite modal state
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Create team modal state
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [createLoading, setCreateLoading] = useState(false);

  // Rename tenant
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState("");

  const isAdmin = activeTenant?.role === "admin";

  async function loadTenants() {
    setLoading(true);
    try {
      const list: Tenant[] = await apiFetch("/api/teams");
      setTenants(list);
      const active = list.find((t) => t.is_active) || list[0] || null;
      setActiveTenant(active);
      if (active) {
        await loadMembers(active.id);
      }
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Failed to load teams");
    } finally {
      setLoading(false);
    }
  }

  async function loadMembers(tenantId: string) {
    try {
      const list: TeamMember[] = await apiFetch(`/api/teams/${tenantId}/members`);
      setMembers(list);
    } catch (e: any) {
      setMembers([]);
    }
  }

  useEffect(() => {
    loadTenants();
  }, []);

  async function switchTenant(tenantId: string) {
    try {
      await apiFetch("/api/teams/switch", {
        method: "POST",
        body: JSON.stringify({ tenant_id: tenantId }),
      });
      await loadTenants();
      if (onTenantSwitch) await onTenantSwitch();
    } catch (e: any) {
      setError(e?.message || "Failed to switch team");
    }
  }

  async function handleInvite() {
    setInviteLoading(true);
    setInviteError(null);
    try {
      await apiFetch(`/api/teams/${activeTenant!.id}/members`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      setShowInvite(false);
      setInviteEmail("");
      setInviteRole("viewer");
      await loadMembers(activeTenant!.id);
    } catch (e: any) {
      setInviteError(e?.message || "Failed to invite member");
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleRemoveMember(memberId: string) {
    if (!confirm("Remove this member from the team?")) return;
    try {
      await apiFetch(`/api/teams/${activeTenant!.id}/members/${memberId}`, {
        method: "DELETE",
      });
      await loadMembers(activeTenant!.id);
    } catch (e: any) {
      setError(e?.message || "Failed to remove member");
    }
  }

  async function handleChangeRole(memberId: string, newRole: string) {
    try {
      await apiFetch(`/api/teams/${activeTenant!.id}/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      });
      await loadMembers(activeTenant!.id);
    } catch (e: any) {
      setError(e?.message || "Failed to change role");
    }
  }

  async function handleCreateTeam() {
    setCreateLoading(true);
    try {
      await apiFetch("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name: newTeamName }),
      });
      setShowCreateTeam(false);
      setNewTeamName("");
      await loadTenants();
    } catch (e: any) {
      setError(e?.message || "Failed to create team");
    } finally {
      setCreateLoading(false);
    }
  }

  async function handleRename() {
    if (!editName.trim()) return;
    try {
      await apiFetch(`/api/teams/${activeTenant!.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName.trim() }),
      });
      setEditingName(false);
      await loadTenants();
    } catch (e: any) {
      setError(e?.message || "Failed to rename team");
    }
  }

  const roleBadge = (role: string) => {
    const colors: Record<string, { bg: string; color: string; border: string }> = {
      admin: { bg: "#FEF3C7", color: "#D97706", border: "rgba(217,119,6,0.2)" },
      editor: { bg: "#EFF6FF", color: "#2563EB", border: "rgba(37,99,235,0.2)" },
      viewer: { bg: "#F3F4F6", color: "#6B7280", border: "rgba(156,163,175,0.2)" },
    };
    const c = colors[role] || colors.viewer;
    return (
      <span
        style={{
          display: "inline-flex",
          borderRadius: 999,
          padding: "3px 10px",
          fontSize: 11,
          fontWeight: 700,
          background: c.bg,
          color: c.color,
          border: `1px solid ${c.border}`,
          textTransform: "capitalize",
        }}
      >
        {role}
      </span>
    );
  };

  if (loading) {
    return (
      <div style={S.card}>
        <div style={{ padding: 40, textAlign: "center", color: C.textSecondary }}>Loading team data...</div>
      </div>
    );
  }

  return (
    <>
      <div style={S.titleRow}>
        <div>
          <h1 style={S.pageTitle}>Team Management</h1>
          <p style={S.pageSubtitle}>Manage your team members and permissions.</p>
        </div>
        <div style={S.titleActions}>
          <button type="button" onClick={() => setShowCreateTeam(true)} style={S.addBtn}>
            <Icon name="plus" />
            <span>New Team</span>
          </button>
        </div>
      </div>

      {error && <div style={S.errorBanner}>{error}</div>}

      {/* Team selector */}
      {tenants.length > 1 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {tenants.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => switchTenant(t.id)}
              style={{
                padding: "8px 16px",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                border: t.is_active ? `2px solid ${C.primary}` : `1px solid ${C.cardBorder}`,
                background: t.is_active ? C.primaryLighter : C.card,
                color: t.is_active ? "#1A3C34" : C.text,
              }}
            >
              {t.name}
              {t.is_active && " ✓"}
            </button>
          ))}
        </div>
      )}

      {activeTenant && (
        <>
          {/* Team info card */}
          <div style={S.card}>
            <div style={S.cardHeader}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {editingName ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      style={{ ...S.projectInput, minWidth: 200 }}
                      autoFocus
                      onKeyDown={(e) => e.key === "Enter" && handleRename()}
                    />
                    <button type="button" style={{ ...S.addBtn, padding: "8px 14px" }} onClick={handleRename}>Save</button>
                    <button type="button" style={{ ...S.importBtn, padding: "8px 14px" }} onClick={() => setEditingName(false)}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <span style={S.cardTitle}>{activeTenant.name}</span>
                    {roleBadge(activeTenant.role)}
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => { setEditName(activeTenant.name); setEditingName(true); }}
                        style={{ background: "none", border: "none", color: C.primary, cursor: "pointer", fontSize: 12, fontWeight: 700 }}
                      >
                        Rename
                      </button>
                    )}
                  </>
                )}
              </div>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => { setInviteEmail(""); setInviteRole("viewer"); setInviteError(null); setShowInvite(true); }}
                  style={S.addBtn}
                >
                  <Icon name="plus" />
                  <span>Invite Member</span>
                </button>
              )}
            </div>

            {/* Members table */}
            <div style={S.tableScrollWrapper}>
              <div style={{ ...S.tableHead, gridTemplateColumns: "1fr 180px 120px 120px" }}>
                <span>Member</span>
                <span>Email</span>
                <span>Role</span>
                <span style={{ textAlign: "right" }}>Actions</span>
              </div>

              {members.length === 0 ? (
                <div style={S.emptyRow}>No members found.</div>
              ) : (
                members.map((m, idx) => (
                  <div
                    key={m.member_id}
                    style={{
                      ...S.tableRow,
                      gridTemplateColumns: "1fr 180px 120px 120px",
                      background: idx % 2 === 0 ? C.card : "#FAFBFC",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 999,
                          background: C.primary,
                          color: C.white,
                          display: "grid",
                          placeItems: "center",
                          fontWeight: 700,
                          fontSize: 14,
                          flexShrink: 0,
                        }}
                      >
                        {m.name.charAt(0).toUpperCase()}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{m.name}</div>
                    </div>
                    <div style={{ fontSize: 12, color: C.textSecondary }}>{m.email}</div>
                    <div>
                      {isAdmin ? (
                        <select
                          value={m.role}
                          onChange={(e) => handleChangeRole(m.member_id, e.target.value)}
                          style={{
                            borderRadius: 8,
                            border: `1px solid ${C.cardBorder}`,
                            padding: "4px 8px",
                            fontSize: 12,
                            fontWeight: 600,
                            color: C.text,
                            cursor: "pointer",
                            background: C.card,
                          }}
                        >
                          <option value="admin">Admin</option>
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      ) : (
                        roleBadge(m.role)
                      )}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {isAdmin && m.role !== "admin" && (
                        <button
                          type="button"
                          onClick={() => handleRemoveMember(m.member_id)}
                          style={{
                            background: "none",
                            border: `1px solid rgba(220,38,38,0.3)`,
                            borderRadius: 8,
                            color: C.danger,
                            padding: "5px 12px",
                            fontSize: 11,
                            fontWeight: 700,
                            cursor: "pointer",
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div
              style={{
                padding: "12px 20px",
                borderTop: `1px solid ${C.cardBorder}`,
                fontSize: 12,
                color: C.textSecondary,
              }}
            >
              {members.length} member{members.length !== 1 ? "s" : ""} in this team
            </div>
          </div>

          {/* Permissions reference */}
          <div style={S.card}>
            <div style={S.cardHeader}>
              <span style={S.cardTitle}>Role Permissions</span>
            </div>
            <div style={{ padding: "16px 20px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, fontSize: 12 }}>
                <div style={{ fontWeight: 700, color: C.textSecondary }}>Permission</div>
                <div style={{ fontWeight: 700, color: "#D97706", textAlign: "center" }}>Admin</div>
                <div style={{ fontWeight: 700, color: "#2563EB", textAlign: "center" }}>Editor</div>
                <div style={{ fontWeight: 700, color: "#6B7280", textAlign: "center" }}>Viewer</div>

                {[
                  ["View projects", true, true, true],
                  ["Create & edit projects", true, true, false],
                  ["Run pipeline", true, true, false],
                  ["Export DXF", true, true, true],
                  ["Manage team members", true, false, false],
                  ["Change member roles", true, false, false],
                  ["Rename team", true, false, false],
                ].map(([label, admin, editor, viewer], i) => (
                  <div key={i} style={{ display: "contents" }}>
                    <div style={{ padding: "6px 0", color: C.text, fontWeight: 500, borderTop: `1px solid ${C.cardBorder}` }}>{label as string}</div>
                    <div style={{ padding: "6px 0", textAlign: "center", borderTop: `1px solid ${C.cardBorder}` }}>{admin ? "✓" : "—"}</div>
                    <div style={{ padding: "6px 0", textAlign: "center", borderTop: `1px solid ${C.cardBorder}` }}>{editor ? "✓" : "—"}</div>
                    <div style={{ padding: "6px 0", textAlign: "center", borderTop: `1px solid ${C.cardBorder}` }}>{viewer ? "✓" : "—"}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Invite Member Modal ── */}
      {showInvite && (
        <div style={WZ.overlay} onClick={() => setShowInvite(false)}>
          <div style={{ ...WZ.modal, maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div style={WZ.header}>
              <span style={WZ.headerTitle}>Invite Team Member</span>
              <button type="button" style={WZ.closeBtn} onClick={() => setShowInvite(false)}>&times;</button>
            </div>
            <div style={WZ.body}>
              <div style={WZ.stepContent}>
                <div style={WZ.fieldGroup}>
                  <label style={WZ.label}>Email Address</label>
                  <input
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="colleague@company.com"
                    type="email"
                    style={WZ.input}
                    autoFocus
                  />
                </div>
                <div style={WZ.fieldGroup}>
                  <label style={WZ.label}>Role</label>
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    style={WZ.select}
                  >
                    <option value="viewer">Viewer — Can view projects</option>
                    <option value="editor">Editor — Can create & edit projects</option>
                    <option value="admin">Admin — Full control</option>
                  </select>
                </div>
                {inviteError && (
                  <div style={{ ...S.errorBanner, fontSize: 12, padding: "8px 12px" }}>{inviteError}</div>
                )}
                <div style={WZ.btnRow}>
                  <button type="button" style={WZ.secondaryBtn} onClick={() => setShowInvite(false)}>Cancel</button>
                  <button
                    type="button"
                    style={WZ.primaryBtn}
                    onClick={handleInvite}
                    disabled={inviteLoading || !inviteEmail.trim()}
                  >
                    {inviteLoading ? "Inviting..." : "Invite"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Team Modal ── */}
      {showCreateTeam && (
        <div style={WZ.overlay} onClick={() => setShowCreateTeam(false)}>
          <div style={{ ...WZ.modal, maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div style={WZ.header}>
              <span style={WZ.headerTitle}>Create New Team</span>
              <button type="button" style={WZ.closeBtn} onClick={() => setShowCreateTeam(false)}>&times;</button>
            </div>
            <div style={WZ.body}>
              <div style={WZ.stepContent}>
                <div style={WZ.fieldGroup}>
                  <label style={WZ.label}>Team Name</label>
                  <input
                    value={newTeamName}
                    onChange={(e) => setNewTeamName(e.target.value)}
                    placeholder="e.g., Acme Fire Safety"
                    style={WZ.input}
                    autoFocus
                    onKeyDown={(e) => e.key === "Enter" && newTeamName.trim() && handleCreateTeam()}
                  />
                </div>
                <div style={WZ.btnRow}>
                  <button type="button" style={WZ.secondaryBtn} onClick={() => setShowCreateTeam(false)}>Cancel</button>
                  <button
                    type="button"
                    style={WZ.primaryBtn}
                    onClick={handleCreateTeam}
                    disabled={createLoading || !newTeamName.trim()}
                  >
                    {createLoading ? "Creating..." : "Create Team"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── SVG icons ────────────────────────────── */

function Icon({ name }: { name: IconName }) {
  const c = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (name) {
    case "dashboard":
      return (
        <svg {...c}>
          <rect x="3" y="3" width="7" height="9" rx="1" />
          <rect x="14" y="3" width="7" height="5" rx="1" />
          <rect x="14" y="12" width="7" height="9" rx="1" />
          <rect x="3" y="16" width="7" height="5" rx="1" />
        </svg>
      );
    case "tasks":
      return (
        <svg {...c}>
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...c}>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      );
    case "analytics":
      return (
        <svg {...c}>
          <path d="M18 20V10M12 20V4M6 20v-6" />
        </svg>
      );
    case "team":
      return (
        <svg {...c}>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "settings":
      return (
        <svg {...c}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "help":
      return (
        <svg {...c}>
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </svg>
      );
    case "logout":
      return (
        <svg {...c}>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      );
    case "search":
      return (
        <svg {...c}>
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
      );
    case "bell":
      return (
        <svg {...c}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    case "box":
      return (
        <svg {...c}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
      );
    case "check":
      return (
        <svg {...c}>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      );
    case "clock":
      return (
        <svg {...c}>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case "alert":
      return (
        <svg {...c}>
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case "plus":
      return (
        <svg {...c}>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      );
    case "download":
      return (
        <svg {...c}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      );
    case "chevronRight":
      return (
        <svg {...c} width={14} height={14}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      );
    case "play":
      return (
        <svg {...c}>
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      );
    case "pause":
      return (
        <svg {...c}>
          <rect x="6" y="4" width="4" height="16" />
          <rect x="14" y="4" width="4" height="16" />
        </svg>
      );
    case "projects":
      return (
        <svg {...c}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "billing":
      return (
        <svg {...c}>
          <rect x="1" y="4" width="22" height="16" rx="2" />
          <line x1="1" y1="10" x2="23" y2="10" />
        </svg>
      );
    case "creditCard":
      return (
        <svg {...c}>
          <rect x="1" y="4" width="22" height="16" rx="2" />
          <line x1="1" y1="10" x2="23" y2="10" />
        </svg>
      );
    case "receipt":
      return (
        <svg {...c}>
          <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z" />
          <path d="M8 8h8M8 12h8M8 16h4" />
        </svg>
      );
    case "wallet":
      return (
        <svg {...c}>
          <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
          <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
          <path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z" />
        </svg>
      );
    default:
      return <svg {...c} />;
  }
}
