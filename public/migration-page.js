// 迁移并册页
const runStatus = document.querySelector("#runStatus");
const conflictsBox = document.querySelector("#conflicts");
const aliasesBox = document.querySelector("#aliases");
const startBtn = document.querySelector("#startBtn");
const retryBtn = document.querySelector("#retryBtn");

async function api(path, options) {
  const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || "请求失败");
  return data;
}

function renderRun(run) {
  if (!run) {
    runStatus.innerHTML = '<div class="muted-box">尚无迁移任务。迁移前请确认正式档案已备份。</div>';
    retryBtn.disabled = true;
    conflictsBox.innerHTML = '<div class="muted-box">暂无冲突。</div>';
    return;
  }
  const percent = run.total ? Math.round((run.checkpoint / run.total) * 100) : 0;
  runStatus.innerHTML = `
    <div class="row section">
      <span class="badge ${run.status}">${({ running: "进行中", failed: "失败待重试", conflicts: "有冲突", completed: "已完成" })[run.status]}</span>
      <span class="meta">任务 ${run.id} · 第 ${run.attempts} 次尝试 · 来源：${run.sources.join("、")}</span>
    </div>
    <div class="progress"><div style="width:${percent}%"></div></div>
    <div class="meta">检查点：${run.checkpoint}/${run.total} 条（${percent}%）</div>
    ${run.lastError ? `<div class="flash err">上次失败原因：${run.lastError}，已处理记录不会重复迁移，可从检查点重试。</div>` : ""}
    ${run.status === "completed" ? '<div class="flash ok">迁移完成：同一足环仅保留一份正式档案，可前往正式档案页核对。</div>' : ""}`;
  retryBtn.disabled = run.status !== "failed";

  if (run.aliases) {
    const groups = new Map();
    for (const alias of run.aliases) {
      if (!groups.has(alias.canonical)) groups.set(alias.canonical, []);
      groups.get(alias.canonical).push(alias.ring);
    }
    aliasesBox.innerHTML = [...groups.entries()].map(([canonical, rings]) =>
      `<span class="pill history">${rings.sort().map(escapeHtml).join(" ≡ ")} → 正式环 ${escapeHtml(canonical)}</span>`
    ).join(" ") || "无换环记录。";
  }
  renderConflicts(run);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function renderConflicts(run) {
  if (!run.conflicts.length) {
    conflictsBox.innerHTML = '<div class="muted-box">暂无冲突。资料一致的记录已自动合并，集合类资料按内容去重补充。</div>';
    return;
  }
  conflictsBox.innerHTML = run.conflicts.map((conflict, index) => {
    if (conflict.type === "cycle") {
      return `<article class="card cycle section">
        <h3>家谱成环 #${index + 1}</h3>
        <div>${escapeHtml(conflict.message)}</div>
        <div class="meta">请选择切断一条父母边（不自动删除任何档案）：</div>
        ${conflict.edges.map((edge, i) => `<div class="row"><label style="margin:0">切断 ${escapeHtml(edge.ring)} 的${edge.field === "fatherRing" ? "父" : "母"}边 → ${escapeHtml(edge.pointsTo)}</label><button data-cycle="${escapeHtml(conflict.id)}" data-edge="${i}">按此切断</button></div>`).join("")}
      </article>`;
    }
    const candidates = conflict.candidates.map(c => `<option value="value:${encodeURIComponent(c.value)}">采用${escapeHtml(c.source)}的值：${escapeHtml(c.value)}</option>`).join("");
    return `<article class="card conflict section">
      <h3>字段冲突：${escapeHtml(conflict.canonicalRing)} · ${({ owner: "鸽主", color: "羽色", loft: "棚号", fatherRing: "父鸽", motherRing: "母鸽" })[conflict.field] || conflict.field}</h3>
      <div>${escapeHtml(conflict.message)}</div>
      ${conflict.blocker ? '<div class="flash err">该字段在正式档案中已确认，迁移未覆盖，必须人工裁定。</div>' : ""}
      <div class="row section">
        <select id="choice-${index}">
          <option value="current">保留现值：${escapeHtml(conflict.currentValue)}（来自 ${escapeHtml(conflict.currentSource)}）</option>
          ${candidates}
        </select>
        <button data-field="${escapeHtml(conflict.id)}" data-index="${index}">裁定并保存</button>
      </div>
    </article>`;
  }).join("");

  conflictsBox.querySelectorAll("[data-field]").forEach(btn => {
    btn.onclick = async () => {
      const raw = document.querySelector(`#choice-${btn.dataset.index}`).value;
      const choice = raw.startsWith("value:") ? `value:${decodeURIComponent(raw.slice(6))}` : raw;
      await api(`/api/migration/conflicts/${encodeURIComponent(btn.dataset.field)}/resolve`, { method: "POST", body: JSON.stringify({ type: "field", choice }) });
      await refresh();
    };
  });
  conflictsBox.querySelectorAll("[data-cycle]").forEach(btn => {
    btn.onclick = async () => {
      const run = (await api("/api/migration")).run;
      const conflict = run.conflicts.find(item => item.id === btn.dataset.cycle);
      const edge = conflict.edges[Number(btn.dataset.edge)];
      await api(`/api/migration/conflicts/${encodeURIComponent(conflict.id)}/resolve`, { method: "POST", body: JSON.stringify({ type: "cycle", edge }) });
      await refresh();
    };
  });
}

async function refresh() {
  const data = await api("/api/migration");
  renderRun(data.run);
}
startBtn.onclick = async () => {
  try {
    await api("/api/migration/start", { method: "POST", body: JSON.stringify({ injectFault: document.querySelector("#injectFault").checked }) });
  } catch (e) { alert(e.message); }
  await refresh();
};
retryBtn.onclick = async () => { await api("/api/migration/retry", { method: "POST" }); await refresh(); };
document.querySelector("#refreshBtn").onclick = refresh;
refresh();
