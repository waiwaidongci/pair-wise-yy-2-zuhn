// 参赛凭据层：凭据的签发、失效与重算。
// 凭据在签发时快照鸽只的血统与成绩；并册后若血统或成绩变动，凭据标记失效，下次读取时按当前档案重算。
import { descendantsOf } from "./pedigree.js";

// 计算某鸽只的血统+成绩快照。
export function computeSnapshot(db, ringNo) {
  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(p => p.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(p => p.ringNo === pigeon.motherRing) || null;
  return {
    owner: pigeon.owner || "",
    color: pigeon.color || "",
    loft: pigeon.loft || "",
    fatherRing: pigeon.fatherRing || "",
    motherRing: pigeon.motherRing || "",
    father: father ? { ringNo: father.ringNo, owner: father.owner || "", color: father.color || "" } : null,
    mother: mother ? { ringNo: mother.ringNo, owner: mother.owner || "", color: mother.color || "" } : null,
    vaccines: [...(pigeon.vaccines || [])],
    transfers: [...(pigeon.transfers || [])],
    races: [...(pigeon.races || [])],
  };
}

// 签发凭据：快照当前血统与成绩。
export function issueCredential(db, credState, ringNo) {
  const snapshot = computeSnapshot(db, ringNo);
  if (!snapshot) return null;
  const id = "cred-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();
  const credential = { id, ringNo, status: "valid", snapshot, issuedAt: now, updatedAt: now };
  credState.credentials.push(credential);
  return credential;
}

// 使指定鸽只（及其子代、孙代…）的已发凭据失效。
// 血统或成绩变动后调用；返回失效数量。
export function invalidateForPigeon(credState, db, ringNo) {
  const affected = new Set([ringNo, ...descendantsOf(db, ringNo)]);
  const now = new Date().toISOString();
  let count = 0;
  for (const c of credState.credentials) {
    if (c.status === "valid" && affected.has(c.ringNo)) {
      c.status = "invalid";
      c.updatedAt = now;
      count++;
    }
  }
  return count;
}

// 按当前档案重算凭据快照，恢复有效。
export function recalculateCredential(db, credState, id) {
  const c = credState.credentials.find(item => item.id === id);
  if (!c) return null;
  const snapshot = computeSnapshot(db, c.ringNo);
  if (!snapshot) return null;
  c.snapshot = snapshot;
  c.status = "valid";
  c.updatedAt = new Date().toISOString();
  return c;
}

// 读取凭据：若已失效则自动重算。
export function getCredential(db, credState, id) {
  const c = credState.credentials.find(item => item.id === id);
  if (!c) return null;
  if (c.status === "invalid") {
    const snapshot = computeSnapshot(db, c.ringNo);
    if (snapshot) {
      c.snapshot = snapshot;
      c.status = "valid";
      c.updatedAt = new Date().toISOString();
    }
  }
  return c;
}
