// 迁移规则层：旧系统数据 -> 正式血统档案的并册规则。
// 纯函数，不读写文件；状态全部在传入的 store/migration 对象上，由调用方负责落检查点。

export const SCALAR_FIELDS = ["owner", "color", "loft", "fatherRing", "motherRing"];

export function normalizeRing(ring) {
  return String(ring || "").trim();
}

// 去重键：重复提交（同一内容再次提交）不新增疫苗和成绩。
export function vaccineKey(item) {
  return [item.date || "", String(item.name || "").trim()].join("|");
}
export function transferKey(item) {
  return [item.date || "", item.from || "", item.to || ""].join("|");
}
export function raceKey(item) {
  return [item.date || "", String(item.event || "").trim(), Number(item.distance) || 0].join("|");
}

function pushUnique(list, item, keyOf, source) {
  const key = keyOf(item);
  const existing = list.find(entry => keyOf(entry) === key);
  if (existing) {
    if (source && !existing.sources) existing.sources = [];
    if (source && !existing.sources.includes(source)) existing.sources.push(source);
    return false;
  }
  const entry = { ...item };
  if (source) entry.sources = [source];
  list.push(entry);
  return true;
}

// 换环：previousRing 指向旧环。并查集把同一羽的多个环号归到一组，
// 组根取“当前环”（最新记录里的 ringNo）。
export function buildAliasMap(sources) {
  const parent = new Map();
  const ensure = ring => {
    if (!parent.has(ring)) parent.set(ring, ring);
    return ring;
  };
  const find = ring => {
    ensure(ring);
    while (parent.get(ring) !== ring) {
      parent.set(ring, parent.get(parent.get(ring)));
      ring = parent.get(ring);
    }
    return ring;
  };
  const union = (a, b) => {
    ensure(a);
    ensure(b);
    // 旧环（b/previousRing）挂到当前环（a/ringNo）下
    parent.set(find(b), find(a));
  };
  for (const src of sources) {
    for (const rec of src.records) {
      ensure(normalizeRing(rec.ringNo));
      if (rec.previousRing) union(normalizeRing(rec.ringNo), normalizeRing(rec.previousRing));
    }
  }
  return {
    canonical(ring) {
      const normalized = normalizeRing(ring);
      if (!parent.has(normalized)) return normalized;
      return find(normalized);
    },
    has(ring) {
      return parent.has(normalizeRing(ring));
    },
    rings() {
      return [...parent.keys()];
    }
  };
}

export function flattenSources(sources) {
  const rows = [];
  for (const src of sources) {
    src.records.forEach((record, index) => {
      rows.push({
        recordId: `${src.source}#${record.ringNo}`,
        source: src.source,
        order: rows.length,
        record
      });
    });
  }
  return rows;
}

function upsertConflict(run, conflict, candidateSource) {
  const source = candidateSource || conflict.source;
  const existing = run.conflicts.find(item => item.canonicalRing === conflict.canonicalRing && item.type === conflict.type && item.field === conflict.field);
  if (existing) {
    if (!existing.candidates.some(candidate => candidate.value === conflict.value)) {
      existing.candidates.push({ value: conflict.value, source });
    }
    return existing;
  }
  run.conflicts.push({ ...conflict, candidates: [{ value: conflict.value, source }] });
  return existing || run.conflicts[run.conflicts.length - 1];
}

function handleScalar(pigeon, field, value, source, canonicalRing, run, meta, isNew) {
  if (value === "" || value === undefined || value === null) return;
  // 已确认记录不覆盖
  if (pigeon.confirmedFields?.includes(field)) {
    if (pigeon[field] !== value) {
      upsertConflict(run, {
        id: `${canonicalRing}:${field}`,
        type: "field",
        canonicalRing,
        field,
        value,
        currentValue: pigeon[field],
        currentSource: meta.fieldSources?.[field] || "正式档案",
        blocker: true,
        message: `字段 ${field} 已确认，保留 ${pigeon[field]}，待人工裁定`
      }, source);
    }
    return;
  }
  if (isNew || pigeon[field] === "" || pigeon[field] === undefined || pigeon[field] === null) {
    pigeon[field] = value;
    meta.fieldSources[field] = source;
    return;
  }
  if (pigeon[field] === value) return; // 资料一致，直接合并
  upsertConflict(run, {
    id: `${canonicalRing}:${field}`,
    type: "field",
    canonicalRing,
    field,
    value,
    currentValue: pigeon[field],
    currentSource: meta.fieldSources[field],
    blocker: false,
    message: `字段 ${field} 两边资料不同：${pigeon[field]} vs ${value}`
  }, source);
}

