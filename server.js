// 손글씨 방명록 서버: index.html을 내려주고, 방명록을 디스크에 저장하며,
// 새 방명록을 전시 화면에 실시간(Server-Sent Events)으로 보냅니다. 외부 패키지 없음.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const IMG_DIR = path.join(DATA_DIR, "img");
const META_FILE = path.join(DATA_DIR, "meta.json");
const MAX_BODY = 400 * 1024;
const MAX_ENTRIES = 2000;
const DEFAULT_CONFIG = { title: "손글씨 방명록", prompt: "축하의 한마디를 남겨주세요", secs: 8, showQr: true };
const TYPES = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };

fs.mkdirSync(IMG_DIR, { recursive: true });
let meta = { entries: [], config: { ...DEFAULT_CONFIG } };
try { meta = { ...meta, ...JSON.parse(fs.readFileSync(META_FILE, "utf8")) }; } catch (e) { /* 첫 실행 */ }

function saveMeta() {
  const tmp = META_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, META_FILE);
}

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
    if (p === "/api/health") return send(res, 200, { ok: true, app: "guestbook", admin: !!ADMIN_PASSWORD });

    if (p === "/api/entries" && req.method === "GET") {
      return send(res, 200, meta.entries.slice(-300).reverse().map(publicEntry));
    }
    if (p === "/api/entries" && req.method === "POST") {
      if (rateLimited(req)) return send(res, 429, { error: "rate_limited" });
      const body = await readJson(req);
      const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.img || ""));
      if (!m) return send(res, 400, { error: "bad_image" });
      if (meta.entries.length >= MAX_ENTRIES) return send(res, 507, { error: "full" });
      const id = Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
      const ext = TYPES[m[1]];
      fs.writeFileSync(path.join(IMG_DIR, `${id}.${ext}`), Buffer.from(m[2], "base64"));
      const entry = { id, ext, createdAt: Date.now() };
      meta.entries.push(entry); saveMeta();
      broadcast("entry", publicEntry(entry));
      return send(res, 201, publicEntry(entry));
    }
    let mm;
    if ((mm = /^\/api\/entries\/([a-z0-9-]+)$/.exec(p)) && req.method === "DELETE") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      const i = meta.entries.findIndex((e) => e.id === mm[1]);
      if (i >= 0) {
        const [e] = meta.entries.splice(i, 1); saveMeta();
        fs.rm(path.join(IMG_DIR, `${e.id}.${e.ext}`), { force: true }, () => {});
        broadcast("delete", { id: e.id });
      }
      return send(res, 200, { ok: true });
    }
    if ((mm = /^\/api\/img\/([a-z0-9-]+)\.(webp|jpg|png)$/.exec(p)) && req.method === "GET") {
      const file = path.join(IMG_DIR, `${mm[1]}.${mm[2]}`);
      if (!fs.existsSync(file)) return send(res, 404, "not found");
      const type = mm[2] === "jpg" ? "image/jpeg" : "image/" + mm[2];
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" });
      return fs.createReadStream(file).pipe(res);
    }
    if (p === "/api/config" && req.method === "GET") return send(res, 200, { ...DEFAULT_CONFIG, ...meta.config });
    if (p === "/api/config" && req.method === "PUT") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      const b = await readJson(req);
      meta.config = {
        title: String(b.title || DEFAULT_CONFIG.title).slice(0, 60),
        prompt: String(b.prompt || DEFAULT_CONFIG.prompt).slice(0, 60),
        secs: Math.max(3, Math.min(60, Number(b.secs) || DEFAULT_CONFIG.secs)),
        showQr: b.showQr !== false,
      };
      saveMeta(); broadcast("config", meta.config);
      return send(res, 200, meta.config);
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
    send(res, e.status || 500, { error: e.message || "server_error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`guestbook listening on :${PORT}, data in ${DATA_DIR}${ADMIN_PASSWORD ? "" : " (ADMIN_PASSWORD not set: delete/settings disabled)"}`);
});
