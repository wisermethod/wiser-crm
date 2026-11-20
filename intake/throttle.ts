import type { NewSubmission } from "./submissions.ts";

export interface ThrottleSettings {
  INTAKE_MAX_PER_ADDRESS_PER_DAY?: string;
  INTAKE_MAX_PER_HOUR?: string;
}

const hour = 60 * 60 * 1000;
const day = 24 * hour;
const allAddresses = "all";

const getOrCreateSalt = `
  INSERT INTO throttle_salts (window_ends_at, salt) VALUES (?, ?)
  ON CONFLICT (window_ends_at) DO UPDATE SET salt = throttle_salts.salt
  RETURNING salt
`;

const insertWithinLimits = `
  INSERT INTO submissions (id, received_at, page, first_name, last_name, email, company, phone, message)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM throttle
    WHERE (key = ? AND window_ends_at = ? AND count >= ?)
       OR (key = ? AND window_ends_at = ? AND count >= ?)
  )
`;

const countSavedSubmission = `
  INSERT INTO throttle (key, window_ends_at, count)
  SELECT bucket_key, window_end, 1
  FROM (SELECT ? AS bucket_key, ? AS window_end UNION ALL SELECT ?, ?)
  WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?)
  ON CONFLICT (key, window_ends_at) DO UPDATE SET count = throttle.count + 1
`;

function limit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function windowEnd(now: Date, length: number): number {
  return (Math.floor(now.getTime() / length) + 1) * length;
}

async function addressKey(db: D1Database, address: string | null, dayEnd: number): Promise<string> {
  const candidate = hex(crypto.getRandomValues(new Uint8Array(32)));
  const salt = await db.prepare(getOrCreateSalt).bind(dayEnd, candidate).first<string>("salt");
  if (!salt) throw new Error("Intake throttle salt unavailable.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${address ?? ""}`));
  return hex(new Uint8Array(digest));
}

export async function saveWithinThrottle(
  db: D1Database,
  settings: ThrottleSettings,
  submission: NewSubmission,
  received: Date,
  address: string | null,
): Promise<boolean> {
  const dayEnd = windowEnd(received, day);
  const hourEnd = windowEnd(received, hour);
  const key = await addressKey(db, address, dayEnd);
  const perAddress = limit(settings.INTAKE_MAX_PER_ADDRESS_PER_DAY, 5);
  const perHour = limit(settings.INTAKE_MAX_PER_HOUR, 60);
  const { id, page, firstName, lastName, email, company, phone, message } = submission;

  // One D1 transaction applies both limits and spends their slots only on a
  // saved lead. Concurrent posts see either both updated counters or neither.
  const [saved] = await db.batch([
    db.prepare(insertWithinLimits).bind(
      id, received.toISOString(), page, firstName, lastName, email, company, phone, message,
      key, dayEnd, perAddress, allAddresses, hourEnd, perHour,
    ),
    db.prepare(countSavedSubmission).bind(key, dayEnd, allAddresses, hourEnd, id),
  ]);
  return saved.meta.changes === 1;
}
