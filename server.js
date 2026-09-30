import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./src/store.js";
import {
  buildAliasMap, driveMigration, resolveFieldConflict, resolveCycleConflict,
  vaccineKey, transferKey, raceKey, findPedigreeCycles
} from "./src/migration.js";
import { issueCredential, recalcAfterMutation, pedigreeFingerprint, raceFingerprint } from "./src/credentials.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, "data");
const port = Number(process.env.PORT || 3024);

const store = createStore(dataDir);

async function loadLegacySources() {
  const names = ["north.json", "south.json"];
  const sources = [];
  for (const name of names) {
    const path = join(store.paths.legacyDir, name);
    if (existsSync(path)) sources.push(JSON.parse(await readFile(path, "utf8")));
  }
  return sources;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
async function servePage(res, file) {
  const html = await readFile(join(publicDir, file), "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function publicPigeon(pigeon) {
  return {
    ringNo: pigeon.ringNo, owner: pigeon.owner, fatherRing: pigeon.fatherRing, motherRing: pigeon.motherRing,
    color: pigeon.color, loft: pigeon.loft, version: pigeon.version,
    confirmedFields: pigeon.confirmedFields, ringHistory: pigeon.ringHistory, sources: pigeon.sources,
    vaccines: pigeon.vaccines, transfers: pigeon.transfers, races: pigeon.races,
    pedigreeFingerprint: pedigreeFingerprint(pigeon), raceFingerprint: raceFingerprint(pigeon)
  };
}

function relation(db, ringNo) {
  const pigeon = db.getPigeon(ringNo);
  if (!pigeon) return null;
  const father = pigeon.fatherRing ? db.getPigeon(pigeon.fatherRing) : null;
  const mother = pigeon.motherRing ? db.getPigeon(pigeon.motherRing) : null;
  const children = db.listPigeons().filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon: publicPigeon(pigeon), father: father && publicPigeon(father), mother: mother && publicPigeon(mother), children: children.map(publicPigeon) };
}

// 集合追加：按内容去重，重复提交返回 existed=true，不新增。
function appendUnique(list, item, keyOf) {
  const key = keyOf(item);
  const existing = list.find(entry => keyOf(entry) === key);
  if (existing) return { added: false, item: existing };
  list.push(item);
  return { added: true, item };
}

async function serveStatic(res, urlPath) {
  const allowed = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon" };
  const ext = extname(urlPath);
  if (!allowed[ext]) return false;
  const filePath = normalize(join(publicDir, urlPath));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) return false;
  res.writeHead(200, { "Content-Type": allowed[ext] });
  res.end(await readFile(filePath));
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    await store.init();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET" && await serveStatic(res, p)) return;

    // ---------- 页面入口：档案 / 迁移并册 / 参赛凭据 三页分开 ----------
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return servePage(res, "archives.html");
    if (req.method === "GET" && (p === "/migration" || p === "/migration.html")) return servePage(res, "migration.html");
    if (req.method === "GET" && (p === "/credentials" || p === "/credentials.html")) return servePage(res, "credentials.html");

    // ---------- 档案 ----------
    if (req.method === "GET" && p === "/api/pigeons") {
      return sendJson(res, 200, store.listPigeons().map(publicPigeon));
    }
    if (req.method === "POST" && p === "/api/pigeons") {
      const input = await body(req);
      if (!input.ringNo) return sendJson(res, 400, { error: "ring_no_required" });
      if (store.getPigeon(input.ringNo)) return sendJson(res, 409, { error: "ring_exists" });
      const pigeon = store.createPigeon({
        ringNo: input.ringNo, owner: input.owner || "", fatherRing: input.fatherRing || "",
        motherRing: input.motherRing || "", color: input.color || "", loft: input.loft || "",
        sources: ["手工建档"],
        mergeLog: [{ at: new Date().toISOString(), action: "create" }]
      });
      await store.saveArchives();
      return sendJson(res, 201, publicPigeon(pigeon));
    }

    const relationMatch = p.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(store, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }

    const pedigreeMatch = p.match(/^\/api\/pigeons\/(.+)\/pedigree$/);
    if (pedigreeMatch && req.method === "PUT") {
      const pigeon = store.getPigeon(decodeURIComponent(pedigreeMatch[1]));
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const input = await body(req);
      const next = { fatherRing: input.fatherRing ?? pigeon.fatherRing, motherRing: input.motherRing ?? pigeon.motherRing };
      // 不允许制造家谱成环
      const probe = store.listPigeons().map(item => item.ringNo === pigeon.ringNo ? { ...item, ...next } : item);
      if (findPedigreeCycles(probe).length) return sendJson(res, 409, { error: "pedigree_cycle", message: "该父母关系会导致家谱成环，请先在迁移页处理冲突" });
      const before = pedigreeFingerprint(pigeon);
      Object.assign(pigeon, next);
      store.bumpVersion(pigeon);
      await store.saveArchives();
      const credentials = recalcAfterMutation(store, pigeon.ringNo, "bloodline_changed");
      await store.saveCredentials();
      return sendJson(res, 200, { pigeon: publicPigeon(pigeon), fingerprintChanged: before !== pedigreeFingerprint(pigeon), credentials });
    }

    const confirmMatch = p.match(/^\/api\/pigeons\/(.+)\/confirm$/);
    if (confirmMatch && req.method === "POST") {
      const ringNo = decodeURIComponent(confirmMatch[1]);
      const input = await body(req);
      const pigeon = store.confirmField(ringNo, input.field);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      await store.saveArchives();
      return sendJson(res, 200, publicPigeon(pigeon));
    }

    const actionMatch = p.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const pigeon = store.getPigeon(decodeURIComponent(actionMatch[1]));
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const input = await body(req);
      const today = new Date().toISOString().slice(0, 10);
      let result;
      let affectsCredential = false;
      if (actionMatch[2] === "transfers") {
        result = appendUnique(pigeon.transfers, { date: input.date || today, from: input.from || pigeon.owner, to: input.to }, transferKey);
        if (result.added) pigeon.owner = input.to;
      } else if (actionMatch[2] === "races") {
        result = appendUnique(pigeon.races, {
          date: input.date || today, event: input.event,
          distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0)
        }, raceKey);
        affectsCredential = result.added;
      } else {
        result = appendUnique(pigeon.vaccines, { date: input.date || today, name: input.name }, vaccineKey);
      }
      if (result.added) store.bumpVersion(pigeon);
      await store.saveArchives();
      let recalc = null;
      if (affectsCredential) {
        recalc = recalcAfterMutation(store, pigeon.ringNo, "race_changed");
        await store.saveCredentials();
      }
      return sendJson(res, 200, { pigeon: publicPigeon(pigeon), added: result.added, duplicate: !result.added, credentials: recalc });
    }

    // ---------- 迁移并册 ----------
    if (req.method === "GET" && p === "/api/migration") {
      const run = store.getMigrationRun();
      return sendJson(res, 200, { run });
    }
    if (req.method === "POST" && p === "/api/migration/start") {
      const existing = store.getMigrationRun();
      if (existing && (existing.status === "running" || existing.status === "failed")) {
        return sendJson(res, 409, { error: "migration_in_progress", run: publicRun(existing), message: "存在未完成迁移，请从检查点重试" });
      }
      const input = await body(req);
      const sources = await loadLegacySources();
      const aliases = buildAliasMap(sources);
      const run = {
        id: `run-${Date.now()}`,
        startedAt: new Date().toISOString(),
        status: "running",
        attempts: 1,
        checkpoint: 0,
        processedIds: [],
        total: sources.reduce((sum, src) => sum + src.records.length, 0),
        faultsRemaining: input.injectFault ? 1 : 0,
        injectFaultId: input.injectFault ? "北岸旧系统#CHN-2025-331" : null,
        conflicts: [],
        lastError: "",
        sources: sources.map(src => src.source),
        aliases: [...new Set(aliases.rings())].map(ring => ({ ring, canonical: aliases.canonical(ring) }))
      };
      store.setMigrationRun(run);
      await store.saveMigration();
      const outcome = await driveMigration(run, store, sources, {
        injectFaultId: run.injectFaultId,
        onCheckpoint: () => store.checkpoint()
      });
      await store.checkpoint();
      return sendJson(res, 200, { run: publicRun(run), outcome });
    }
    if (req.method === "POST" && p === "/api/migration/retry") {
      const run = store.getMigrationRun();
      if (!run) return sendJson(res, 404, { error: "no_migration" });
      if (run.status !== "failed") return sendJson(res, 409, { error: "not_retryable", message: "仅失败状态可从检查点重试" });
      run.attempts += 1;
      run.status = "running";
      await store.checkpoint();
      const sources = await loadLegacySources();
      const outcome = await driveMigration(run, store, sources, {
        injectFaultId: run.faultsRemaining > 0 ? run.injectFaultId : null,
        onCheckpoint: () => store.checkpoint()
      });
      run.faultsRemaining = 0;
      await store.checkpoint();
      return sendJson(res, 200, { run: publicRun(run), outcome });
    }
    const resolveMatch = p.match(/^\/api\/migration\/conflicts\/(.+)\/resolve$/);
    if (resolveMatch && req.method === "POST") {
      const run = store.getMigrationRun();
      if (!run) return sendJson(res, 404, { error: "no_migration" });
      const input = await body(req);
      const conflictId = decodeURIComponent(resolveMatch[1]);
      const targetConflict = run.conflicts.find(item => item.id === conflictId);
      const affectedRing = targetConflict?.canonicalRing;
      try {
        if (input.type === "cycle") resolveCycleConflict(run, store, conflictId, input.edge);
        else resolveFieldConflict(run, store, conflictId, input.choice);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      await store.checkpoint();
      // 裁定改变血统后，相关参赛凭据失效重算（羽色等非血统字段指纹不变则不补发）
      const credentialResult = affectedRing ? recalcAfterMutation(store, affectedRing, "conflict_resolved") : null;
      if (credentialResult) await store.saveCredentials();
      return sendJson(res, 200, { run: publicRun(run), credentials: credentialResult });
    }

    // ---------- 参赛凭据 ----------
    if (req.method === "GET" && p === "/api/credentials") {
      return sendJson(res, 200, { credentials: store.listCredentials() });
    }
    if (req.method === "POST" && p === "/api/credentials") {
      const input = await body(req);
      try {
        const result = issueCredential(store, input.ringNo, input.event);
        await store.saveCredentials();
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }
    if (req.method === "POST" && p === "/api/credentials/recalc") {
      const input = await body(req);
      const result = recalcAfterMutation(store, input.ringNo, "manual_recalc");
      await store.saveCredentials();
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message, stack: error.stack });
  }
});

function publicRun(run) {
  if (!run) return null;
  return { ...run };
}

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
