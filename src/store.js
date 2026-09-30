// 档案存储层：正式血统档案 / 迁移检查点 / 参赛凭据分文件存储，原子写入。
// 迁移规则不在本层；本层只负责存取。
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

export function createStore(dataDir) {
  const paths = {
    archives: join(dataDir, "archives.json"),
    migration: join(dataDir, "migration.json"),
    credentials: join(dataDir, "credentials.json"),
    legacyDir: join(dataDir, "legacy"),
    seed: join(dataDir, "pigeons.json")
  };

  let db = null;

  async function readJson(path, fallback) {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, "utf8"));
  }

  async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, path);
  }

  // 首启：以并册前的 pigeons.json 为正式档案基线（旧快照文件保留不动）。
  async function init() {
    if (db) return db;
    if (!existsSync(paths.archives)) {
      const seed = await readJson(paths.seed, { pigeons: [] });
      const pigeons = seed.pigeons.map((pigeon, index) => ({
        ringNo: pigeon.ringNo,
        owner: pigeon.owner,
        fatherRing: pigeon.fatherRing || "",
        motherRing: pigeon.motherRing || "",
        color: pigeon.color,
        loft: pigeon.loft,
        version: 1,
        confirmedFields: index === 0 ? ["color"] : [], // 演示：001 的羽色已确认，迁移不得覆盖
        ringHistory: [],
        sources: ["正式档案"],
        mergeLog: [{ at: "2026-09-19", action: "baseline", source: "并册前正式档案" }],
        vaccines: pigeon.vaccines || [],
        transfers: pigeon.transfers || [],
        races: pigeon.races || []
      }));
      await writeJson(paths.archives, { pigeons });
    }
    const [archives, migration, credentials] = await Promise.all([
      readJson(paths.archives, { pigeons: [] }),
      readJson(paths.migration, { run: null }),
      readJson(paths.credentials, { credentials: [] })
    ]);
    db = {
      pigeons: archives.pigeons,
      run: migration.run,
      credentials: credentials.credentials || []
    };
    return db;
  }

  function metaOf(pigeon) {
    if (!Object.prototype.hasOwnProperty.call(pigeon, "_migrationMeta")) {
      Object.defineProperty(pigeon, "_migrationMeta", {
        value: { fieldSources: {} },
        enumerable: false,
        writable: true,
        configurable: true
      });
    }
    return pigeon._migrationMeta;
  }

  return {
    paths,
    init,
    listPigeons() {
      return db.pigeons;
    },
    getPigeon(ringNo) {
      return db.pigeons.find(item => item.ringNo === ringNo) || null;
    },
    createPigeon(data) {
      const pigeon = {
        vaccines: [], transfers: [], races: [],
        ringHistory: [], sources: [], confirmedFields: [], mergeLog: [],
        version: 1,
        ...data
      };
      db.pigeons.push(pigeon);
      return pigeon;
    },
    ensureMeta(pigeon, defaults) {
      const meta = metaOf(pigeon);
      Object.assign(meta, defaults);
      return meta;
    },
    bumpVersion(pigeon) {
      pigeon.version += 1;
      pigeon.mergeLog.push({ at: new Date().toISOString(), action: "edit" });
      return pigeon;
    },
    confirmField(ringNo, field) {
      const pigeon = this.getPigeon(ringNo);
      if (!pigeon) return null;
      if (!pigeon.confirmedFields.includes(field)) pigeon.confirmedFields.push(field);
      return pigeon;
    },
    getMigrationRun() {
      return db.run;
    },
    setMigrationRun(run) {
      db.run = run;
    },
    listCredentials() {
      return db.credentials;
    },
    saveCredential(credential) {
      db.credentials.push(credential);
      return credential;
    },
    replaceCredentials(list) {
      db.credentials = list;
    },
    async saveArchives() {
      await writeJson(paths.archives, { pigeons: db.pigeons });
    },
    async saveMigration() {
      await writeJson(paths.migration, { run: db.run });
    },
    async saveCredentials() {
      await writeJson(paths.credentials, { credentials: db.credentials });
    },
    // 迁移每行处理完都落检查点，失败后从检查点重试
    async checkpoint() {
      await Promise.all([writeJson(paths.archives, { pigeons: db.pigeons }), writeJson(paths.migration, { run: db.run })]);
    }
  };
}
