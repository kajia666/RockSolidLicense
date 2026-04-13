import { createSqliteMainStore } from "./sqlite-main-store.js";

export function createMainStore({ db, config }) {
  void config;
  return createSqliteMainStore({ db });
}
