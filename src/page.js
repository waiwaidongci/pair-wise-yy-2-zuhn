// 页面入口：返回单页 HTML。页面只负责展示与交互，调用 /api/* 完成迁移与档案操作。
export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽血统环号登记站 · 并册迁移</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#3f7a4e; --amber:#8a6d1a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; font-family:inherit; }
    textarea { min-height:140px; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.ghost { background:#eef2f5; color:var(--ink); } button.danger { background:var(--red); } button:disabled { opacity:.5; cursor:not-allowed; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.ok { color:var(--green); border-color:var(--green); } .pill.bad { color:var(--red); border-color:var(--red); } .pill.warn { color:var(--amber); border-color:var(--amber); }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .mig { border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:10px; background:#fcfdfe; }
    .conflict { border-left:3px solid var(--red); padding:8px 10px; margin:6px 0; background:#fdf6f5; border-radius:4px; font-size:13px; }
    .cycle { border-left:3px solid var(--amber); padding:8px 10px; margin:6px 0; background:#fdfaf2; border-radius:4px; font-size:13px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:6px; }
    .tabs { display:flex; gap:6px; margin-bottom:16px; flex-wrap:wrap; } .tabs button { background:#eef2f5; color:var(--ink); } .tabs button.active { background:var(--accent); color:#fff; }
    .tabpane { display:none; } .tabpane.active { display:block; }
    pre { background:#f6f8fa; border:1px solid var(--line); border-radius:6px; padding:10px; overflow:auto; font-size:12px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、血统、转让、归巢成绩 · 两棚并册迁移</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建鸽只档案</h2>
      <label>足环号</label><input name="ringNo" required>
      <label>鸽主</label><input name="owner" required>
      <label>父鸽足环号</label><input name="fatherRing">
      <label>母鸽足环号</label><input name="motherRing">
      <label>羽色</label><input name="color" required>
      <label>出生棚号</label><input name="loft" required>
      <button>保存档案</button>
    </form>
    <section>
      <div class="tabs">
        <button data-tab="pigeons" class="active">档案与血统</button>
        <button data-tab="migrations">并册迁移</button>
        <button data-tab="credentials">参赛凭据</button>
      </div>

      <div class="tabpane active" id="tab-pigeons">
        <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
        <div class="panel" id="detail"></div>
        <div class="section grid" id="cards"></div>
      </div>

      <div class="tabpane" id="tab-migrations">
        <div class="panel">
          <h2>提交旧棚档案并册</h2>
          <div class="meta">粘贴另一鸽棚的档案 JSON（{ "pigeons": [...] }）。同一足环只留一份正式档案；资料不同或家谱成环时先列冲突，不覆盖已确认记录。</div>
          <textarea id="migSource" placeholder='{"pigeons":[...]}'></textarea>
          <div class="row"><button id="migSubmit">提交并册</button><button class="ghost" id="migSample">填入示例</button></div>
        </div>
        <div class="section" id="migList"></div>
      </div>

      <div class="tabpane" id="tab-credentials">
        <div class="panel">
          <h2>已发参赛凭据</h2>
          <div class="meta">凭据签发时快照血统与成绩；并册后血统或成绩变动会使凭据失效，读取时按当前档案重算。</div>
          <div class="row"><input id="credRing" placeholder="足环号" style="max-width:220px"><button id="credIssue">签发凭据</button><button class="ghost" id="credRefresh">刷新列表</button></div>
        </div>
        <div class="section" id="credList"></div>
      </div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#form");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    let pigeons = [];

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&","<":"<",">":">",'"':"""}[c])); }

    function renderCards() {
      cards.innerHTML = pigeons.map(p => '<article class="card"><h3>'+esc(p.ringNo)+'</h3><span class="pill">'+esc(p.owner)+'</span><div class="meta">'+esc(p.color)+' · '+esc(p.loft)+'</div><div>父：'+esc(p.fatherRing || "未登记")+'</div><div>母：'+esc(p.motherRing || "未登记")+'</div><div class="meta">疫苗 '+(p.vaccines||[]).length+' · 转让 '+(p.transfers||[]).length+' · 成绩 '+(p.races||[]).length+'</div><label>录入转让</label><input data-to="'+esc(p.ringNo)+'" placeholder="新归属人"><button data-transfer="'+esc(p.ringNo)+'">保存转让</button><label>归巢成绩</label><input data-race="'+esc(p.ringNo)+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+esc(p.ringNo)+'">保存成绩</button></article>').join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+CSS.escape(ringNo)+'"]').value;
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await load();
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+CSS.escape(ringNo)+'"]').value.split("/");
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) }); await load();
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      detail.innerHTML = '<h2>'+esc(p.ringNo)+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+esc(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+esc(p.owner)+' · '+esc(p.color)+'</div><div class="small"><b>母鸽</b><br>'+esc(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div><b>子代</b> '+esc(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div><div class="meta">转让：'+esc(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div><div class="meta">归巢：'+esc(p.races.map(r => r.event+" 第"+r.rank+"名").join(" / ") || "暂无")+'</div>';
    }
    async function load(){ pigeons = await api("/api/pigeons"); renderCards(); renderRelation(null); }

    document.querySelector("#searchBtn").onclick = async () => {
      try { renderRelation(await api('/api/pigeons/'+encodeURIComponent(search.value)+'/relation')); }
      catch(e){ detail.innerHTML = '<p class="meta">'+esc(e.message)+'</p>'; }
    };
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };

    // tabs
    document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
      document.querySelectorAll(".tabs button").forEach(x => x.classList.remove("active"));
      document.querySelectorAll(".tabpane").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      document.querySelector("#tab-"+b.dataset.tab).classList.add("active");
      if (b.dataset.tab === "migrations") loadMigrations();
      if (b.dataset.tab === "credentials") loadCredentials();
    });

    // migrations
    const migSource = document.querySelector("#migSource");
    document.querySelector("#migSample").onclick = () => {
      migSource.value = JSON.stringify({ pigeons: [
        { ringNo:"CHN-2026-001", owner:"南岸棚", fatherRing:"CHN-2022-188", motherRing:"CHN-2023-512", color:"灰", loft:"南岸B棚", vaccines:[{date:"2026-04-01",name:"新城疫"},{date:"2026-05-10",name:"鸽痘"}], transfers:[], races:[{date:"2026-06-01",event:"120公里训放",distance:120,returnTime:"10:42",rank:18},{date:"2026-06-20",event:"200公里",distance:200,returnTime:"11:05",rank:9}] },
        { ringNo:"CHN-2022-188", owner:"南岸棚", fatherRing:"CHN-2020-001", motherRing:"", color:"雨点", loft:"南岸种鸽棚", vaccines:[], transfers:[], races:[] },
        { ringNo:"CHN-2023-512", owner:"南岸棚", fatherRing:"", motherRing:"", color:"红轮", loft:"南岸种鸽棚", vaccines:[], transfers:[], races:[] },
        { ringNo:"CHN-2020-001", owner:"南岸棚", fatherRing:"CHN-2022-188", motherRing:"", color:"灰", loft:"南岸种鸽棚", vaccines:[], transfers:[], races:[] },
        { ringNo:"CHN-2026-002", owner:"南岸棚", fatherRing:"CHN-2020-001", motherRing:"CHN-2023-512", color:"雨点", loft:"南岸B棚", vaccines:[], transfers:[], races:[] }
      ]}, null, 2);
    };
    document.querySelector("#migSubmit").onclick = async () => {
      try {
        const source = JSON.parse(migSource.value);
        await api("/api/migrations", { method:"POST", body: JSON.stringify(source) });
        migSource.value = "";
        await loadMigrations(); await load();
      } catch(e){ alert(e.message); }
    };

    function statusPill(s){
      const map = { completed:["ok","已完成"], conflicted:["bad","待决议"], applying:["warn","应用中"], failed:["bad","失败"], analyzing:["warn","分析中"], ready:["ok","就绪"] };
      const [cls,label] = map[s] || ["warn",s];
      return '<span class="pill '+cls+'">'+label+'</span>';
    }

    async function loadMigrations(){
      const list = await api("/api/migrations");
      const el = document.querySelector("#migList");
      if (!list.length) { el.innerHTML = '<p class="meta">暂无并册记录。</p>'; return; }
      el.innerHTML = list.map(m => {
        const plan = m.plan || {};
        const conflicts = (plan.updates||[]).flatMap(u => (u.conflicts||[]).map(c => ({u,c})));
        const cycles = plan.cycles || [];
        const unresolved = conflicts.filter(x => !x.c.resolution).length + cycles.filter(c => !c.resolution).length;
        let html = '<div class="mig"><div class="row"><b>'+esc(m.id)+'</b> '+statusPill(m.status)+'<span class="pill">检查点：'+esc(m.checkpoint)+'</span></div>';
        html += '<div class="meta">新增 '+(plan.additions||[]).length+' · 更新 '+(plan.updates||[]).length+' · 冲突 '+conflicts.length+' · 成环 '+cycles.length+(m.error?(' · 错误：'+esc(m.error)):'')+'</div>';
        for (const {u,c} of conflicts) {
          const idx = plan.updates.indexOf(u);
          html += '<div class="conflict"><b>'+esc(u.ringNo)+'</b> 字段 <b>'+esc(c.field)+'</b> 不一致：目标「'+esc(c.targetValue)+'」vs 来源「'+esc(c.sourceValue)+'」<div class="row"><button data-resolve="'+m.id+'" data-u="'+idx+'" data-field="'+esc(c.field)+'" data-choice="target" class="ghost">保留目标</button><button data-resolve="'+m.id+'" data-u="'+idx+'" data-field="'+esc(c.field)+'" data-choice="source">采用来源</button></div></div>';
        }
        cycles.forEach((cyc, i) => {
          html += '<div class="cycle"><b>家谱成环</b>：'+esc(cyc.nodes.join(" → "))+'<div class="meta">断环位置：'+esc(cyc.breakAt.ringNo)+' 的 '+esc(cyc.breakAt.field)+' → '+esc(cyc.breakAt.target)+'</div><div class="row"><button data-cycle="'+m.id+'" data-i="'+i+'" data-choice="break" class="ghost">断环</button><button data-cycle="'+m.id+'" data-i="'+i+'" data-choice="skip" class="danger">跳过该记录</button></div></div>';
        });
        if (m.result) html += '<div class="meta">结果：新增 '+(m.result.added||[]).length+' · 更新 '+(m.result.updated||[]).length+' · 断环 '+(m.result.skippedLinks||[]).length+' · 跳过记录 '+(m.result.skippedRecords||[]).length+'</div>';
        html += '<div class="row"><button data-retry="'+m.id+'" '+(unresolved?'disabled':'')+'>从检查点重试</button></div>';
        html += '</div>';
        return html;
      }).join("");
      document.querySelectorAll("[data-resolve]").forEach(b => b.onclick = async () => {
        await api('/api/migrations/'+encodeURIComponent(b.dataset.resolve)+'/conflicts/'+b.dataset.u+'/'+encodeURIComponent(b.dataset.field)+'/resolve', { method:'POST', body: JSON.stringify({ choice: b.dataset.choice }) });
        await loadMigrations(); await load();
      });
      document.querySelectorAll("[data-cycle]").forEach(b => b.onclick = async () => {
        await api('/api/migrations/'+encodeURIComponent(b.dataset.cycle)+'/cycles/'+b.dataset.i+'/resolve', { method:'POST', body: JSON.stringify({ choice: b.dataset.choice }) });
        await loadMigrations(); await load();
      });
      document.querySelectorAll("[data-retry]").forEach(b => b.onclick = async () => {
        try { await api('/api/migrations/'+encodeURIComponent(b.dataset.retry)+'/retry', { method:'POST' }); await loadMigrations(); await load(); }
        catch(e){ alert(e.message); }
      });
    }

    // credentials
    async function loadCredentials(){
      const list = await api("/api/credentials");
      const el = document.querySelector("#credList");
      if (!list.length) { el.innerHTML = '<p class="meta">暂无凭据。</p>'; return; }
      el.innerHTML = list.map(c => {
        const s = c.snapshot || {};
        return '<div class="mig"><div class="row"><b>'+esc(c.id)+'</b> '+statusPill(c.status==="valid"?"completed":"conflicted")+'<span class="pill">'+esc(c.ringNo)+'</span></div><div class="meta">鸽主 '+esc(s.owner)+' · 羽色 '+esc(s.color)+' · 棚号 '+esc(s.loft)+' · 疫苗 '+(s.vaccines||[]).length+' · 转让 '+(s.transfers||[]).length+' · 成绩 '+(s.races||[]).length+'</div><div class="row"><button data-cred="'+esc(c.id)+'" class="ghost">读取/重算</button></div></div>';
      }).join("");
      document.querySelectorAll("[data-cred]").forEach(b => b.onclick = async () => {
        const c = await api('/api/credentials/'+encodeURIComponent(b.dataset.cred));
        alert('凭据 '+c.id+'\\n足环：'+c.ringNo+'\\n状态：'+c.status+'\\n成绩数：'+(c.snapshot.races||[]).length);
        await loadCredentials();
      });
    }
    document.querySelector("#credIssue").onclick = async () => {
      const ring = document.querySelector("#credRing").value.trim();
      if (!ring) return alert("请输入足环号");
      try { await api('/api/pigeons/'+encodeURIComponent(ring)+'/credentials', { method:'POST' }); await loadCredentials(); }
      catch(e){ alert(e.message); }
    };
    document.querySelector("#credRefresh").onclick = loadCredentials;

    load();
  </script>
</body>
</html>`;
}
