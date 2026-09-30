// 参赛凭据页
const rows = document.querySelector("#rows");
const flash = document.querySelector("#flash");

async function api(path, options) {
  const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || "请求失败");
  return data;
}
const esc = value => String(value ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

async function load() {
  const data = await api("/api/credentials");
  if (!data.credentials.length) {
    rows.innerHTML = '<tr><td colspan="8" class="meta">尚未签发任何参赛凭据。</td></tr>';
    return;
  }
  rows.innerHTML = data.credentials.map(c => `
    <tr>
      <td><span class="badge ${c.status}">${c.status === "valid" ? "有效" : "已失效"}</span></td>
      <td>${esc(c.ringNo)}</td>
      <td>${esc(c.event)}</td>
      <td class="mono">${esc(c.id.slice(0, 8))}</td>
      <td class="mono">${esc(c.pedigreeFingerprint)}</td>
      <td class="mono">${esc(c.raceFingerprint)}</td>
      <td class="mono">${c.supersedes ? esc(c.supersedes.slice(0, 8)) : ""}</td>
      <td>${esc(c.invalidReason || "")}</td>
    </tr>`).join("");
}

document.querySelector("#issueBtn").onclick = async () => {
  try {
    const result = await api("/api/credentials", { method: "POST", body: JSON.stringify({ ringNo: document.querySelector("#ringNo").value.trim(), event: document.querySelector("#event").value.trim() }) });
    flash.className = `flash ${result.reused ? "warn" : "ok"}`;
    flash.textContent = result.reused ? `指纹未变，重复提交不新发，沿用原凭据 ${result.credential.id.slice(0, 8)}。` : `已签发凭据 ${result.credential.id.slice(0, 8)}。`;
    await load();
  } catch (e) { flash.className = "flash err"; flash.textContent = e.message; }
};
load();
