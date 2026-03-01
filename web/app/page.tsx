"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { clearAuth, getName, apiFetch } from "./lib/auth";
import { useRouter } from "next/navigation";

/* ── types ─────────────────────────────────── */

type Project = {
  id: string;
  name: string;
  status: string;
  error?: string | null;
};

type NavKey =
  | "dashboard"
  | "projects"
  | "tasks"
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
  { key: "tasks", label: "Tasks", icon: "tasks" },
  { key: "calendar", label: "Calendar", icon: "calendar" },
  { key: "analytics", label: "Analytics", icon: "analytics" },
  { key: "billing", label: "Billing", icon: "billing" },
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

/* ── component ─────────────────────────────── */

export default function Dashboard() {
  const router = useRouter();
  const [active, setActive] = useState<NavKey>("dashboard");
  const [projectName, setProjectName] = useState("New Building");
  const [projects, setProjects] = useState<Project[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userName, setUserName] = useState("User");
  const [searchQuery, setSearchQuery] = useState("");
  const [timerRunning, setTimerRunning] = useState(true);
  const [timerSeconds, setTimerSeconds] = useState(5048);

  useEffect(() => {
    setUserName(getName() || "User");
  }, []);

  useEffect(() => {
    if (!timerRunning) return;
    const interval = setInterval(() => setTimerSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [timerRunning]);

  const formattedTime = useMemo(() => {
    const h = Math.floor(timerSeconds / 3600);
    const m = Math.floor((timerSeconds % 3600) / 60);
    const s = timerSeconds % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [timerSeconds]);

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

  async function createProject() {
    setError(null);
    setIsCreating(true);
    try {
      const j: Project = await apiFetch("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: projectName }),
      });
      setProjects((prev) => [j, ...prev]);
      setProjectName("New Building");
    } catch (e: any) {
      setError(e?.message || "Could not create project.");
    } finally {
      setIsCreating(false);
    }
  }

  const stats = useMemo(() => {
    const total = projects.length;
    const ready = projects.filter((p) => (p.status || "").toLowerCase() === "ready").length;
    const running = projects.filter((p) => (p.status || "").toLowerCase() === "running").length;
    const pending = projects.filter(
      (p) => !["ready", "running", "failed"].includes((p.status || "").toLowerCase())
    ).length;
    const failed = projects.filter((p) => (p.status || "").toLowerCase() === "failed").length;
    return { total, ready, running, pending, failed };
  }, [projects]);

  function signOut() {
    clearAuth();
    router.push("/login");
  }

  /* ─ mock data for dashboard widgets ─ */
  const projectTasks = [
    { label: "Design API Endpoints", done: true },
    { label: "Create Data Models", done: true },
    { label: "Onboarding Flow", done: false },
    { label: "Build Dashboard", done: false },
    { label: "Optimize Page Load", done: false },
    { label: "Cross-Browser Testing", done: false },
  ];

  const teamMembers = [
    { name: "Alexandra Craft", role: "Project Management", color: "#2D6A4F" },
    { name: "Ethan Alperda", role: "Project Repository", color: "#40916C" },
    { name: "Diana Chakaborina", role: "Administrative Support", color: "#52B788" },
    { name: "David Olenzoal", role: "Project Template Technologist", color: "#1B4332" },
  ];

  return (
    <main style={S.shell}>
      {/* ── sidebar ── */}
      <aside style={S.sidebar}>
        <div style={S.brandRow}>
          <div style={S.brandIcon}>
            <Icon name="box" />
          </div>
          <span style={S.brandText}>FireCAD</span>
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

        {/* download CTA */}
        <div style={S.downloadCta}>
          <div style={S.downloadIcon}>
            <Icon name="download" />
          </div>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Download our</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.65)" }}>Mobile App</div>
          <button type="button" style={S.downloadBtn}>Download</button>
        </div>
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
              placeholder="Search task …"
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
                <div style={S.headerUserRole}>Manager</div>
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
                  Plan, prioritize, and complete your projects with ease.
                </p>
              </div>
              <div style={S.titleActions}>
                <input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="Project name"
                  style={S.projectInput}
                />
                <button type="button" onClick={createProject} disabled={isCreating} style={S.addBtn}>
                  <Icon name="plus" />
                  <span>{isCreating ? "Creating…" : "Add Project"}</span>
                </button>
                <button type="button" onClick={loadProjects} disabled={isLoading} style={S.importBtn}>
                  <Icon name="download" />
                  <span>{isLoading ? "Loading…" : "Import Data"}</span>
                </button>
              </div>
            </div>

            {error && <div style={S.errorBanner}>{error}</div>}

            {/* KPI cards */}
            <div style={S.kpiRow}>
              <KpiCard label="Total Projects" value={stats.total} sub="Increased from last month" color={C.primary} bgColor="#E8F5E9" icon="box" />
              <KpiCard label="Ended Projects" value={stats.ready} sub="Increased from last week" color={C.textSecondary} bgColor="#F5F5F5" icon="check" />
              <KpiCard label="Running Projects" value={stats.running} sub="Increased from last month" color={C.textSecondary} bgColor="#F5F5F5" icon="clock" />
              <KpiCard label="Pending Projects" value={stats.pending} sub={stats.failed > 0 ? `${stats.failed} failed` : "On track"} color={C.textSecondary} bgColor="#F5F5F5" icon="alert" />
            </div>

            {/* row 2: analytics + reminders + project tasks */}
            <div style={S.gridRow3}>
              <div style={S.card}>
                <div style={S.cardHeader}><span style={S.cardTitle}>Project Analytics</span></div>
                <div style={S.analyticsChart}>
                  {[65, 85, 45, 75, 90, 55, 70, 80].map((h, i) => (
                    <div key={i} style={S.barCol}>
                      <div style={{ ...S.bar, height: `${h}%`, background: i % 2 === 0 ? `linear-gradient(180deg, ${C.primary}, ${C.primaryLight})` : `linear-gradient(180deg, ${C.accent}, ${C.primaryLighter})`, borderRadius: 8 }} />
                    </div>
                  ))}
                </div>
              </div>

              <div style={S.card}>
                <div style={S.cardHeader}><span style={S.cardTitle}>Reminders</span><span style={S.badge}>New</span></div>
                <div style={S.reminderCard}>
                  <div style={S.reminderDot} />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: C.text }}>Meeting with Architecture Company</div>
                    <div style={{ fontSize: 12, color: C.textSecondary, marginTop: 4 }}>Sprint review &amp; planning session</div>
                    <button type="button" style={S.reminderBtn}>Start Meeting</button>
                  </div>
                </div>
              </div>

              <div style={S.card}>
                <div style={S.cardHeader}><span style={S.cardTitle}>Project</span><span style={S.badge}>New</span></div>
                <div style={S.taskList}>
                  {projectTasks.map((t, i) => (
                    <label key={i} style={S.taskItem}>
                      <span style={{ ...S.taskCheck, background: t.done ? C.primary : C.white, border: t.done ? `2px solid ${C.primary}` : `2px solid ${C.cardBorder}` }}>
                        {t.done && (<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>)}
                      </span>
                      <span style={{ fontSize: 13, color: t.done ? C.textMuted : C.text, textDecoration: t.done ? "line-through" : "none" }}>{t.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* row 3: team + progress + timer */}
            <div style={S.gridRow3b}>
              <div style={S.card}>
                <div style={S.cardHeader}><span style={S.cardTitle}>Team Collaboration</span><button type="button" style={S.addMemberBtn}>+ Add Member</button></div>
                <div style={S.teamList}>
                  {teamMembers.map((m, i) => (
                    <div key={i} style={S.teamRow}>
                      <div style={{ ...S.teamAvatar, background: m.color }}>{m.name.charAt(0)}</div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{m.name}</div>
                        <div style={{ fontSize: 11, color: C.textSecondary }}>{m.role}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={S.card}>
                <div style={S.cardHeader}><span style={S.cardTitle}>Project Progress</span></div>
                <div style={S.progressCenter}>
                  <div style={S.progressRing}>
                    <svg width="120" height="120" viewBox="0 0 120 120">
                      <circle cx="60" cy="60" r="52" fill="none" stroke={C.cardBorder} strokeWidth="8" />
                      <circle cx="60" cy="60" r="52" fill="none" stroke={C.primary} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${2 * Math.PI * 52}`} strokeDashoffset={`${2 * Math.PI * 52 * (1 - (stats.total > 0 ? stats.ready / stats.total : 0.41))}`} transform="rotate(-90 60 60)" />
                    </svg>
                    <div style={S.progressText}>{stats.total > 0 ? Math.round((stats.ready / stats.total) * 100) : 41}%</div>
                  </div>
                  <div style={S.progressLegend}>
                    <span style={S.legendDot} /> In Progress &nbsp;
                    <span style={{ ...S.legendDot, background: C.primaryLight }} /> Completed
                  </div>
                </div>
              </div>

              <div style={{ ...S.card, background: C.sidebar, color: C.white }}>
                <div style={S.cardHeader}><span style={{ ...S.cardTitle, color: C.white }}>Time Tracker</span></div>
                <div style={S.timerCenter}>
                  <div style={S.timerDisplay}>{formattedTime}</div>
                  <div style={S.timerControls}>
                    <button type="button" onClick={() => setTimerRunning(!timerRunning)} style={S.timerBtn}>
                      <Icon name={timerRunning ? "pause" : "play"} />
                    </button>
                  </div>
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
                <input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="Project name"
                  style={S.projectInput}
                />
                <button type="button" onClick={createProject} disabled={isCreating} style={S.addBtn}>
                  <Icon name="plus" />
                  <span>{isCreating ? "Creating…" : "Add Project"}</span>
                </button>
                <button type="button" onClick={loadProjects} disabled={isLoading} style={S.importBtn}>
                  <Icon name="download" />
                  <span>{isLoading ? "Loading…" : "Refresh"}</span>
                </button>
              </div>
            </div>

            {error && <div style={S.errorBanner}>{error}</div>}

            {/* stats strip */}
            <div style={S.kpiRow}>
              <KpiCard label="Total" value={stats.total} sub="All projects" color={C.primary} bgColor="#E8F5E9" icon="box" />
              <KpiCard label="Ready" value={stats.ready} sub="Completed" color={C.success} bgColor="#ECFDF5" icon="check" />
              <KpiCard label="Running" value={stats.running} sub="In progress" color={C.info} bgColor="#EFF6FF" icon="clock" />
              <KpiCard label="Failed" value={stats.failed} sub="Need attention" color={C.danger} bgColor="#FEF2F2" icon="alert" />
            </div>

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
              <div style={{ ...S.tableHead, gridTemplateColumns: "1fr 140px 140px 120px" }}>
                <span>Project Name</span>
                <span>Status</span>
                <span>Created</span>
                <span style={{ textAlign: "right" }}>Action</span>
              </div>

              {projects.length === 0 ? (
                <div style={S.emptyRow}>
                  No projects yet. Create your first project above.
                </div>
              ) : (
                projects.map((p, idx) => (
                  <div key={p.id} style={{ ...S.tableRow, gridTemplateColumns: "1fr 140px 140px 120px", background: idx % 2 === 0 ? C.card : "#FAFBFC" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 2 }}>{p.id}</div>
                    </div>
                    <div><span style={statusChip(p.status)}>{p.status}</span></div>
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

        {/* ═══════ TAB: BILLING ═══════ */}
        {active === "billing" && <BillingTab />}

        {/* ═══════ PLACEHOLDER TABS ═══════ */}
        {!["dashboard", "projects", "billing"].includes(active) && (
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
