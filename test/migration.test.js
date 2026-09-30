import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import {
  vaccineKey, raceKey, transferKey, buildAliasMap, ingestRecord,
  driveMigration, resolveFieldConflict, resolveCycleConflict, findPedigreeCycles
} from "../src/migration.js";
import { issueCredential, recalcAfterMutation, pedigreeFingerprint } from "../src/credentials.js";

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "pigeon-test-"));
  const store = createStore(dir);
  await store.init();
  return { store, dir };
}

function sources() {
  return [
    {
      source: "甲棚", records: [
        { ringNo: "A-1", owner: "甲", color: "灰", loft: "甲1", fatherRing: "A-9", vaccines: [{ date: "2026-01-01", name: "新城疫" }], transfers: [], races: [{ date: "2026-05-01", event: "100公里", distance: 100, rank: 1 }] },
        { ringNo: "A-9", owner: "甲", color: "雨点", loft: "甲种", fatherRing: "", vaccines: [], transfers: [], races: [] }
      ]
    },
    {
      source: "乙棚", records: [
        { ringNo: "A-1", owner: "甲", color: "灰白条", loft: "甲1", fatherRing: "A-9", vaccines: [{ date: "2026-02-01", name: "鸽痘" }, { date: "2026-01-01", name: "新城疫" }], transfers: [{ date: "2026-03-01", from: "乙", to: "甲" }], races: [{ date: "2026-06-01", event: "200公里", distance: 200, rank: 2 }, { date: "2026-05-01", event: "100公里", distance: 100, rank: 1 }] },
        { ringNo: "OLD-1", previousRing: undefined, owner: "甲", color: "黑", loft: "乙种" },
        { ringNo: "A-1", previousRing: "OLD-1", owner: "甲", color: "灰", loft: "甲1" }
      ]
    }
  ];
}

test("去重键：疫苗/转让/成绩按内容判重", () => {
  assert.equal(vaccineKey({ date: "2026-01-01", name: "新城疫" }), vaccineKey({ date: "2026-01-01", name: "新城疫" }));
  assert.notEqual(vaccineKey({ date: "2026-01-01", name: "新城疫" }), vaccineKey({ date: "2026-01-02", name: "新城疫" }));
  assert.equal(raceKey({ date: "d", event: "e", distance: 100 }), raceKey({ date: "d", event: "e", distance: "100", rank: 9 }));
  assert.equal(transferKey({ date: "d", from: "a", to: "b" }), transferKey({ date: "d", from: "a", to: "b" }));
});

test("换环别名：旧环归并到当前环，同一羽只留一份", () => {
  const aliases = buildAliasMap(sources());
  assert.equal(aliases.canonical("OLD-1"), "A-1");
  assert.equal(aliases.canonical("A-1"), "A-1");
});

