// 血统图谱辅助：纯函数。
// 子代/孙代遍历等，供凭据失效范围与血统查询使用。

// 返回 ringNo 的所有子代（children、grandchildren…），不含自身。
export function descendantsOf(db, ringNo) {
  const result = new Set();
  const queue = [ringNo];
  while (queue.length) {
    const cur = queue.shift();
    for (const p of db.pigeons || []) {
      if (!p || !p.ringNo) continue;
      if ((p.fatherRing === cur || p.motherRing === cur) && !result.has(p.ringNo)) {
        result.add(p.ringNo);
        queue.push(p.ringNo);
      }
    }
  }
  return [...result];
}

// 返回 ringNo 的祖先（父母、祖父母…），不含自身。
export function ancestorsOf(db, ringNo) {
  const byRing = new Map((db.pigeons || []).map(p => [p.ringNo, p]));
  const result = new Set();
  const queue = [ringNo];
  while (queue.length) {
    const cur = queue.shift();
    const p = byRing.get(cur);
    if (!p) continue;
    for (const parent of [p.fatherRing, p.motherRing]) {
      if (parent && !result.has(parent)) {
        result.add(parent);
        queue.push(parent);
      }
    }
  }
  return [...result];
}
