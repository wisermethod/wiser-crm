import { cleanIntake, completeSubmission } from "../intake/submissions.ts";

export interface TakeInCounts {
  taken_in: number;
  failed: number;
  remaining: number;
}

interface Submission {
  id: string;
  claim_id: string;
  page: string;
  first_name: string;
  last_name: string;
  email: string;
  company: string;
  phone: string;
  message: string;
  notice_outcome: string | null;
}

const unclaimed = "(claim_id IS NULL OR claimed_at IS NULL OR julianday(claimed_at) < julianday(?))";
const pending = "taken_in_at IS NULL AND first_name IS NOT NULL";
// Give the post time to record its send result. The same ten-minute grace as
// a claim lets a saved lead progress even if the posting request died.
const noticeReady = "(notice_outcome IS NOT NULL OR julianday(received_at) < julianday(?))";
const submissionNote = `entity_type = 'contact' AND type = 'note'
  AND CASE WHEN json_valid(meta) THEN json_extract(meta, '$.intake_submission') END`;

async function findNote(db: D1Database, id: string): Promise<string | null> {
  return db.prepare(`SELECT entity_id FROM activities WHERE ${submissionNote} = ? LIMIT 1`)
    .bind(id).first<string>("entity_id");
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

// The import route uses SQLite lower(trim(email)) to load candidates and JS
// trim().toLowerCase() on both fields to pick the most recently updated match.
// Compare the observed raw pairs inside the write transaction so Unicode names
// retain JS semantics. An unobserved variant makes the batch a no-op, leaving
// the submission eligible after the claim expires. Identical new rows can be
// matched immediately, including when two submissions are processed together.
const contactMatch = `
  WITH observed(email, name, matches) AS (
    SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
    FROM json_each(?1)
  ), candidates AS (
    SELECT c.id, c.updated_at, c.rowid, o.matches, c.email = ?3 AND c.first_name = ?4 AS exact
    FROM contacts c LEFT JOIN observed o ON o.email = c.email AND o.name = c.first_name
    WHERE lower(trim(c.email)) = ?2
  ), chosen AS (
    SELECT id FROM candidates WHERE matches = 1 OR exact
    ORDER BY updated_at DESC, rowid DESC LIMIT 1
  )
`;
const observedCandidates = "NOT EXISTS (SELECT 1 FROM candidates WHERE matches IS NULL AND NOT exact)";

async function writeNote(db: D1Database, submission: Submission): Promise<void> {
  const { id, first_name, last_name, email, phone, message, company, page } = submission;
  const emailKey = normalize(email);
  const nameKey = normalize(first_name);
  const candidates = await db.prepare(`
    SELECT DISTINCT email, first_name FROM contacts WHERE lower(trim(email)) = ?
  `).bind(emailKey).all<{ email: string; first_name: string }>();
  const observed = candidates.results.map((row) => [
    row.email, row.first_name, normalize(row.email) === emailKey && normalize(row.first_name) === nameKey,
  ]);
  const contactId = crypto.randomUUID();
  const matchInputs = [JSON.stringify(observed), emailKey, email, first_name, contactId];
  const failureCode = submission.notice_outcome?.startsWith("failed:") ? submission.notice_outcome.slice(7) : null;
  const noticeLine = failureCode === null ? "" : `\nEmail notice was not sent (${failureCode}).`;
  const body = `${message}\n\nCompany: ${company}\nPhone: ${phone}\nPage: ${page}${noticeLine}`;
  await db.batch([
    db.prepare(`${contactMatch}
      INSERT INTO contacts (id, first_name, last_name, email, phone, company_id, title, status)
      SELECT ?5, ?4, ?6, ?3, ?7, NULL, '', 'lead'
      WHERE NOT EXISTS (SELECT 1 FROM chosen)
        AND ${observedCandidates}
        AND NOT EXISTS (SELECT 1 FROM activities WHERE ${submissionNote} = ?8)
    `).bind(...matchInputs, last_name, phone, id),
    db.prepare(`${contactMatch}
      INSERT INTO activities (id, entity_type, entity_id, type, body, meta)
      SELECT ?6, 'contact', selected.id, 'note', ?7, ?8
      FROM contacts selected
      WHERE selected.id = COALESCE((SELECT id FROM chosen), ?5)
        AND ${observedCandidates}
        AND NOT EXISTS (SELECT 1 FROM activities WHERE ${submissionNote} = ?9)
    `).bind(...matchInputs, crypto.randomUUID(), body, JSON.stringify({ intake_submission: id }), id),
  ]);
}

export async function takeIn(
  crm: D1Database,
  intake: D1Database,
  clock: () => Date = () => new Date(),
): Promise<TakeInCounts> {
  const now = clock();
  const timestamp = now.toISOString();
  const staleBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  await cleanIntake(intake, now);
  const queue = await intake.prepare(`
    SELECT id FROM submissions WHERE ${pending} AND ${unclaimed} AND ${noticeReady}
    ORDER BY julianday(received_at), id LIMIT 50
  `).bind(staleBefore, staleBefore).all<{ id: string }>();
  const counts = { taken_in: 0, failed: 0, remaining: 0 };
  for (const { id } of queue.results) {
    try {
      const claimId = crypto.randomUUID();
      const claim = await intake.prepare(`
        UPDATE submissions SET claimed_at = ?, claim_id = ?
        WHERE id = ? AND ${pending} AND ${unclaimed} AND ${noticeReady}
        RETURNING id, claim_id, page, first_name, last_name, email, company, phone, message, notice_outcome
      `).bind(timestamp, claimId, id, staleBefore, staleBefore).all<Submission>();
      const submission = claim.results[0];
      if (claim.meta.changes !== 1 || submission?.claim_id !== claimId) continue;

      let contactId = await findNote(crm, id);
      if (!contactId) {
        await writeNote(crm, submission);
        contactId = await findNote(crm, id);
      }
      if (!contactId) {
        counts.failed++;
        continue;
      }

      const receipt = await intake.prepare(completeSubmission).bind(timestamp, contactId, id, claimId).run();
      if (receipt.meta.changes === 1) counts.taken_in++;
      else counts.failed++;
    } catch {
      counts.failed++;
    }
  }
  counts.remaining = await intake.prepare(`SELECT count(*) AS count FROM submissions WHERE ${pending}`)
    .first<number>("count") ?? 0;
  return counts;
}
