// 页面入口 / HTTP 路由层：只负责收发请求，调用 store（档案存储）、migrate（迁移规则）、credentials（凭据）。
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { createStore } from "./src/store.js";
import { analyzeMigration, applyMigration, hasUnresolved, countUnresolved } from "./src/migrate.js";
import { issueCredential, invalidateForPigeon, recalculateCredential, getCredential } from "./src/credentials.js";
import { renderPage } from "./src/page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
const port = Number(process.env.PORT || 3024);

const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", confirmed: true, ringHistory: [], vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", confirmed: true, ringHistory: [], vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", confirmed: true, ringHistory: [], vaccines: [], transfers: [], races: [] },
  ],
};

const store = createStore({ dataDir, seed });

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}

// 血统或成绩变动后，失效该鸽只及其子代的已发凭据。
async function touchPigeon(ringNo) {
  const [db, credState] = await Promise.all([store.loadPigeons(), store.loadCredentials()]);
  invalidateForPigeon(credState, db, ringNo);
  await store.saveCredentials(credState);
}

// ---- 迁移检查点状态机 ----
// submitted → analyzed → resolved → applied
// 每完成一个阶段立即落盘；失败后从最后检查点重试，已应用环号跳过，保证幂等。
async function runMigration(id) {
  const state = await store.loadMigrations();
  const migration = state.migrations.find(m => m.id === id);
  if (!migration) { const e = new Error("migration_not_found"); e.code = 404; throw e; }

  try {
    if (migration.checkpoint === "submitted") {
      const db = await store.loadPigeons();
      migration.plan = analyzeMigration(migration.source?.pigeons || [], db.pigeons);
      migration.checkpoint = "analyzed";
      migration.status = countUnresolved(migration.plan) ? "conflicted" : "ready";
      migration.updatedAt = new Date().toISOString();
      await store.saveMigrations(state);
    }
    if (migration.checkpoint === "analyzed") {
      if (hasUnresolved(migration.plan)) {
        migration.status = "conflicted";
        migration.updatedAt = new Date().toISOString();
        await store.saveMigrations(state);
        return migration;
      }
      migration.checkpoint = "resolved";
      migration.updatedAt = new Date().toISOString();
      await store.saveMigrations(state);
    }
    if (migration.checkpoint === "resolved") {
      migration.status = "applying";
      migration.updatedAt = new Date().toISOString();
      await store.saveMigrations(state);

      const db = await store.loadPigeons();
      const { pigeons, result, applied } = applyMigration(migration.plan, db.pigeons, migration.applied);
      await store.savePigeons({ pigeons });

      migration.applied = applied;
      migration.result = result;
      migration.checkpoint = "applied";
      migration.status = "completed";
      migration.error = null;
      migration.updatedAt = new Date().toISOString();
      await store.saveMigrations(state);

      // 并册后血统/成绩变动：失效受影响鸽只的已发凭据。
      const credState = await store.loadCredentials();
      for (const ringNo of [...result.added, ...result.updated.map(u => u.split("（")[0])]) {
        invalidateForPigeon(credState, { pigeons }, ringNo);
      }
      await store.saveCredentials(credState);
      return migration;
    }
    if (migration.checkpoint === "applied") {
      migration.status = "completed";
      migration.updatedAt = new Date().toISOString();
      await store.saveMigrations(state);
    }
    return migration;
  } catch (error) {
    migration.status = "failed";
    migration.error = error.message;
    migration.updatedAt = new Date().toISOString();
    await store.saveMigrations(state);
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderPage());
    }

    // ---- 鸽只档案 ----
    if (req.method === "GET" && path === "/api/pigeons") {
      const db = await store.loadPigeons();
      return sendJson(res, 200, db.pigeons);
    }
    if (req.method === "POST" && path === "/api/pigeons") {
      const input = await body(req);
      const db = await store.loadPigeons();
      if (db.pigeons.some(item => item.ringNo === input.ringNo)) return sendJson(res, 409, { error: "ring_exists" });
      const pigeon = { ...input, confirmed: true, ringHistory: input.ringHistory || [], vaccines: [], transfers: [], races: [] };
      db.pigeons.unshift(pigeon);
      await store.savePigeons(db);
      return sendJson(res, 201, pigeon);
    }
    const relationMatch = path.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const db = await store.loadPigeons();
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }
    const actionMatch = path.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const db = await store.loadPigeons();
      const ringNo = decodeURIComponent(actionMatch[1]);
      const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const input = await body(req);
      if (actionMatch[2] === "transfers") {
        const transfer = { date: input.date || new Date().toISOString().slice(0, 10), from: pigeon.owner, to: input.to };
        pigeon.owner = input.to;
        pigeon.transfers.push(transfer);
      }
      if (actionMatch[2] === "races") {
        pigeon.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) });
      }
      if (actionMatch[2] === "vaccines") {
        pigeon.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name });
      }
      await store.savePigeons(db);
      await touchPigeon(ringNo);
      return sendJson(res, 200, pigeon);
    }

    // ---- 参赛凭据 ----
    const credIssueMatch = path.match(/^\/api\/pigeons\/(.+)\/credentials$/);
    if (credIssueMatch && req.method === "POST") {
      const db = await store.loadPigeons();
      const credState = await store.loadCredentials();
      const credential = issueCredential(db, credState, decodeURIComponent(credIssueMatch[1]));
      if (!credential) return sendJson(res, 404, { error: "pigeon_not_found" });
      await store.saveCredentials(credState);
      return sendJson(res, 201, credential);
    }
    if (req.method === "GET" && path === "/api/credentials") {
      const credState = await store.loadCredentials();
      return sendJson(res, 200, credState.credentials);
    }
    const credGetMatch = path.match(/^\/api\/credentials\/(.+)$/);
    if (credGetMatch && req.method === "GET") {
      const db = await store.loadPigeons();
      const credState = await store.loadCredentials();
      const credential = getCredential(db, credState, decodeURIComponent(credGetMatch[1]));
      if (!credential) return sendJson(res, 404, { error: "credential_not_found" });
      await store.saveCredentials(credState);
      return sendJson(res, 200, credential);
    }
    const credRecalcMatch = path.match(/^\/api\/credentials\/(.+)\/recalculate$/);
    if (credRecalcMatch && req.method === "POST") {
      const db = await store.loadPigeons();
      const credState = await store.loadCredentials();
      const credential = recalculateCredential(db, credState, decodeURIComponent(credRecalcMatch[1]));
      if (!credential) return sendJson(res, 404, { error: "credential_not_found" });
      await store.saveCredentials(credState);
      return sendJson(res, 200, credential);
    }

    // ---- 并册迁移 ----
    if (req.method === "POST" && path === "/api/migrations") {
      const source = await body(req);
      const state = await store.loadMigrations();
      const id = "mig-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const migration = {
        id,
        status: "analyzing",
        checkpoint: "submitted",
        source,
        plan: null,
        result: null,
        applied: { ringNos: [] },
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.migrations.unshift(migration);
      await store.saveMigrations(state);
      try {
        await runMigration(id);
      } catch (e) {
        return sendJson(res, 500, { error: e.message, migration: (await store.loadMigrations()).migrations.find(m => m.id === id) });
      }
      const fresh = (await store.loadMigrations()).migrations.find(m => m.id === id);
      return sendJson(res, 201, fresh);
    }
    if (req.method === "GET" && path === "/api/migrations") {
      const state = await store.loadMigrations();
      return sendJson(res, 200, state.migrations);
    }
    const migGetMatch = path.match(/^\/api\/migrations\/([^/]+)$/);
    if (migGetMatch && req.method === "GET") {
      const state = await store.loadMigrations();
      const migration = state.migrations.find(m => m.id === decodeURIComponent(migGetMatch[1]));
      return migration ? sendJson(res, 200, migration) : sendJson(res, 404, { error: "migration_not_found" });
    }
    const migRetryMatch = path.match(/^\/api\/migrations\/([^/]+)\/retry$/);
    if (migRetryMatch && req.method === "POST") {
      const id = decodeURIComponent(migRetryMatch[1]);
      try {
        const migration = await runMigration(id);
        return sendJson(res, 200, migration);
      } catch (e) {
        const state = await store.loadMigrations();
        const migration = state.migrations.find(m => m.id === id);
        return sendJson(res, 500, { error: e.message, migration });
      }
    }
    const migConflictMatch = path.match(/^\/api\/migrations\/([^/]+)\/conflicts\/(\d+)\/([^/]+)\/resolve$/);
    if (migConflictMatch && req.method === "POST") {
      const state = await store.loadMigrations();
      const migration = state.migrations.find(m => m.id === decodeURIComponent(migConflictMatch[1]));
      if (!migration) return sendJson(res, 404, { error: "migration_not_found" });
      const updateIndex = Number(migConflictMatch[2]);
      const field = decodeURIComponent(migConflictMatch[3]);
      const input = await body(req);
      const upd = migration.plan?.updates?.[updateIndex];
      if (!upd) return sendJson(res, 404, { error: "update_not_found" });
      const conflict = upd.conflicts.find(c => c.field === field);
      if (!conflict) return sendJson(res, 404, { error: "conflict_not_found" });
      conflict.resolution = input.choice === "source" ? "source" : "target";
      migration.checkpoint = "analyzed"; // 回到分析检查点，重试时重新校验
      migration.updatedAt = new Date().toISOString();
      await store.saveMigrations(state);
      return sendJson(res, 200, migration);
    }
    const migCycleMatch = path.match(/^\/api\/migrations\/([^/]+)\/cycles\/(\d+)\/resolve$/);
    if (migCycleMatch && req.method === "POST") {
      const state = await store.loadMigrations();
      const migration = state.migrations.find(m => m.id === decodeURIComponent(migCycleMatch[1]));
      if (!migration) return sendJson(res, 404, { error: "migration_not_found" });
      const cycleIndex = Number(migCycleMatch[2]);
      const input = await body(req);
      const cycle = migration.plan?.cycles?.[cycleIndex];
      if (!cycle) return sendJson(res, 404, { error: "cycle_not_found" });
      cycle.resolution = input.choice === "skip" ? "skip" : "break";
      migration.checkpoint = "analyzed";
      migration.updatedAt = new Date().toISOString();
      await store.saveMigrations(state);
      return sendJson(res, 200, migration);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`赛鸽并册迁移系统 listening on http://localhost:${port}`));
