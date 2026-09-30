// 参赛凭据：以“血统指纹 + 成绩指纹”绑定。
// 并册后改动血统（父母边）或归巢成绩后，已发凭据立即失效并重算补发；
// 疫苗、转让不影响参赛凭据。
import { createHash, randomUUID } from "node:crypto";
import { raceKey } from "./migration.js";

export function pedigreeFingerprint(pigeon) {
  const payload = {
    ringNo: pigeon.ringNo,
    fatherRing: pigeon.fatherRing || "",
    motherRing: pigeon.motherRing || ""
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export function raceFingerprint(pigeon) {
  const keys = (pigeon.races || []).map(raceKey).sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16);
}

function findValid(store, ringNo, event) {
  return store.listCredentials().find(
    item => item.ringNo === ringNo && item.event === event && item.status === "valid"
  );
}

// 签发（幂等）：同一羽同赛事且指纹未变时，重复提交返回原凭据，不新发。
export function issueCredential(store, ringNo, event) {
  const pigeon = store.getPigeon(ringNo);
  if (!pigeon) throw new Error("pigeon_not_found");
  const pedigreeFp = pedigreeFingerprint(pigeon);
  const raceFp = raceFingerprint(pigeon);
  const existing = findValid(store, ringNo, event);
  if (existing && existing.pedigreeFingerprint === pedigreeFp && existing.raceFingerprint === raceFp) {
    return { credential: existing, reused: true };
  }
  const credential = {
    id: randomUUID(),
    ringNo,
    event,
    issuedAt: new Date().toISOString(),
    pedigreeFingerprint: pedigreeFp,
    raceFingerprint: raceFp,
    version: pigeon.version,
    status: "valid"
  };
  store.saveCredential(credential);
  return { credential, reused: false };
}

// 失效重算：血统或成绩发生变化后调用。旧凭据标记 invalid，按其赛事补发新凭据。
export function recalcAfterMutation(store, ringNo, reason) {
  const pigeon = store.getPigeon(ringNo);
  if (!pigeon) return { invalidated: [], reissued: [] };
  const pedigreeFp = pedigreeFingerprint(pigeon);
  const raceFp = raceFingerprint(pigeon);
  const affected = store.listCredentials().filter(item => item.ringNo === ringNo && item.status === "valid");
  const result = { invalidated: [], reissued: [], reason };

  for (const old of affected) {
    if (old.pedigreeFingerprint === pedigreeFp && old.raceFingerprint === raceFp) continue;
    old.status = "invalid";
    old.invalidReason = reason;
    old.invalidatedAt = new Date().toISOString();
    result.invalidated.push(old);

    const fresh = {
      id: randomUUID(),
      ringNo,
      event: old.event,
      issuedAt: new Date().toISOString(),
      pedigreeFingerprint: pedigreeFp,
      raceFingerprint: raceFp,
      version: pigeon.version,
      status: "valid",
      supersedes: old.id
    };
    store.saveCredential(fresh);
    result.reissued.push(fresh);
  }
  return result;
}