test("迁移：资料不同先列冲突不覆盖；集合补充且去重；换环合一份", async () => {
  const { store, dir } = await tempStore();
  try {
    const run = { id: "r1", startedAt: "2026-09-30", status: "running", attempts: 1, checkpoint: 0, processedIds: [], total: 5, conflicts: [], lastError: "" };
    await driveMigration(run, store, sources());
    const merged = store.getPigeon("A-1");
    assert.ok(merged, "A-1 档案存在");
    assert.equal(store.listPigeons().filter(p => p.ringNo === "A-1").length, 1, "同一足环仅一份");
    assert.equal(merged.color, "灰", "冲突字段保留先到值，不被覆盖");
    assert.deepEqual(merged.ringHistory.sort(), ["OLD-1"], "旧环进入环号历史");
    assert.equal(merged.vaccines.length, 2, "疫苗去重后补充为 2 条");
    assert.equal(merged.races.length, 2, "成绩去重后补充为 2 条");
    assert.equal(merged.transfers.length, 1);
    const colorConflict = run.conflicts.find(c => c.field === "color");
    assert.ok(colorConflict, "羽色冲突被列出");
    assert.equal(colorConflict.blocker, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("不覆盖已确认记录：冲突标记 blocker，值保持不变", async () => {
  const { store, dir } = await tempStore();
  try {
    const confirmed = store.createPigeon({ ringNo: "X-1", owner: "甲", color: "灰", loft: "L", fatherRing: "", motherRing: "", vaccines: [], transfers: [], races: [], ringHistory: [], sources: ["正式"], confirmedFields: ["color"], mergeLog: [] });
    const run = { id: "r2", startedAt: "t", status: "running", attempts: 1, checkpoint: 0, processedIds: [], total: 1, conflicts: [], lastError: "" };
    const aliases = buildAliasMap([{ source: "乙", records: [] }]);
    ingestRecord(run, store, aliases, { recordId: "乙#X-1", source: "乙", record: { ringNo: "X-1", owner: "甲", color: "雨点", loft: "L", vaccines: [], transfers: [], races: [] } });
    assert.equal(confirmed.color, "灰");
    assert.equal(run.conflicts[0].blocker, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("检查点：瞬时故障停下，重试跳过已处理记录且不重复", async () => {
  const { store, dir } = await tempStore();
  try {
    const srcs = sources();
    const run = { id: "r3", startedAt: "t", status: "running", attempts: 1, checkpoint: 0, processedIds: [], total: 4, conflicts: [], lastError: "" };
    const out1 = await driveMigration(run, store, srcs, { injectFaultId: "甲棚#A-9" });
    assert.equal(out1.stopped, true);
    assert.equal(run.status, "failed");
    assert.equal(run.processedIds.length, 1, "只处理了故障点之前的 1 条（检查点）");
    const pigeonCountAfterFail = store.listPigeons().length;

    run.attempts = 2;
    const out2 = await driveMigration(run, store, srcs);
    assert.equal(out2.stopped, false);
    assert.equal(run.processedIds.length, 4);
    const a1 = store.getPigeon("A-1");
    assert.equal(a1.vaccines.length, 2, "重试后疫苗仍只 2 条，无重复");
    assert.equal(a1.races.length, 2, "重试后成绩仍只 2 条，无重复");
    assert.ok(store.getPigeon("A-9"));
    assert.ok(pigeonCountAfterFail >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("家谱成环：被检测并登记为 blocker，切断边后冲突消除", async () => {
  const cycles = findPedigreeCycles([
    { ringNo: "P1", fatherRing: "P2", motherRing: "" },
    { ringNo: "P2", fatherRing: "P1", motherRing: "" }
  ]);
  assert.equal(cycles.length, 1);

  const { store, dir } = await tempStore();
  try {
    const run = { id: "r4", startedAt: "t", status: "running", attempts: 1, checkpoint: 0, processedIds: [], total: 2, conflicts: [], lastError: "" };
    await driveMigration(run, store, [{
      source: "甲", records: [
        { ringNo: "P1", owner: "甲", color: "灰", loft: "L", fatherRing: "P2", vaccines: [], transfers: [], races: [] },
        { ringNo: "P2", owner: "甲", color: "雨点", loft: "L", fatherRing: "P1", vaccines: [], transfers: [], races: [] }
      ]
    }]);
    assert.equal(run.status, "conflicts");
    const cycleConflict = run.conflicts.find(c => c.type === "cycle");
    assert.ok(cycleConflict);
    resolveCycleConflict(run, store, cycleConflict.id, cycleConflict.edges[0]);
    assert.equal(run.status, "completed");
    assert.equal(findPedigreeCycles(store.listPigeons()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("字段冲突裁定：选定 incoming 值后冲突移除", async () => {
  const { store, dir } = await tempStore();
  try {
    const run = { id: "r5", startedAt: "t", status: "running", attempts: 1, checkpoint: 0, processedIds: [], total: 2, conflicts: [], lastError: "" };
    await driveMigration(run, store, sources());
    const conflict = run.conflicts.find(c => c.field === "color" && c.canonicalRing === "A-1");
    resolveFieldConflict(run, store, conflict.id, "incoming");
    assert.equal(store.getPigeon("A-1").color, "灰白条");
    assert.equal(run.conflicts.some(c => c.id === conflict.id), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("参赛凭据：重复签发不新发；改血统后旧凭据失效补发", async () => {
  const { store, dir } = await tempStore();
  try {
    store.createPigeon({ ringNo: "C-1", owner: "甲", color: "灰", loft: "L", fatherRing: "F", motherRing: "", vaccines: [], transfers: [], races: [{ date: "2026-05-01", event: "100公里", distance: 100, rank: 1 }], ringHistory: [], sources: [], confirmedFields: [], mergeLog: [] });
    const first = issueCredential(store, "C-1", "100公里");
    assert.equal(first.reused, false);
    const again = issueCredential(store, "C-1", "100公里");
    assert.equal(again.reused, true, "同指纹重复提交沿用原凭据");
    assert.equal(store.listCredentials().length, 1);

    const beforeFp = pedigreeFingerprint(store.getPigeon("C-1"));
    store.getPigeon("C-1").fatherRing = "F2";
    const result = recalcAfterMutation(store, "C-1", "bloodline_changed");
    assert.equal(result.invalidated.length, 1);
    assert.equal(result.reissued.length, 1);
    assert.equal(result.reissued[0].supersedes, first.credential.id);
    assert.notEqual(pedigreeFingerprint(store.getPigeon("C-1")), beforeFp);
    assert.equal(store.listCredentials().filter(c => c.status === "valid").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