// 摄入一条旧记录（幂等：同一 recordId 重放不会重复追加集合内容）。
export function ingestRecord(run, store, aliases, { recordId, source, record }) {
  if (run.processedIds.includes(recordId)) return;
  const rawRing = normalizeRing(record.ringNo);
  const canonicalRing = aliases.canonical(rawRing);
  let pigeon = store.getPigeon(canonicalRing);
  let isNew = false;
  if (!pigeon) {
    pigeon = store.createPigeon({
      ringNo: canonicalRing,
      owner: "", fatherRing: "", motherRing: "", color: "", loft: "",
      ringHistory: [], sources: [], confirmedFields: [], mergeLog: [],
      vaccines: [], transfers: [], races: []
    });
    isNew = true;
  }
  store.ensureMeta(pigeon, { fieldSources: {} });

  for (const field of SCALAR_FIELDS) {
    handleScalar(pigeon, field, record[field], source, canonicalRing, run, pigeon._migrationMeta, isNew);
  }

  // 换过环：历史环号并入同一份档案
  const historyRings = [rawRing];
  if (record.previousRing) historyRings.push(normalizeRing(record.previousRing));
  for (const ring of historyRings) {
    if (ring !== canonicalRing && !pigeon.ringHistory.includes(ring)) pigeon.ringHistory.push(ring);
  }

  if (!pigeon.sources.includes(source)) pigeon.sources.push(source);

  // 父母、疫苗、转让、归巢成绩：补充 + 去重
  let changed = false;
  for (const vaccine of record.vaccines || []) {
    if (pushUnique(pigeon.vaccines, vaccine, vaccineKey, source)) changed = true;
  }
  for (const transfer of record.transfers || []) {
    if (pushUnique(pigeon.transfers, transfer, transferKey, source)) changed = true;
  }
  for (const race of record.races || []) {
    if (pushUnique(pigeon.races, race, raceKey, source)) changed = true;
  }

  if (!isNew && changed) pigeon.version += 1;
  pigeon.mergeLog.push({ at: run.startedAt, source, recordId, action: "ingest" });
  run.processedIds.push(recordId);
}

// 家谱成环检测：父/母边构成有向图，沿边找回到自身的路径。
export function findPedigreeCycles(pigeons) {
  const byRing = new Map(pigeons.map(pigeon => [pigeon.ringNo, pigeon]));
  const cycles = [];
  const seenCycleKeys = new Set();

  for (const pigeon of pigeons) {
    const path = [];
    const onPath = new Map();
    let current = pigeon.ringNo;
    let edge = null;
    const visited = new Set();
    while (current) {
      if (onPath.has(current)) {
        const start = onPath.get(current);
        const cyclePath = path.slice(start).map(step => step.ring);
        const key = [...cyclePath].sort().join(">");
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push({ ring: pigeon.ringNo, path: cyclePath });
        }
        break;
      }
      if (visited.has(current)) break;
      visited.add(current);
      const node = byRing.get(current);
      if (!node) break;
      onPath.set(current, path.length);
      path.push({ ring: current, edge });
      if (node.fatherRing) {
        current = node.fatherRing;
        edge = "fatherRing";
      } else if (node.motherRing) {
        current = node.motherRing;
        edge = "motherRing";
      } else {
        current = null;
      }
    }
  }
  return cycles;
}

