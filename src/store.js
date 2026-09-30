// 档案存储层：只负责 JSON 档案的读写，不含迁移规则与页面逻辑。
// 所有写入走临时文件 + rename，避免写一半失败留下损坏档案。
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

export function createStore({ dataDir, seed }) {
  const paths = {
    pigeons: join(dataDir, "pigeons.json"),
    migrations: join(dataDir, "migrations.json"),
    credentials: join(dataDir, "credentials.json"),
  };

  return {
    paths,

    async loadPigeons() {
      if (!existsSync(paths.pigeons)) {
        await writeJsonAtomic(paths.pigeons, seed);
        return JSON.parse(JSON.stringify(seed));
      }
      return readJson(paths.pigeons, { pigeons: [] });
    },

    async savePigeons(db) {
      await writeJsonAtomic(paths.pigeons, db);
    },

    async loadMigrations() {
      return readJson(paths.migrations, { migrations: [] });
    },

    async saveMigrations(state) {
      await writeJsonAtomic(paths.migrations, state);
    },

    async loadCredentials() {
      return readJson(paths.credentials, { credentials: [] });
    },

    async saveCredentials(state) {
      await writeJsonAtomic(paths.credentials, state);
    },
  };
}
