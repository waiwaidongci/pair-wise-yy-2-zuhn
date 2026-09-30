// 正式档案页
const cards = document.querySelector("#cards");
const detail = document.querySelector("#detail");
const search = document.querySelector("#search");
const formFlash = document.querySelector("#formFlash");
let pigeons = [];

async function api(path, options) {
  const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || "请求失败");
  return data;
}
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

function renderCards() {
  document.querySelector("#count").textContent = pigeons.length;
  cards.innerHTML = pigeons.map(p => `
    <article class="card">
      <h3>${esc(p.ringNo)}</h3>
      <div>
        <span class="pill">${esc(p.owner)}</span>
        ${p.confirmedFields.map(f => `<span class="pill confirmed">已确认:${({ owner: "鸽主", color: "羽色", loft: "棚号", fatherRing: "父", motherRing: "母" })[f]}</span>`).join("")}
      </div>
      <div class="meta">${esc(p.color)} · ${esc(p.loft)} · v${p.version}</div>
      <div>父：${esc(p.fatherRing) || "未登记"}　母：${esc(p.motherRing) || "未登记"}</div>
      ${p.ringHistory.length ? `<div class="meta">历史环号：${p.ringHistory.map(esc).join("、")}</div>` : ""}
      <div class="meta">来源：${p.sources.map(esc).join(" / ")}</div>
      <div class="meta">疫苗 ${p.vaccines.length} 条 · 转让 ${p.transfers.length} 条 · 成绩 ${p.races.length} 条</div>
    </article>`).join("");
}

function renderRelation(data) {
  if (!data) {
    detail.innerHTML = '<div class="muted-box">请输入足环号查看父母、子代、疫苗、转让和成绩。</div>';
    return;
  }
  const p = data.pigeon;
  detail.innerHTML = `
    <h2>${esc(p.ringNo)} 血统档案 <span class="meta">v${p.version}</span></h2>
    <div class="relation">
      <div class="small"><b>父鸽</b><br>${esc(data.father?.ringNo || p.fatherRing) || "未登记"}</div>
      <div class="small"><b>本鸽</b><br>${esc(p.owner)} · ${esc(p.color)} · ${esc(p.loft)}</div>
      <div class="small"><b>母鸽</b><br>${esc(data.mother?.ringNo || p.motherRing) || "未登记"}</div>
    </div>
    <div class="row">
      <input id="newFather" placeholder="改父鸽足环号" value="${esc(p.fatherRing)}" style="flex:1">
      <input id="newMother" placeholder="改母鸽足环号" value="${esc(p.motherRing)}" style="flex:1">
      <button id="savePedigree">保存血统（凭据将失效重算）</button>
    </div>
    <div class="flash" id="pedFlash"></div>
    <div class="section"><b>子代</b> ${data.children.map(c => esc(c.ringNo)).join("、") || "暂无"}</div>
    <div class="section"><b>疫苗</b><table><tbody>${
      p.vaccines.map(v => `<tr><td>${esc(v.date)}</td><td>${esc(v.name)}</td></tr>`).join("") || '<tr><td class="meta">暂无</td></tr>'
    }</tbody></table>
      <div class="row section"><input id="vDate" type="date" style="flex:1"><input id="vName" placeholder="疫苗名" style="flex:1"><button id="addV">补疫苗（重复提交不新增）</button></div>
    </div>
    <div class="section"><b>转让</b><table><tbody>${
      p.transfers.map(t => `<tr><td>${esc(t.date)}</td><td>${esc(t.from)} → ${esc(t.to)}</td></tr>`).join("") || '<tr><td class="meta">暂无</td></tr>'
    }</tbody></table>
      <div class="row section"><input id="tTo" placeholder="新归属人" style="flex:1"><button id="addT">保存转让</button></div>
    </div>
    <div class="section"><b>归巢成绩</b><table><tbody>${
      p.races.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.event)}</td><td>${r.distance}km</td><td>第${r.rank}名 ${esc(r.returnTime)}</td></tr>`).join("") || '<tr><td class="meta">暂无</td></tr>'
    }</tbody></table>
      <div class="row section"><input id="rDate" type="date" style="flex:1"><input id="rEvent" placeholder="赛事" style="flex:1"><input id="rDistance" placeholder="公里" style="width:90px"><input id="rRank" placeholder="名次" style="width:90px"><button id="addR">补成绩（重复提交不新增，凭据重算）</button></div>
    </div>
    <div class="flash" id="actFlash"></div>`;

  const ring = encodeURIComponent(p.ringNo);
  const flash = document.querySelector("#actFlash");
  const pedFlash = document.querySelector("#pedFlash");
  document.querySelector("#savePedigree").onclick = async () => {
    try {
      const result = await api(`/api/pigeons/${ring}/pedigree`, { method: "PUT", body: JSON.stringify({ fatherRing: document.querySelector("#newFather").value.trim(), motherRing: document.querySelector("#newMother").value.trim() }) });
      pedFlash.className = "flash ok";
      const c = result.credentials;
      pedFlash.textContent = `已保存。失效凭据 ${c?.invalidated.length || 0} 张，补发 ${c?.reissued.length || 0} 张。`;
      await load(search.value);
    } catch (e) { pedFlash.className = "flash err"; pedFlash.textContent = e.message; }
  };
  document.querySelector("#addV").onclick = async () => {
    const result = await api(`/api/pigeons/${ring}/vaccines`, { method: "POST", body: JSON.stringify({ date: document.querySelector("#vDate").value, name: document.querySelector("#vName").value }) });
    flash.className = result.duplicate ? "flash warn" : "flash ok";
    flash.textContent = result.duplicate ? "重复提交：该疫苗已存在，未新增。" : "疫苗已补充。";
    await load(p.ringNo);
  };
  document.querySelector("#addT").onclick = async () => {
    await api(`/api/pigeons/${ring}/transfers`, { method: "POST", body: JSON.stringify({ to: document.querySelector("#tTo").value }) });
    await load(p.ringNo);
  };
  document.querySelector("#addR").onclick = async () => {
    const result = await api(`/api/pigeons/${ring}/races`, { method: "POST", body: JSON.stringify({ date: document.querySelector("#rDate").value, event: document.querySelector("#rEvent").value, distance: Number(document.querySelector("#rDistance").value || 0), rank: Number(document.querySelector("#rRank").value || 0) }) });
    flash.className = result.duplicate ? "flash warn" : "flash ok";
    flash.textContent = result.duplicate ? "重复提交：该成绩已存在，未新增。" : `成绩已补充。失效凭据 ${result.credentials?.invalidated.length || 0} 张，补发 ${result.credentials?.reissued.length || 0} 张。`;
    await load(p.ringNo);
  };
}

async function load(query) {
  pigeons = await api("/api/pigeons");
  renderCards();
  if (query) {
    try { renderRelation(await api(`/api/pigeons/${encodeURIComponent(query.trim())}/relation`)); }
    catch { renderRelation(null); }
  }
}
document.querySelector("#searchBtn").onclick = () => load(search.value);
document.querySelector("#form").onsubmit = async event => {
  event.preventDefault();
  try {
    await api("/api/pigeons", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
    form.reset(); formFlash.textContent = "";
    await load();
  } catch (e) { formFlash.className = "flash err"; formFlash.textContent = e.message; }
};
load();