// 迁移收尾：扫描家谱成环并登记冲突。
export function rescanCycleConflicts(run, store) {
  run.conflicts = run.conflicts.filter(conflict => conflict.type !== "cycle");
  const cycles = findPedigreeCycles(store.listPigeons());
  for (const cycle of cycles) {
    const edges = cycle.path.map((ring, index) => {
      const next = cycle.path[(index + 1) % cycle.path.length];
      const node = store.getPigeon(ring);
      return {
        ring,
        field: node.fatherRing === next ? "fatherRing" : "motherRing",
        pointsTo: next
      };
    });
    run.conflicts.push({
      id: `cycle:${[...cycle.path].sort().join(">")}`,
      type: "cycle",
      canonicalRing: cycle.ring,
      path: cycle.path,
      edges,
      blocker: true,
      message: `家谱成环：${cycle.path.join(" → ")} → ${cycle.path[0]}`
    });
  }
  return cycles;
}

export const TRANSIENT_ERROR = "transient: 旧系统导出读取超时";

// 从检查点继续：逐行摄入，每行落检查点；遇到预置瞬时故障停下，可重试。
export async function driveMigration(run, store, sources, options = {}) {
  const aliases = buildAliasMap(sources);
  const rows = flattenSources(sources);
  for (const row of rows) {
    if (run.processedIds.includes(row.recordId)) continue;
    if (options.injectFaultId && options.injectFaultId === row.recordId && run.attempts === 1) {
      run.status = "failed";
      run.lastError = TRANSIENT_ERROR;
      run.checkpoint = run.processedIds.length;
      if (options.onCheckpoint) await options.onCheckpoint(run);
      return { stopped: true, reason: "fault" };
    }
    ingestRecord(run, store, aliases, row);
    run.checkpoint = run.processedIds.length;
    if (options.onCheckpoint) await options.onCheckpoint(run);
  }
  run.lastError = "";
  rescanCycleConflicts(run, store);
  run.status = run.conflicts.some(conflict => conflict.blocker) ? "conflicts" : "completed";
  if (options.onCheckpoint) await options.onCheckpoint(run);
  return { stopped: false, reason: run.status };
}

// 冲突裁定：字段冲突选定值（current / incoming / 具体候选值）
export function resolveFieldConflict(run, store, conflictId, choice) {
  const conflict = run.conflicts.find(item => item.id === conflictId && item.type === "field");
  if (!conflict) throw new Error("conflict_not_found");
  const pigeon = store.getPigeon(conflict.canonicalRing);
  if (!pigeon) throw new Error("pigeon_not_found");
  let value;
  if (choice === "current") value = conflict.currentValue;
  else if (choice === "incoming") value = conflict.candidates[0].value;
  else if (choice.startsWith("value:")) value = choice.slice(6);
  else value = choice; // 直接给值
  pigeon[conflict.field] = value;
  pigeon._migrationMeta.fieldSources[conflict.field] = "人工裁定";
  pigeon.version += 1;
  pigeon.mergeLog.push({ at: new Date().toISOString(), action: "resolve-conflict", conflictId, value });
  run.conflicts = run.conflicts.filter(item => item.id !== conflictId);
  rescanCycleConflicts(run, store);
  run.status = run.conflicts.some(item => item.blocker) ? "conflicts" : "completed";
  return conflict;
}

// 冲突裁定：家谱成环时切断一条父母边
export function resolveCycleConflict(run, store, conflictId, edge) {
  const conflict = run.conflicts.find(item => item.id === conflictId && item.type === "cycle");
  if (!conflict) throw new Error("conflict_not_found");
  const target = edge && edge.ring ? edge : conflict.edges[0];
  const pigeon = store.getPigeon(target.ring);
  if (!pigeon || pigeon[target.field] !== target.pointsTo) throw new Error("invalid_edge");
  pigeon[target.field] = "";
  pigeon.version += 1;
  pigeon.mergeLog.push({
    at: new Date().toISOString(),
    action: "resolve-cycle",
    conflictId,
    dropped: `${target.ring}.${target.field} -> ${target.pointsTo}`
  });
  rescanCycleConflicts(run, store);
  run.status = run.conflicts.some(item => item.blocker) ? "conflicts" : "completed";
  return conflict;
}
