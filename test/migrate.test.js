import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeMigration, applyMigration, detectCycles, hasUnresolved } from "../src/migrate.js";
import { computeSnapshot, issueCredential, invalidateForPigeon, recalculateCredential, getCredential } from "../src/credentials.js";

const target = [
  { ringNo: "A", owner: "北岸棚", fatherRing: "B", motherRing: "C", color: "灰", loft: "北岸A棚", confirmed: true, ringHistory: [], vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [], races: [{ date: "2026-06-01", event: "120公里", distance: 120, returnTime: "10:42", rank: 18 }] },
  { ringNo: "B", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", confirmed: true, ringHistory: [], vaccines: [], transfers: [], races: [] },
  { ringNo: "C", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", confirmed: true, ringHistory: [], vaccines: [], transfers: [], races: [] },
];

test("同一足环只留一份正式档案：来源补充疫苗与成绩，不去重丢失", () => {
  const source = [
    { ringNo: "A", owner: "北岸棚", fatherRing: "B", motherRing: "C", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }, { date: "2026-05-10", name: "鸽痘" }], transfers: [], races: [{ date: "2026-06-01", event: "120公里", distance: 120, returnTime: "10:42", rank: 18 }, { date: "2026-06-20", event: "200公里", distance: 200, returnTime: "11:05", rank: 9 }] },
  ];
  const plan = analyzeMigration(source, target);
  assert.equal(plan.additions.length, 0);
  assert.equal(plan.updates.length, 1);
  const upd = plan.updates[0];
  assert.equal(upd.conflicts.length, 0, "资料一致不应产生冲突");
  assert.equal(upd.merged.vaccines.length, 2, "疫苗去重后 2 条");
  assert.equal(upd.merged.races.length, 2, "成绩去重后 2 条");
});

test("资料不同先列冲突，不覆盖已确认记录", () => {
  const source = [
    { ringNo: "A", owner: "南岸棚", fatherRing: "B", motherRing: "C", color: "灰", loft: "南岸B棚", vaccines: [], transfers: [], races: [] },
  ];
  const plan = analyzeMigration(source, target);
  const upd = plan.updates[0];
  assert.ok(upd.conflicts.length >= 2, "owner 与 loft 不一致应产生冲突");
  const ownerConflict = upd.conflicts.find(c => c.field === "owner");
  assert.equal(ownerConflict.targetValue, "北岸棚");
  assert.equal(ownerConflict.sourceValue, "南岸棚");
  assert.equal(ownerConflict.resolution, null);
  // 未决议时 merged 保留目标值
  assert.equal(upd.merged.owner, "北岸棚");
  assert.equal(hasUnresolved(plan), true);
});

test("空白父母栏由来源补充，不冲突", () => {
  const source = [
    { ringNo: "B", owner: "育种棚", fatherRing: "D", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
  ];
  const plan = analyzeMigration(source, target);
  const upd = plan.updates[0];
  assert.equal(upd.conflicts.length, 0);
  assert.equal(upd.merged.fatherRing, "D");
});

test("家谱成环检测：A→B→A 被识别", () => {
  const pigeons = [
    { ringNo: "A", fatherRing: "B", motherRing: "" },
    { ringNo: "B", fatherRing: "A", motherRing: "" },
  ];
  const cycles = detectCycles(pigeons);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].nodes, ["A", "B", "A"], "环路径闭合");
  assert.equal(cycles[0].breakAt.ringNo, "B");
  assert.equal(cycles[0].breakAt.field, "fatherRing");
});

test("应用迁移：新增 + 更新，冲突未决议保留目标值", () => {
  const source = [
    { ringNo: "A", owner: "南岸棚", fatherRing: "B", motherRing: "C", color: "灰", loft: "南岸B棚", vaccines: [{ date: "2026-05-10", name: "鸽痘" }], transfers: [], races: [] },
    { ringNo: "D", owner: "南岸棚", fatherRing: "", motherRing: "", color: "灰", loft: "南岸种鸽棚", vaccines: [], transfers: [], races: [] },
  ];
  const plan = analyzeMigration(source, target);
  const { pigeons, result } = applyMigration(plan, target, { ringNos: [] });
  assert.ok(result.added.includes("D"));
  assert.ok(result.updated.includes("A"));
  const a = pigeons.find(p => p.ringNo === "A");
  assert.equal(a.owner, "北岸棚", "未决议冲突保留目标值");
  assert.equal(a.loft, "北岸A棚");
  assert.equal(a.vaccines.length, 2, "疫苗并集");
});

