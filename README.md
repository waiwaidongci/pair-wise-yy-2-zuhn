# 赛鸽血统环号登记站

两家鸽棚并册：旧系统记录迁移归并为正式血统档案，同一足环仅保留一份；资料不同或家谱成环先列冲突、不覆盖已确认记录；迁移支持检查点续跑；疫苗/成绩重复提交幂等；并册后改动血统或成绩时已发参赛凭据自动失效并重算补发。

## 运行

```bash
npm start        # http://localhost:3024
npm test         # 迁移规则与凭据的自动化测试（node:test）
```

## 三层分离

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 迁移规则 | `src/migration.js` | 纯逻辑、不碰文件：换环并查集归组、字段冲突、家谱成环检测、逐行检查点摄入、冲突裁定、疫苗/转让/成绩去重键 |
| 档案存储 | `src/store.js`、`src/credentials.js` | `data/archives.json`（正式档案）、`data/migration.json`（迁移任务与检查点）、`data/credentials.json`（参赛凭据）分文件原子写入 |
| 页面入口 | `server.js`、`public/` | 只做路由和编排；三个独立页面：`/` 正式档案、`/migration` 迁移并册、`/credentials` 参赛凭据 |

`data/pigeons.json` 是并册前旧快照（只读基线，首启据此生成正式档案）；`data/legacy/north.json`、`data/legacy/south.json` 是两家旧系统导出。

## 迁移与并册规则

- **同一足环一份档案**：旧记录按足环归并；换过环的鸽子用 `previousRing` 关联，并查集把新旧环号归到同一羽，旧环号记入 `ringHistory`，不另建档案。
- **补充归并**：父母、疫苗、转让、归巢成绩按内容合并；疫苗按“日期+名称”、成绩按“日期+赛事+距离”、转让按“日期+出让+受让”判重，重复提交不新增。
- **先冲突后覆盖**：鸽主、羽色、棚号、父、母等标量字段两边不一致时登记冲突（保留现值、列出候选与来源），由人工在迁移页裁定。
- **已确认不覆盖**：档案 `confirmedFields` 中的字段迁移一律不覆盖，冲突标记为 blocker，必须人工裁定（种子数据中 CHN-2026-001 的羽色为已确认）。
- **家谱成环**：沿父/母边检测回到自身的环，登记 blocker 冲突并列出构成环的每条边；人工选择切断一条边后才完成，不删档案。
- **检查点**：每摄入一条旧记录即落盘（processedIds + checkpoint）。中途失败后 `POST /api/migration/retry` 从检查点续跑，已处理记录与已追加集合不会重复；迁移页默认在 CHN-2025-331 处注入一次瞬时故障用于演练。

## 参赛凭据

- 凭据按“血统指纹（足环+父母）”和“成绩指纹（成绩去重键集合）”绑定签发；同指纹重复签发沿用原凭据，不新发。
- 修改父母边或归巢成绩后，该羽所有有效凭据标记 `invalid`（记录失效原因）并按赛事补发新凭据（`supersedes` 指回旧凭据）。
- 疫苗、转让不触发凭据重算。

## 主要 API

- `GET/POST /api/pigeons`、`GET /api/pigeons/:ring/relation`
- `PUT /api/pigeons/:ring/pedigree`（拒绝制造成环；触发凭据重算）
- `POST /api/pigeons/:ring/{vaccines,transfers,races}`（返回 `added/duplicate`）
- `POST /api/migration/start`、`POST /api/migration/retry`、`GET /api/migration`
- `POST /api/migration/conflicts/:id/resolve`
- `POST /api/credentials`、`GET /api/credentials`
