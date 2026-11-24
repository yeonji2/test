// 손글씨 방명록 서버: index.html을 내려주고, 방명록을 저장하며,
// 새 방명록을 전시 화면에 실시간(Server-Sent Events)으로 보냅니다. 로그인 없음.
// 저장소: DATABASE_URL이 있으면 PostgreSQL, 없으면 DATA_DIR 폴더의 파일.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const MAX_BODY = 400 * 1024;
const MAX_ENTRIES = 2000;
const LIST_LIMIT = 300;
const DEFAULT_CONFIG = { title: "손글씨 방명록", prompt: "축하의 한마디를 남겨주세요", secs: 8, showQr: true, introUrl: "https://simulationcenter-production.up.railway.app/", introLabel: "시뮬레이션센터 소개" };
// 소개 QR에 넣을 주소는 http/https만 허용
const cleanUrl = (u) => { try { const x = new URL(String(u || "").trim()); return /^https?:$/.test(x.protocol) ? x.href.slice(0, 500) : ""; } catch (e) { return ""; } };
const TYPES = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };
const MIME = { webp: "image/webp", jpg: "image/jpeg", png: "image/png" };

/* ---------- 저장소: PostgreSQL ---------- */
function pgStore(url) {
  const { Pool } = require("pg");
  const internal = /\.railway\.internal|localhost|127\.0\.0\.1/.test(url) || /sslmode=disable/.test(url);
  const pool = new Pool({ connectionString: url, ssl: internal ? false : { rejectUnauthorized: false }, max: 5 });
  return {
    name: "PostgreSQL",
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS guestbook_entries (
        id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, ext TEXT NOT NULL, data BYTEA NOT NULL)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS guestbook_entries_created ON guestbook_entries (created_at DESC)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS guestbook_config (k TEXT PRIMARY KEY, v JSONB NOT NULL)`);
    },
    async list(limit = LIST_LIMIT) {
      const r = await pool.query(`SELECT id, created_at, ext FROM guestbook_entries ORDER BY created_at DESC LIMIT $1`, [limit]);
      return r.rows.map((x) => ({ id: x.id, createdAt: Number(x.created_at), ext: x.ext }));
    },
    async count() { return Number((await pool.query(`SELECT COUNT(*) AS n FROM guestbook_entries`)).rows[0].n); },
    async add(e, buf) { await pool.query(`INSERT INTO guestbook_entries (id, created_at, ext, data) VALUES ($1, $2, $3, $4)`, [e.id, e.createdAt, e.ext, buf]); },
    async remove(id) { await pool.query(`DELETE FROM guestbook_entries WHERE id = $1`, [id]); },
    async clear() { return (await pool.query(`DELETE FROM guestbook_entries`)).rowCount; },
    async getMark(k) { const r = await pool.query(`SELECT v FROM guestbook_config WHERE k = $1`, [k]); return r.rows[0] ? r.rows[0].v : null; },
    async setMark(k, v) { await pool.query(`INSERT INTO guestbook_config (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [k, JSON.stringify(v)]); },
    async image(id, ext) {
      const r = await pool.query(`SELECT data FROM guestbook_entries WHERE id = $1 AND ext = $2`, [id, ext]);
      return r.rows[0] ? r.rows[0].data : null;
    },
    async getConfig() { const r = await pool.query(`SELECT v FROM guestbook_config WHERE k = 'event'`); return r.rows[0] ? r.rows[0].v : {}; },
    async setConfig(c) { await pool.query(`INSERT INTO guestbook_config (k, v) VALUES ('event', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [JSON.stringify(c)]); },
  };
}

/* ---------- 저장소: 파일 ---------- */
function fileStore(dir) {
  const IMG_DIR = path.join(dir, "img"), META = path.join(dir, "meta.json");
  let meta = { entries: [], config: {} };
  const save = () => { fs.writeFileSync(META + ".tmp", JSON.stringify(meta)); fs.renameSync(META + ".tmp", META); };
  return {
    name: `파일(${dir})`,
    async init() {
      fs.mkdirSync(IMG_DIR, { recursive: true });
      try { meta = { ...meta, ...JSON.parse(fs.readFileSync(META, "utf8")) }; } catch (e) { /* 첫 실행 */ }
    },
    async list(limit = LIST_LIMIT) { return meta.entries.slice(-limit).reverse(); },
    async count() { return meta.entries.length; },
    async add(e, buf) { fs.writeFileSync(path.join(IMG_DIR, `${e.id}.${e.ext}`), buf); meta.entries.push(e); save(); },
    async remove(id) {
      const i = meta.entries.findIndex((e) => e.id === id); if (i < 0) return;
      const [e] = meta.entries.splice(i, 1); save();
      fs.rm(path.join(IMG_DIR, `${e.id}.${e.ext}`), { force: true }, () => {});
    },
    async image(id, ext) { const f = path.join(IMG_DIR, `${id}.${ext}`); return fs.existsSync(f) ? fs.readFileSync(f) : null; },
    async clear() {
      const n = meta.entries.length;
      for (const e of meta.entries) fs.rm(path.join(IMG_DIR, `${e.id}.${e.ext}`), { force: true }, () => {});
      meta.entries = []; save(); return n;
    },
    async getMark(k) { return (meta.marks || {})[k] ?? null; },
    async setMark(k, v) { meta.marks = { ...(meta.marks || {}), [k]: v }; save(); },
    async getConfig() { return meta.config || {}; },
    async setConfig(c) { meta.config = c; save(); },
  };
}

const store = process.env.DATABASE_URL
  ? pgStore(process.env.DATABASE_URL)
  : fileStore(path.resolve(process.env.DATA_DIR || path.join(__dirname, "data")));

/* ---------- 실시간 전송 ---------- */
const INDEX = fs.readFileSync(path.join(__dirname, "index.html"));
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000);

const publicEntry = (e) => ({ id: e.id, createdAt: e.createdAt, img: `/api/img/${e.id}.${e.ext}` });

function send(res, code, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(code, { "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("too_large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(Object.assign(new Error("bad_json"), { status: 400 })); } });
    req.on("error", reject);
  });
}
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const given = Buffer.from(String(req.headers["x-admin-key"] || ""));
  const want = Buffer.from(ADMIN_PASSWORD);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// 한 IP당 1분에 20장까지
const hits = new Map();
function rateLimited(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now(); const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now); hits.set(ip, list);
  return list.length > 20;
}
setInterval(() => { const now = Date.now(); for (const [ip, l] of hits) if (!l.some((t) => now - t < 60000)) hits.delete(ip); }, 60000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/api/health") return send(res, 200, { ok: true, app: "guestbook", admin: !!ADMIN_PASSWORD, storage: process.env.DATABASE_URL ? "postgres" : "file" });

    // ?all=1 은 추첨 화면용: 최근 300개가 아니라 전체 목록
    if (p === "/api/entries" && req.method === "GET") return send(res, 200, (await store.list(url.searchParams.get("all") === "1" ? MAX_ENTRIES : LIST_LIMIT)).map(publicEntry));
    if (p === "/api/entries" && req.method === "POST") {
      if (rateLimited(req)) return send(res, 429, { error: "rate_limited" });
      const body = await readJson(req);
      const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.img || ""));
      if (!m) return send(res, 400, { error: "bad_image" });
      if ((await store.count()) >= MAX_ENTRIES) return send(res, 507, { error: "full" });
      const entry = { id: Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex"), ext: TYPES[m[1]], createdAt: Date.now() };
      await store.add(entry, Buffer.from(m[2], "base64"));
      broadcast("entry", publicEntry(entry));
      return send(res, 201, publicEntry(entry));
    }
    // 방명록 전체 삭제 (관리자)
    if (p === "/api/entries" && req.method === "DELETE") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      const n = await store.clear();
      broadcast("reset", {});
      return send(res, 200, { ok: true, deleted: n });
    }
    let mm;
    if ((mm = /^\/api\/entries\/([a-z0-9-]+)$/.exec(p)) && req.method === "DELETE") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      await store.remove(mm[1]);
      broadcast("delete", { id: mm[1] });
      return send(res, 200, { ok: true });
    }
    if ((mm = /^\/api\/img\/([a-z0-9-]+)\.(webp|jpg|png)$/.exec(p)) && req.method === "GET") {
      const buf = await store.image(mm[1], mm[2]);
      if (!buf) return send(res, 404, "not found");
      res.writeHead(200, { "Content-Type": MIME[mm[2]], "Content-Length": buf.length, "Cache-Control": "public, max-age=31536000, immutable" });
      return res.end(buf);
    }
    if (p === "/api/config" && req.method === "GET") {
      const c = { ...DEFAULT_CONFIG, ...(await store.getConfig()) };
      if (!c.introUrl) c.introUrl = DEFAULT_CONFIG.introUrl; // 비어 있으면 시뮬레이션센터 기본 주소
      return send(res, 200, c);
    }
    if (p === "/api/config" && req.method === "PUT") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      const b = await readJson(req);
      const c = {
        title: String(b.title || DEFAULT_CONFIG.title).slice(0, 60),
        prompt: String(b.prompt || DEFAULT_CONFIG.prompt).slice(0, 60),
        secs: Math.max(3, Math.min(60, Number(b.secs) || DEFAULT_CONFIG.secs)),
        showQr: b.showQr !== false,
        introUrl: cleanUrl(b.introUrl) || DEFAULT_CONFIG.introUrl,
        introLabel: String(b.introLabel || DEFAULT_CONFIG.introLabel).slice(0, 30),
      };
      await store.setConfig(c); broadcast("config", c);
      return send(res, 200, c);
    }
    if (p === "/api/admin/check" && req.method === "POST") {
      if (!ADMIN_PASSWORD) return send(res, 503, { error: "no_password_set" });
      return isAdmin(req) ? send(res, 200, { ok: true }) : send(res, 401, { error: "unauthorized" });
    }
    if (p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write("retry: 3000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (p.startsWith("/api/")) return send(res, 404, { error: "not_found" });
    if (req.method === "GET" || req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(req.method === "HEAD" ? undefined : INDEX);
    }
    send(res, 405, "method not allowed");
  } catch (e) {
    console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : "server_error" });
  }
});

(async () => {
  // 데이터베이스가 막 만들어진 직후라 아직 준비 중일 수 있어 몇 번 다시 시도
  for (let i = 1; ; i++) {
    try { await store.init(); break; }
    catch (e) {
      if (i >= 10) { console.error("저장소 초기화 실패:", e.message); process.exit(1); }
      console.error(`저장소 연결 재시도 ${i}/10: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  // PURGE_ENTRIES 변수에 새 값을 넣고 배포하면 그때 한 번만 방명록을 모두 지움 (같은 값으로는 다시 지우지 않음)
  const purge = (process.env.PURGE_ENTRIES || "").trim();
  if (purge && (await store.getMark("purge")) !== purge) {
    const n = await store.clear();
    await store.setMark("purge", purge);
    console.log(`PURGE_ENTRIES=${purge}: 방명록 ${n}개를 삭제했습니다`);
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`guestbook listening on :${PORT}, storage: ${store.name}${ADMIN_PASSWORD ? "" : " (ADMIN_PASSWORD not set: delete/settings disabled)"}`);
  });
})();
