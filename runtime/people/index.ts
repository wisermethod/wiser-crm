export const roles = ["owner", "member", "viewer"] as const;
export type Role = typeof roles[number];
export type PeopleDatabase = Pick<D1Database, "prepare">;

interface Person {
  email: string;
  role: Role | null;
  added_by: string;
  added_at: string;
}

export function isRole(value: unknown): value is Role {
  return roles.some((role) => role === value);
}

export function plainEmail(value: unknown): string | null {
  return typeof value === "string" && /^[^@]+@[^@]+$/.test(value) && !/[\s\p{Cc}<>,;]/u.test(value)
    ? value.toLowerCase()
    : null;
}

export function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

export function mayWriteApp(role: Role | "agent"): boolean {
  return role !== "viewer";
}

export function mayWritePeople(role: Role | "agent"): boolean {
  return role === "owner";
}

export function findPerson(db: PeopleDatabase, email: string): Promise<Person | null> {
  return db.prepare("SELECT email, role, added_by, added_at FROM wiser_people WHERE email = ?")
    .bind(email).first<Person>();
}

export async function listPeople(db: PeopleDatabase): Promise<Person[]> {
  const { results } = await db.prepare(
    "SELECT email, role, added_by, added_at FROM wiser_people ORDER BY role IS NULL, email",
  ).all<Person>();
  return results;
}

export async function addWaitingPerson(db: PeopleDatabase, email: string): Promise<void> {
  await db.prepare("INSERT INTO wiser_people (email, added_by) VALUES (?, ?) ON CONFLICT(email) DO NOTHING")
    .bind(email, email).run();
}

export async function setPersonRole(db: PeopleDatabase, email: string, role: Role, addedBy: string): Promise<void> {
  await db.prepare(
    "INSERT INTO wiser_people (email, role, added_by) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET role = excluded.role",
  ).bind(email, role, addedBy).run();
}

export async function removePerson(db: PeopleDatabase, email: string): Promise<void> {
  await db.prepare("DELETE FROM wiser_people WHERE email = ?").bind(email).run();
}
