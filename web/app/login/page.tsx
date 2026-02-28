"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiLogin } from "../lib/auth";

export default function LoginPage() {
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
      <div style={styles.card}>
        <div style={styles.brand}>FIRECAD</div>
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
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bg: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    background: "linear-gradient(135deg, #eef2ff 0%, #f7f9ff 55%, #eefaf6 100%)",
    padding: 18,
  },
  card: {
    width: "min(560px, 92vw)",
    borderRadius: 18,
    background: "rgba(255,255,255,0.86)",
    border: "1px solid rgba(20, 33, 61, 0.10)",
    boxShadow: "0 18px 40px rgba(20, 33, 61, 0.10)",
    padding: 22,
    textAlign: "center",
  },
  brand: {
    fontWeight: 900,
    letterSpacing: "0.28em",
    color: "#2563eb",
    fontSize: 13,
    marginBottom: 10,
  },
  title: { margin: 0, fontSize: 34, fontWeight: 900, color: "#111827" },
  sub: { marginTop: 10, marginBottom: 18, color: "rgba(27,36,64,0.70)", fontWeight: 600 },
  label: { display: "block", textAlign: "left", fontWeight: 800, color: "#111827", marginTop: 10, marginBottom: 6 },
  input: {
    width: "100%",
    borderRadius: 12,
    border: "1px solid rgba(20,33,61,0.14)",
    background: "rgba(255,255,255,0.92)",
    padding: "12px 12px",
    outline: "none",
    fontSize: 14,
  },
  btn: {
    width: "100%",
    marginTop: 16,
    borderRadius: 14,
    border: "1px solid rgba(37,99,235,0.30)",
    background: "linear-gradient(180deg, rgba(37,99,235,0.95), rgba(29,78,216,0.92))",
    color: "white",
    padding: "12px 14px",
    fontSize: 14,
    fontWeight: 900,
    cursor: "pointer",
    boxShadow: "0 10px 22px rgba(37,99,235,0.22)",
  },
  error: {
    marginTop: 12,
    borderRadius: 12,
    border: "1px solid rgba(239,68,68,0.18)",
    background: "rgba(239,68,68,0.08)",
    padding: "10px 12px",
    color: "#7f1d1d",
    fontWeight: 700,
    textAlign: "left",
  },
  footer: { marginTop: 14, color: "rgba(27,36,64,0.70)", fontWeight: 700 },
  link: { color: "#2563eb", textDecoration: "none", fontWeight: 900 },
};
