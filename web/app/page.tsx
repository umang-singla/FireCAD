"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { clearAuth, getName, apiFetch } from "./lib/auth";
import { useRouter } from "next/navigation";

type Project = {
  id: string;
  name: string;
  status: string;
  error?: string | null;
};

type NavKey = "home" | "workspace" | "search" | "profile" | "settings";

type IconName =
  | "home"
  | "grid"
  | "search"
  | "user"
  | "settings"
  | "logout"
  | "spark"
  | "box"
  | "check"
  | "clock"
  | "alert";

const NAV: Array<{ key: NavKey; label: string; icon: IconName }> = [
  { key: "home", label: "Home", icon: "home" },
  { key: "workspace", label: "Workspace", icon: "grid" },
  { key: "search", label: "Search", icon: "search" },
  { key: "profile", label: "Profile", icon: "user" },
  { key: "settings", label: "Settings", icon: "settings" },
];

export default function Dashboard() {
  const router = useRouter();
  const [active, setActive] = useState<NavKey>("home");
  const [projectName, setProjectName] = useState("New Building");
  const [projects, setProjects] = useState<Project[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userName, setUserName] = useState("User");

  useEffect(() => {
    setUserName(getName() || "User");
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
      setActive("home");
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
    const failed = projects.filter((p) => (p.status || "").toLowerCase() === "failed").length;
    return { total, ready, running, failed };
  }, [projects]);

  const showProjects = active === "home" || active === "workspace";

  function signOut() {
    clearAuth();
    router.push("/login");
  }

  return (
    <main style={styles.shell}>
      <div style={styles.bgGlow1} />
      <div style={styles.bgGlow2} />
      <div style={styles.bgGrid} />

      <aside style={styles.sidebar}>
        <div style={styles.brandRow}>
          <div style={styles.brandMark}>✶</div>
          <div style={styles.brandText}>FireCAD</div>
        </div>

        <nav style={styles.nav}>
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActive(item.key)}
              style={navItemStyle(active === item.key)}
            >
              <span style={styles.navIcon}>
                <Icon name={item.icon} />
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div style={styles.userBlock}>
          <div style={styles.userRow}>
            <div style={styles.avatar} />
            <div>
              <div style={styles.userName}>{userName}</div>
              <div style={styles.userSub}>Workspace</div>
            </div>
          </div>

          <button type="button" onClick={signOut} style={styles.signOut}>
            <span style={{ display: "inline-flex", width: 18 }}>
              <Icon name="logout" />
            </span>
            Sign out
          </button>
        </div>
      </aside>

      <section style={styles.content}>
        <header style={styles.welcomeCard}>
          <div style={styles.welcomeLeft}>
            <div style={styles.welcomeBadge}>
              <Icon name="spark" />
            </div>
            <div>
              <div style={styles.welcomeTitle}>Welcome Back, {userName}</div>
              <div style={styles.welcomeSub}>
                Manage your workspace files and track project progress
              </div>
            </div>
          </div>

          <div style={styles.topActions}>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Project name"
              style={styles.input}
            />
            <button
              type="button"
              onClick={createProject}
              style={styles.primaryBtn}
              disabled={isCreating}
            >
              {isCreating ? "Creating…" : "+ Create Project"}
            </button>
            <button
              type="button"
              onClick={loadProjects}
              style={styles.secondaryBtn}
              disabled={isLoading}
            >
              {isLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        <div style={styles.kpiGrid}>
          <KpiCard label="Total Projects" value={`${stats.total}`} icon="box" />
          <KpiCard label="Ready" value={`${stats.ready}`} icon="check" />
          <KpiCard label="Running" value={`${stats.running}`} icon="clock" />
          <KpiCard label="Failed" value={`${stats.failed}`} icon="alert" />
        </div>

        {error ? <div style={styles.error}>{error}</div> : null}

        {!showProjects ? (
          <div style={styles.placeholder}>
            <div style={styles.placeholderTitle}>
              {NAV.find((n) => n.key === active)?.label}
            </div>
            <div style={styles.placeholderText}>
              This section is a placeholder. Use <b>Home</b> / <b>Workspace</b> to create and open
              projects.
            </div>
          </div>
        ) : (
          <section style={styles.panel}>
            <div style={styles.panelHeader}>
              <div>
                <div style={styles.panelTitle}>Projects</div>
                <div style={styles.panelSub}>
                  Open an existing workspace or create a new one.
                </div>
              </div>
            </div>

            <div style={styles.table}>
              <div style={styles.tableHead}>
                <span>Name</span>
                <span>Status</span>
                <span style={{ textAlign: "right" }}>Action</span>
              </div>

              {projects.length === 0 ? (
                <div style={styles.emptyRow}>
                  No projects yet. Create your first project to get started.
                </div>
              ) : (
                projects.map((p) => (
                  <div key={p.id} style={styles.tableRow}>
                    <div>
                      <div style={styles.projectName}>{p.name}</div>
                      <div style={styles.projectMeta}>{p.id}</div>
                    </div>

                    <div style={statusChipStyle(p.status)}>{p.status}</div>

                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <a href={`/p/${p.id}`} style={styles.openLink}>
                        Open
                      </a>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        <style jsx>{`
          input::placeholder {
            color: rgba(40, 52, 89, 0.55);
          }
          a:hover {
            opacity: 0.92;
          }
        `}</style>
      </section>
    </main>
  );
}

function KpiCard({ label, value, icon }: { label: string; value: string; icon: IconName }) {
  return (
    <div style={styles.kpiCard}>
      <div style={styles.kpiIcon}>
        <Icon name={icon} />
      </div>
      <div>
        <div style={styles.kpiValue}>{value}</div>
        <div style={styles.kpiLabel}>{label}</div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  shell: {
    minHeight: "100vh",
    display: "grid",
    gridTemplateColumns: "260px 1fr",
    gap: "18px",
    padding: "18px",
    position: "relative",
    overflow: "hidden",
    background: "linear-gradient(135deg, #eef2ff 0%, #f7f9ff 55%, #eefaf6 100%)",
  },
  bgGlow1: {
    position: "absolute",
    top: "-160px",
    left: "-160px",
    width: 520,
    height: 520,
    borderRadius: 999,
    background: "rgba(99, 102, 241, 0.14)",
    filter: "blur(90px)",
    pointerEvents: "none",
  },
  bgGlow2: {
    position: "absolute",
    bottom: "-170px",
    right: "-180px",
    width: 560,
    height: 560,
    borderRadius: 999,
    background: "rgba(16, 185, 129, 0.12)",
    filter: "blur(100px)",
    pointerEvents: "none",
  },
  bgGrid: {
    position: "absolute",
    inset: 0,
    backgroundImage:
      "linear-gradient(rgba(20, 33, 61, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(20, 33, 61, 0.05) 1px, transparent 1px)",
    backgroundSize: "64px 64px",
    opacity: 0.35,
    pointerEvents: "none",
  },

  sidebar: {
    zIndex: 1,
    borderRadius: 18,
    background: "rgba(255,255,255,0.86)",
    border: "1px solid rgba(20, 33, 61, 0.10)",
    boxShadow: "0 18px 40px rgba(20, 33, 61, 0.10)",
    padding: 14,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  brandRow: { display: "flex", alignItems: "center", gap: 10, padding: "6px 8px" },
  brandMark: {
    width: 30,
    height: 30,
    borderRadius: 10,
    display: "grid",
    placeItems: "center",
    background: "linear-gradient(180deg, rgba(99,102,241,0.18), rgba(99,102,241,0.06))",
    border: "1px solid rgba(99,102,241,0.22)",
    color: "#2b2f55",
    fontWeight: 700,
  },
  brandText: { fontWeight: 700, color: "#1b2440", letterSpacing: "-0.01em" },

  nav: { display: "flex", flexDirection: "column", gap: 6, padding: "6px 6px" },
  navIcon: { width: 18, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center" },

  userBlock: {
    marginTop: "auto",
    borderTop: "1px solid rgba(20, 33, 61, 0.10)",
    paddingTop: 12,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  userRow: { display: "flex", alignItems: "center", gap: 10, padding: "8px 8px" },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 999,
    background: "linear-gradient(180deg, rgba(30, 41, 59, 0.22), rgba(30, 41, 59, 0.10))",
    border: "1px solid rgba(30, 41, 59, 0.18)",
  },
  userName: { fontSize: 13, fontWeight: 700, color: "#1b2440" },
  userSub: { fontSize: 12, color: "rgba(27, 36, 64, 0.60)", marginTop: 2 },
  signOut: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    border: "1px solid rgba(20, 33, 61, 0.12)",
    background: "rgba(255,255,255,0.70)",
    padding: "10px 10px",
    cursor: "pointer",
    color: "#1b2440",
    fontWeight: 600,
    fontSize: 13,
    textAlign: "left",
  },

  content: { zIndex: 1, display: "flex", flexDirection: "column", gap: 12 },

  welcomeCard: {
    borderRadius: 16,
    border: "1px solid rgba(20, 33, 61, 0.10)",
    background: "rgba(255,255,255,0.78)",
    boxShadow: "0 18px 40px rgba(20, 33, 61, 0.08)",
    padding: "14px 14px",
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  },
  welcomeLeft: { display: "flex", alignItems: "center", gap: 10, minWidth: 240 },
  welcomeBadge: {
    width: 34,
    height: 34,
    borderRadius: 12,
    display: "grid",
    placeItems: "center",
    background: "linear-gradient(180deg, rgba(99,102,241,0.18), rgba(99,102,241,0.06))",
    border: "1px solid rgba(99,102,241,0.20)",
    color: "#1b2440",
  },
  welcomeTitle: { fontWeight: 800, color: "#1b2440", letterSpacing: "-0.01em" },
  welcomeSub: { marginTop: 2, fontSize: 12, color: "rgba(27, 36, 64, 0.62)" },

  topActions: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  input: {
    minWidth: 220,
    borderRadius: 12,
    border: "1px solid rgba(20, 33, 61, 0.14)",
    background: "rgba(255,255,255,0.82)",
    padding: "10px 12px",
    outline: "none",
    color: "#1b2440",
    fontSize: 13,
  },
  primaryBtn: {
    borderRadius: 12,
    border: "1px solid rgba(99,102,241,0.35)",
    background: "linear-gradient(180deg, rgba(99,102,241,0.95), rgba(79,70,229,0.92))",
    color: "white",
    padding: "10px 12px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 10px 22px rgba(99,102,241,0.20)",
  },
  secondaryBtn: {
    borderRadius: 12,
    border: "1px solid rgba(20, 33, 61, 0.14)",
    background: "rgba(255,255,255,0.72)",
    color: "#1b2440",
    padding: "10px 12px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },

  kpiGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 },
  kpiCard: {
    borderRadius: 16,
    border: "1px solid rgba(20, 33, 61, 0.10)",
    background: "rgba(255,255,255,0.78)",
    boxShadow: "0 14px 34px rgba(20, 33, 61, 0.08)",
    padding: "14px 14px",
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  kpiIcon: {
    width: 40,
    height: 40,
    borderRadius: 14,
    display: "grid",
    placeItems: "center",
    border: "1px solid rgba(20, 33, 61, 0.10)",
    background: "rgba(238, 242, 255, 0.9)",
    color: "#1b2440",
  },
  kpiValue: { fontSize: 22, fontWeight: 900, color: "#111827", letterSpacing: "-0.02em" },
  kpiLabel: { marginTop: 2, fontSize: 12, color: "rgba(27, 36, 64, 0.62)", fontWeight: 600 },

  error: {
    borderRadius: 14,
    border: "1px solid rgba(239, 68, 68, 0.18)",
    background: "rgba(239, 68, 68, 0.08)",
    padding: "12px 14px",
    color: "#7f1d1d",
    fontWeight: 600,
  },

  panel: {
    borderRadius: 18,
    border: "1px solid rgba(20, 33, 61, 0.10)",
    background: "rgba(255,255,255,0.78)",
    boxShadow: "0 18px 40px rgba(20, 33, 61, 0.08)",
    overflow: "hidden",
  },
  panelHeader: {
    padding: "14px 14px",
    borderBottom: "1px solid rgba(20, 33, 61, 0.08)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  panelTitle: { fontSize: 14, fontWeight: 900, color: "#111827", letterSpacing: "-0.01em" },
  panelSub: { marginTop: 4, fontSize: 12, color: "rgba(27, 36, 64, 0.62)", fontWeight: 600 },

  tableHead: {
    display: "grid",
    gridTemplateColumns: "1fr 160px 120px",
    gap: 12,
    padding: "10px 14px",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "rgba(27, 36, 64, 0.62)",
    background: "rgba(238, 242, 255, 0.55)",
    borderBottom: "1px solid rgba(20, 33, 61, 0.08)",
  },
  tableRow: {
    display: "grid",
    gridTemplateColumns: "1fr 160px 120px",
    gap: 12,
    alignItems: "center",
    padding: "12px 14px",
    borderBottom: "1px solid rgba(20, 33, 61, 0.06)",
  },
  emptyRow: {
    padding: "18px 14px",
    color: "rgba(27, 36, 64, 0.70)",
    fontWeight: 600,
    textAlign: "center",
  },
  projectName: { fontSize: 13, fontWeight: 800, color: "#111827" },
  projectMeta: { marginTop: 3, fontSize: 12, color: "rgba(27, 36, 64, 0.62)" },
  openLink: {
    textDecoration: "none",
    border: "1px solid rgba(99,102,241,0.30)",
    borderRadius: 12,
    color: "#1b2440",
    padding: "8px 10px",
    textAlign: "center",
    background: "rgba(99,102,241,0.10)",
    fontSize: 13,
    fontWeight: 800,
  },

  placeholder: {
    borderRadius: 18,
    border: "1px solid rgba(20, 33, 61, 0.10)",
    background: "rgba(255,255,255,0.78)",
    boxShadow: "0 18px 40px rgba(20, 33, 61, 0.08)",
    padding: 18,
  },
  placeholderTitle: { fontWeight: 900, color: "#111827" },
  placeholderText: { marginTop: 6, color: "rgba(27, 36, 64, 0.70)", lineHeight: 1.5, fontWeight: 600, fontSize: 13 },
};

function navItemStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    borderRadius: 12,
    border: active ? "1px solid rgba(99,102,241,0.26)" : "1px solid transparent",
    background: active ? "rgba(99,102,241,0.10)" : "transparent",
    padding: "10px 10px",
    cursor: "pointer",
    color: "#1b2440",
    fontWeight: active ? 800 : 700,
    textAlign: "left",
  };
}

function statusChipStyle(status: string): CSSProperties {
  const normalized = (status || "").toLowerCase();
  const isReady = normalized === "ready";
  const isRunning = normalized === "running";
  const isFailed = normalized === "failed";

  const bg = isReady
    ? "rgba(16, 185, 129, 0.12)"
    : isRunning
    ? "rgba(59, 130, 246, 0.12)"
    : isFailed
    ? "rgba(239, 68, 68, 0.12)"
    : "rgba(107, 114, 128, 0.12)";

  const border = isReady
    ? "rgba(16, 185, 129, 0.22)"
    : isRunning
    ? "rgba(59, 130, 246, 0.22)"
    : isFailed
    ? "rgba(239, 68, 68, 0.22)"
    : "rgba(107, 114, 128, 0.20)";

  const color = isReady
    ? "#065f46"
    : isRunning
    ? "#1e3a8a"
    : isFailed
    ? "#7f1d1d"
    : "#374151";

  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    border: `1px solid ${border}`,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 800,
    textTransform: "capitalize",
    width: "fit-content",
    background: bg,
    color,
  };
}

function Icon({ name }: { name: IconName }) {
  const common = {
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
    case "home":
      return (
        <svg {...common}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V21h14V9.5" />
        </svg>
      );
    case "grid":
      return (
        <svg {...common}>
          <path d="M4 4h7v7H4z" />
          <path d="M13 4h7v7h-7z" />
          <path d="M4 13h7v7H4z" />
          <path d="M13 13h7v7h-7z" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
      );
    case "user":
      return (
        <svg {...common}>
          <path d="M20 21a8 8 0 0 0-16 0" />
          <circle cx="12" cy="8" r="4" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
          <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04-1.6 2.76-.06-.02a2 2 0 0 0-1.96.46l-.06.06-3.2-1.84a6.7 6.7 0 0 1-1.12.65L10 21H7l-.74-2.42a6.7 6.7 0 0 1-1.12-.65L1.94 19.8l-.06-.06a2 2 0 0 0-1.96-.46l-.06.02-1.6-2.76.04-.04A1.8 1.8 0 0 0-3 15.5V12.5A1.8 1.8 0 0 0-2.64 10.5l-.04-.04 1.6-2.76.06.02a2 2 0 0 0 1.96-.46l.06-.06 3.2 1.84c.36-.25.73-.47 1.12-.65L7 3h3l.74 2.42c.39.18.76.4 1.12.65l3.2-1.84.06.06a2 2 0 0 0 1.96.46l.06-.02 1.6 2.76-.04.04A1.8 1.8 0 0 0 19.4 9.5V12.5" />
        </svg>
      );
    case "logout":
      return (
        <svg {...common}>
          <path d="M10 17l5-5-5-5" />
          <path d="M15 12H3" />
          <path d="M21 21V3" />
        </svg>
      );
    case "spark":
      return (
        <svg {...common}>
          <path d="M12 2l1.2 4.2L17 7.4l-3.8 1.2L12 13l-1.2-4.4L7 7.4l3.8-1.2L12 2z" />
          <path d="M19 13l.7 2.4L22 16l-2.3.6L19 19l-.7-2.4L16 16l2.3-.6L19 13z" />
        </svg>
      );
    case "box":
      return (
        <svg {...common}>
          <path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <path d="M3.3 7.6 12 12l8.7-4.4" />
          <path d="M12 22V12" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v6l4 2" />
        </svg>
      );
    case "alert":
      return (
        <svg {...common}>
          <path d="M10.3 3.6 1.7 18.5A2 2 0 0 0 3.4 21h17.2a2 2 0 0 0 1.7-2.5L13.7 3.6a2 2 0 0 0-3.4 0z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      );
    default:
      return <svg {...common} />;
  }
}
