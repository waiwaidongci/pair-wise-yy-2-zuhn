// 迁移规则层：纯函数，不做 I/O。
// 职责：分析两个鸽棚的档案、列出冲突与家谱成环、按归并方案应用、保证不覆盖已确认记录。
// 所有函数只操作普通对象，便于测试与复用。

// 已确认字段：两边不一致时列为冲突，不自动覆盖。
const CONFIRMED_FIELDS = ["owner", "color", "loft", "fatherRing", "motherRing"];
// 补充字段：只做并集去重，不产生冲突。
const ADDITIVE_FIELDS = ["vaccines", "transfers", "races"];

// 补充字段的去重键：重复提交/重复迁移不会新增疫苗、转让或成绩。
function itemKey(field, item) {
  if (field === "vaccines") return `vaccine:${item.date || ""}|${item.name || ""}`;
  if (field === "transfers") return `transfer:${item.date || ""}|${item.from || ""}|${item.to || ""}`;
  if (field === "races") return `race:${item.date || ""}|${item.event || ""}`;
  return `item:${JSON.stringify(item)}`;
}

function dedupUnion(target = [], source = [], field) {
  const seen = new Set();
  const out = [];
  for (const item of [...target, ...source]) {
    if (item == null) continue;
    const key = itemKey(field, item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// 空白值归一：undefined/null 视为空串，便于比较。
function norm(v) {
  return v == null ? "" : String(v);
}

// 分析一份来源档案与目标档案的归并方案。
// 返回 { additions, updates, cycles }。
// additions: 目标中没有的足环（含通过 previousRing 换环关联到目标旧环的情况）。
// updates: 目标中已存在的足环，含 merged 结果与 conflicts。
// cycles: 归并后家谱图中检测到的成环。
export function analyzeMigration(sourcePigeons = [], targetPigeons = []) {
  const targetByRing = new Map();
  for (const p of targetPigeons) targetByRing.set(p.ringNo, p);

  const additions = [];
  const updates = [];
  // 记录换环关联：source.ringNo -> target.ringNo（当来源新环能通过 previousRing 命中目标旧环）
  const ringLinks = new Map();

  for (const incoming of sourcePigeons) {
    if (incoming == null || !incoming.ringNo) continue;
    let existing = targetByRing.get(incoming.ringNo);
    let linkedVia = null;
    if (!existing && incoming.previousRing && targetByRing.has(incoming.previousRing)) {
      existing = targetByRing.get(incoming.previousRing);
      linkedVia = incoming.previousRing;
      ringLinks.set(incoming.ringNo, incoming.previousRing);
    }

    if (!existing) {
      additions.push({
        ringNo: incoming.ringNo,
        record: { ...incoming, confirmed: true, ringHistory: incoming.ringHistory || [] },
      });
      continue;
    }

    const conflicts = [];
    const merged = { ...existing };
    for (const field of CONFIRMED_FIELDS) {
      const tv = norm(existing[field]);
      const sv = norm(incoming[field]);
      if (tv === sv) { merged[field] = tv; continue; }
      if (tv === "") { merged[field] = sv; continue; } // 目标为空，来源补充
      if (sv === "") { merged[field] = tv; continue; } // 来源为空，保留目标
      // 两边都有值且不一致 → 冲突，默认保留目标（已确认记录不被覆盖）
      conflicts.push({ field, targetValue: tv, sourceValue: sv, resolution: null });
      merged[field] = tv;
    }
    for (const field of ADDITIVE_FIELDS) {
      merged[field] = dedupUnion(existing[field], incoming[field], field);
    }
    // 换环关联：把新环记入 ringHistory，正式档案仍保留在旧环记录上（一鸽一档）。
    if (linkedVia) {
      merged.ringHistory = dedupUnion(existing.ringHistory, [incoming.ringNo], "ringHistory");
    }
    updates.push({
      ringNo: existing.ringNo,
      incomingRingNo: incoming.ringNo,
      linkedVia,
      base: existing,
      incoming,
      merged,
      conflicts,
    });
  }

  // 在“归并后”的候选家谱图上检测成环。
  const candidates = [
    ...targetPigeons,
    ...additions.map(a => a.record),
    ...updates.map(u => u.merged),
  ];
  const cycles = detectCycles(candidates);

  return { additions, updates, cycles, ringLinks: [...ringLinks.entries()] };
}

// 家谱成环检测（DFS 三色标记）。
// 图的边：ringNo -> fatherRing / motherRing（仅当目标环在档案中存在）。
// 返回 [{ nodes, breakAt: { ringNo, field, target } }]，breakAt 为闭合环的那条边，供“断环”决议使用。
export function detectCycles(pigeons = []) {
  const byRing = new Map();
  for (const p of pigeons) if (p && p.ringNo) byRing.set(p.ringNo, p);

  const adj = new Map();
  for (const p of pigeons) {
    if (!p || !p.ringNo) continue;
    const edges = [];
    if (p.fatherRing && byRing.has(p.fatherRing)) edges.push({ from: p.ringNo, to: p.fatherRing, field: "fatherRing" });
    if (p.motherRing && byRing.has(p.motherRing)) edges.push({ from: p.ringNo, to: p.motherRing, field: "motherRing" });
    if (edges.length) adj.set(p.ringNo, edges);
  }

  const color = new Map(pigeons.map(p => [p.ringNo, "white"]));
  const cycles = [];
  const seenCycleKeys = new Set();
  const stack = [];

  function dfs(node) {
    color.set(node, "gray");
    stack.push(node);
    for (const edge of (adj.get(node) || [])) {
      const c = color.get(edge.to);
      if (c === "gray") {
        const startIdx = stack.indexOf(edge.to);
        const nodes = stack.slice(startIdx);
        const key = [...nodes].sort().join("|");
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push({ nodes: [...nodes, edge.to], breakAt: { ringNo: node, field: edge.field, target: edge.to } });
        }
      } else if (c === "white") {
        dfs(edge.to);
      }
    }
    stack.pop();
    color.set(node, "black");
  }

  for (const p of pigeons) {
    if (p && color.get(p.ringNo) === "white") dfs(p.ringNo);
  }
  return cycles;
}

// 应用归并方案，返回新的目标档案与结果。纯函数，不修改入参。
// applied: 已应用过的环号集合（检查点），重试时跳过，保证幂等。
// plan.cycles 中的决议：
//   resolution = "break" → 应用时丢弃 breakAt 那条边（断环）
//   resolution = "skip"  → 跳过该环号的更新，保留已确认记录
// 其余成环在应用时仍会被兜底检测并断环，绝不写成环家谱。
export function applyMigration(plan, targetPigeons = [], applied = {}) {
  const appliedRingNos = new Set(applied.ringNos || []);
  const result = { added: [], updated: [], skippedLinks: [], skippedRecords: [] };
  let pigeons = targetPigeons.map(p => ({ ...p }));

  const skipRingNos = new Set();
  const breakLinks = [];
  for (const cyc of (plan.cycles || [])) {
    if (cyc.resolution === "skip") {
      for (const r of cyc.nodes) skipRingNos.add(r);
    } else if (cyc.resolution === "break") {
      breakLinks.push(cyc.breakAt);
    }
  }

  // 新增档案
  for (const add of plan.additions || []) {
    if (appliedRingNos.has(add.ringNo)) continue;
    if (skipRingNos.has(add.ringNo)) { result.skippedRecords.push(add.ringNo); continue; }
    pigeons.push({ ...add.record });
    result.added.push(add.ringNo);
    appliedRingNos.add(add.ringNo);
  }

  // 更新已存在档案
  for (const upd of plan.updates || []) {
    if (appliedRingNos.has(upd.ringNo)) {
      result.updated.push(upd.ringNo + "（已应用，跳过）");
      continue;
    }
    if (skipRingNos.has(upd.ringNo)) { result.skippedRecords.push(upd.ringNo); continue; }
    const idx = pigeons.findIndex(p => p.ringNo === upd.ringNo);
    if (idx === -1) continue;
    const finalRecord = { ...upd.merged };
    for (const c of upd.conflicts || []) {
      if (c.resolution === "source") finalRecord[c.field] = c.sourceValue;
      else if (c.resolution === "target") finalRecord[c.field] = c.targetValue;
      // null 或其它：保留 merged 中的目标值（不覆盖已确认记录）
    }
    pigeons[idx] = finalRecord;
    result.updated.push(upd.ringNo);
    appliedRingNos.add(upd.ringNo);
  }

  // 按“断环”决议丢弃指定边
  for (const link of breakLinks) {
    const idx = pigeons.findIndex(p => p.ringNo === link.ringNo);
    if (idx !== -1 && pigeons[idx][link.field] === link.target) {
      pigeons[idx] = { ...pigeons[idx], [link.field]: "" };
      result.skippedLinks.push({ ringNo: link.ringNo, field: link.field, target: link.target });
    }
  }

  // 兜底：应用后再次检测成环，仍有成环则丢弃闭合边，绝不写成环家谱。
  let remaining = detectCycles(pigeons);
  for (const cyc of remaining) {
    const link = cyc.breakAt;
    const idx = pigeons.findIndex(p => p.ringNo === link.ringNo);
    if (idx !== -1 && pigeons[idx][link.field] === link.target) {
      pigeons[idx] = { ...pigeons[idx], [link.field]: "" };
      result.skippedLinks.push({ ringNo: link.ringNo, field: link.field, target: link.target, reason: "auto_break_cycle" });
    }
  }
  // 兜底后理论上无环；若仍有（如双向引用），记录但不阻断。
  remaining = detectCycles(pigeons);
  if (remaining.length) result.unresolvedCycles = remaining.map(c => c.nodes);

  return { pigeons, result, applied: { ringNos: [...appliedRingNos] } };
}

// 判断方案是否还有未决议的冲突或成环。
export function hasUnresolved(plan) {
  const fieldConflicts = (plan.updates || []).some(u => (u.conflicts || []).some(c => !c.resolution));
  const cycleConflicts = (plan.cycles || []).some(c => !c.resolution);
  return fieldConflicts || cycleConflicts;
}

// 统计待决议冲突数。
export function countUnresolved(plan) {
  let n = 0;
  for (const u of plan.updates || []) n += (u.conflicts || []).filter(c => !c.resolution).length;
  n += (plan.cycles || []).filter(c => !c.resolution).length;
  return n;
}
