const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

const TOKEN_KEY = "firecad_token";
const NAME_KEY = "firecad_name";

function setCookie(name: string, value: string, maxAgeSec = 60 * 60 * 24 * 7) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax`;
}

function getCookie(name: string) {
  if (typeof document === "undefined") return null;
  const parts = document.cookie.split(";").map((p) => p.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

function clearCookie(name: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function setAuth(token: string, name?: string) {
  setCookie(TOKEN_KEY, token);
  if (name) setCookie(NAME_KEY, name);

  // optional localStorage fallback (not used by middleware)
  if (typeof window !== "undefined") {
    localStorage.setItem(TOKEN_KEY, token);
    if (name) localStorage.setItem(NAME_KEY, name);
  }
}

export function getToken() {
  return (
    getCookie(TOKEN_KEY) ||
    (typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null)
  );
}

export function getName() {
  return (
    getCookie(NAME_KEY) ||
    (typeof window !== "undefined" ? localStorage.getItem(NAME_KEY) : null)
  );
}

export function clearAuth() {
  clearCookie(TOKEN_KEY);
  clearCookie(NAME_KEY);
  if (typeof window !== "undefined") {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(NAME_KEY);
  }
}

async function apiJson(path: string, init?: RequestInit) {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as any),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, { ...init, headers });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg =
      (json && (json.detail || json.message || json.error)) ||
      text ||
      `Request failed (${res.status})`;
    throw new Error(msg);
  }

  return json;
}

function extractToken(payload: any): string | null {
  if (!payload) return null;
  return (
    payload.token ||
    payload.access_token ||
    payload.jwt ||
    payload?.data?.token ||
    null
  );
}

function extractName(payload: any): string | null {
  if (!payload) return null;
  return payload.name || payload?.user?.name || payload?.data?.user?.name || null;
}

export async function apiRegister(name: string, email: string, password: string) {
  const payload = await apiJson("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });

  const token = extractToken(payload);
  const uname = extractName(payload) || name;

  if (token) setAuth(token, uname);
  return payload;
}

export async function apiLogin(email: string, password: string) {
  const payload = await apiJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

  const token = extractToken(payload);
  const uname = extractName(payload);

  if (token) setAuth(token, uname || undefined);
  return payload;
}

export async function apiFetch(path: string, init?: RequestInit) {
  return apiJson(path, init);
}
