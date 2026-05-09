"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiLogin } from "../lib/auth";

export default function LoginPage() {
  return (
    <Suspense fallback={<div style={styles.bg} />}>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp.get("next") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await apiLogin(email, password);
      router.push(next);
    } catch (e: any) {
      setErr(e?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.bg}>
      <div style={styles.card} className="login-card">
        <section style={styles.hero}>
          <div style={styles.brand}>MEPIT.AI</div>
          <h1 style={styles.heroTitle}>Modern fire-safety CAD workflow</h1>
          <p style={styles.heroSub}>
            Upload, align, detect rooms, and export clean DXF outputs with a streamlined pipeline.
          </p>
          <div style={styles.heroPill}>Secure workspace access</div>
        </section>

        <section style={styles.formPanel}>
          <h1 style={styles.title}>Welcome back</h1>
          <p style={styles.sub}>Sign in to continue automating MEP drawings.</p>

          <form onSubmit={onSubmit} style={{ width: "100%" }}>
            <label style={styles.label}>Email</label>
            <input
              style={styles.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              type="email"
              required
            />

            <div style={{ height: 12 }} />

            <label style={styles.label}>Password</label>
            <input
              style={styles.input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="********"
              type="password"
              required
            />

            {err ? <div style={styles.error}>{err}</div> : null}

            <button type="submit" style={styles.btn} disabled={loading}>
              {loading ? "Signing in…" : "Sign in to your account →"}
            </button>
          </form>

          <div style={styles.footer}>
            New here? <a href="/signup" style={styles.link}>Create account →</a>
          </div>
        </section>
      </div>

      <style jsx>{`
        .login-card {
          grid-template-columns: 1.1fr 1fr;
        }
        @media (max-width: 900px) {
          .login-card {
            grid-template-columns: 1fr;
          }
        }
        input::placeholder {
          color: rgba(200, 240, 220, 0.55);
        }
      `}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bg: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    background:
      "radial-gradient(circle at 8% 18%, rgba(45, 106, 79, 0.25) 0%, transparent 35%), radial-gradient(circle at 82% 86%, rgba(82, 183, 136, 0.18) 0%, transparent 34%), linear-gradient(130deg, #0A1F13 0%, #0D2818 45%, #132B1E 100%)",
    padding: 18,
  },
  card: {
    width: "min(980px, 95vw)",
    borderRadius: 22,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "linear-gradient(160deg, rgba(255,255,255,0.13), rgba(255,255,255,0.05))",
    boxShadow: "0 24px 64px rgba(0,0,0,0.34)",
    backdropFilter: "blur(10px)",
    padding: 18,
    display: "grid",
    gap: 16,
  },
  hero: {
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(13, 30, 20, 0.58)",
    padding: "22px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    minHeight: 420,
  },
  brand: {
    fontWeight: 900,
    letterSpacing: "0.28em",
    color: "#D8F3DC",
    fontSize: 13,
    marginBottom: 14,
  },
  heroTitle: {
    margin: 0,
    fontSize: 34,
    lineHeight: 1.15,
    fontWeight: 900,
    color: "#F0FFF4",
  },
  heroSub: {
    marginTop: 14,
    marginBottom: 18,
    color: "rgba(240,255,244,0.78)",
    fontWeight: 600,
    lineHeight: 1.45,
  },
  heroPill: {
    alignSelf: "flex-start",
    borderRadius: 999,
    border: "1px solid rgba(82, 183, 136, 0.45)",
    background: "rgba(45, 106, 79, 0.22)",
    color: "#D8F3DC",
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 800,
  },
  formPanel: {
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(10, 26, 16, 0.72)",
    padding: 22,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
  },
  title: { margin: 0, fontSize: 30, fontWeight: 900, color: "#F0FFF4" },
  sub: { marginTop: 10, marginBottom: 18, color: "rgba(240,255,244,0.72)", fontWeight: 600 },
  label: { display: "block", textAlign: "left", fontWeight: 800, color: "#F0FFF4", marginTop: 10, marginBottom: 6 },
  input: {
    width: "100%",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(13, 30, 20, 0.76)",
    padding: "12px 12px",
    outline: "none",
    fontSize: 14,
    color: "#F0FFF4",
  },
  btn: {
    width: "100%",
    marginTop: 16,
    borderRadius: 14,
    border: "1px solid rgba(82, 183, 136, 0.75)",
    background: "linear-gradient(180deg, #40916C 0%, #2D6A4F 100%)",
    color: "white",
    padding: "12px 14px",
    fontSize: 14,
    fontWeight: 900,
    cursor: "pointer",
    boxShadow: "0 10px 24px rgba(45, 106, 79, 0.42)",
  },
  error: {
    marginTop: 12,
    borderRadius: 12,
    border: "1px solid rgba(255, 136, 136, 0.35)",
    background: "rgba(255, 102, 102, 0.12)",
    padding: "10px 12px",
    color: "#ffd7d7",
    fontWeight: 700,
    textAlign: "left",
  },
  footer: { marginTop: 14, color: "rgba(240,255,244,0.72)", fontWeight: 700 },
  link: { color: "#95D5B2", textDecoration: "none", fontWeight: 900 },
};