test("幂等：重复应用不新增疫苗与成绩", () => {
  const source = [
    { ringNo: "A", owner: "北岸棚", fatherRing: "B", motherRing: "C", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-05-10", name: "鸽痘" }], transfers: [], races: [{ date: "2026-06-20", event: "200公里", distance: 200, returnTime: "11:05", rank: 9 }] },
  ];
  const plan = analyzeMigration(source, target);
  const first = applyMigration(plan, target, { ringNos: [] });
  const again = applyMigration(plan, first.pigeons, first.applied);
  const a = again.pigeons.find(p => p.ringNo === "A");
  assert.equal(a.vaccines.length, 2, "重复提交不新增疫苗");
  assert.equal(a.races.length, 2, "重复提交不新增成绩");
  assert.ok(again.result.updated[0].includes("已应用"));
});

test("检查点重试：applied 集合跳过已应用环号", () => {
  const source = [
    { ringNo: "A", owner: "北岸棚", fatherRing: "B", motherRing: "C", color: "灰", loft: "北岸A棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "D", owner: "南岸棚", fatherRing: "", motherRing: "", color: "灰", loft: "南岸种鸽棚", vaccines: [], transfers: [], races: [] },
  ];
  const plan = analyzeMigration(source, target);
  // 模拟第一次只应用了 A（D 尚未应用，检查点中断）
  const partial = applyMigration(plan, target, { ringNos: ["A"] });
  assert.ok(partial.result.added.includes("D"));
  assert.ok(!partial.result.added.includes("A"), "A 已在检查点，跳过");
});

test("成环决议 break：断环后不写成环家谱", () => {
  const source = [
    { ringNo: "B", owner: "育种棚", fatherRing: "D", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "D", owner: "南岸棚", fatherRing: "B", motherRing: "", color: "灰", loft: "南岸种鸽棚", vaccines: [], transfers: [], races: [] },
  ];
  const plan = analyzeMigration(source, target);
  assert.ok(plan.cycles.length >= 1, "应检测到 B→D→B 成环");
  for (const c of plan.cycles) c.resolution = "break";
  const { pigeons, result } = applyMigration(plan, target, { ringNos: [] });
  assert.ok(result.skippedLinks.length >= 1, "应有断环记录");
  assert.equal(detectCycles(pigeons).length, 0, "应用后无环");
});

test("凭据：签发后血统/成绩变动使其失效，读取时重算恢复", () => {
  const db = { pigeons: JSON.parse(JSON.stringify(target)) };
  const credState = { credentials: [] };
  const cred = issueCredential(db, credState, "A");
  assert.ok(cred);
  assert.equal(cred.status, "valid");
  assert.equal(cred.snapshot.races.length, 1);

  // 成绩变动
  db.pigeons.find(p => p.ringNo === "A").races.push({ date: "2026-06-20", event: "200公里", distance: 200, returnTime: "11:05", rank: 9 });
  invalidateForPigeon(credState, db, "A");
  assert.equal(credState.credentials[0].status, "invalid");

  // 读取时自动重算
  const got = getCredential(db, credState, cred.id);
  assert.equal(got.status, "valid");
  assert.equal(got.snapshot.races.length, 2);
});

test("凭据失效范围：子代变动不影响父辈凭据，自身变动失效", () => {
  const db = { pigeons: JSON.parse(JSON.stringify(target)) };
  const credState = { credentials: [] };
  issueCredential(db, credState, "B");
  // A 是 B 的子代；A 变动不应失效 B 的凭据（父辈快照不含子代）
  invalidateForPigeon(credState, db, "A");
  assert.equal(credState.credentials[0].status, "valid");
  // B 自身变动应失效 B 的凭据
  invalidateForPigeon(credState, db, "B");
  assert.equal(credState.credentials[0].status, "invalid");
});
