/// <reference path="./async-context.d.ts" />
import { AsyncLocalStorage } from "node:async_hooks";

const databases = new AsyncLocalStorage<D1Database>();

export function initDB<T>(database: D1Database, work: () => T): T {
  return databases.run(database, work);
}

function statement(sql: string, params: unknown[]): D1PreparedStatement {
  const database = databases.getStore();
  if (!database) throw new Error("Database is not initialized for this request.");
  const prepared = database.prepare(sql);
  return params.length ? prepared.bind(...params) : prepared;
}

// The app's own call sites set these types: an untyped call's rows flow into
// typed response schemas, so the default is any, and lookups are read as
// `(await get(...)) ?? null` or returned as `Promise<Row | undefined>`, so a
// missing row is undefined.
export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await statement(sql, params).all<T>();
  if (!result.success) throw new Error(result.error || "Database query failed.");
  return result.results;
}

export async function get<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await statement(sql, params).first<T>()) ?? undefined;
}

export async function run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
  const result = await statement(sql, params).run();
  if (!result.success) throw new Error(result.error || "Database write failed.");
  return { changes: result.meta.changes };
}
