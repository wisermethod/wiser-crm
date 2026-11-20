export interface NewSubmission {
  id: string;
  page: string;
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  phone: string;
  message: string;
}

const eraseVisitorFields = `first_name = NULL, last_name = NULL, email = NULL,
  company = NULL, phone = NULL, message = NULL, claim_id = NULL`;

export const completeSubmission = `
  UPDATE submissions SET taken_in_at = ?, contact_id = ?, ${eraseVisitorFields}
  WHERE id = ? AND claim_id = ? AND taken_in_at IS NULL
`;

const eraseAgedSubmissions = `
  UPDATE submissions SET ${eraseVisitorFields}
  WHERE julianday(received_at) < julianday(?)
    AND (first_name IS NOT NULL OR last_name IS NOT NULL OR email IS NOT NULL
      OR company IS NOT NULL OR phone IS NOT NULL OR message IS NOT NULL OR claim_id IS NOT NULL)
`;

const deleteEndedThrottleWindows = "DELETE FROM throttle WHERE window_ends_at <= ?";
const deleteEndedThrottleSalts = "DELETE FROM throttle_salts WHERE window_ends_at <= ?";

export const recordNoticeOutcome = "UPDATE submissions SET notice_outcome = ? WHERE id = ?";

export async function cleanIntake(db: D1Database, now: Date): Promise<void> {
  const nowMs = now.getTime();
  const cutoff = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.batch([
    db.prepare(eraseAgedSubmissions).bind(cutoff),
    db.prepare(deleteEndedThrottleWindows).bind(nowMs),
    db.prepare(deleteEndedThrottleSalts).bind(nowMs),
  ]);
}
