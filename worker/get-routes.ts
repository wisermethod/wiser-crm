/** Audited against src/server/index.ts at fork 65cf4c2. Templates use OpenAPI's
 *  {parameter} form. The live OpenAPI test requires every GET, including plain
 *  Hono and runtime discovery/widget routes, to appear exactly once here.
 *  Re-audit the handler and its helpers when upstream changes a known route. */
export const readGetRoutes: readonly string[] = [
  "/api/activities",
  "/api/ai-columns",
  "/api/companies",
  "/api/companies/aggregates",
  "/api/companies/{id}",
  "/api/contacts",
  "/api/contacts/aggregates",
  "/api/contacts/{id}",
  "/api/custom-fields",
  "/api/email-sync/labels", // Already unavailable under the platform policy.
  "/api/emails/{mailbox}/{id}",
  "/api/insights",
  "/api/integrations/status",
  "/api/meetings",
  "/api/meetings/{id}",
  "/api/openapi.json",
  "/api/records",
  "/api/tasks",
  "/api/values",
  "/api/views/{id}/fields",
  "/api/widgets",
  "/llms.txt",
];

// Each entry names both the GET handler and an actual upstream write, including
// conditional first-use writes. Block the whole route even after a backfill or
// seed has run: isolate flags and current database contents are not a guarantee.
export const writingGetRoutes: Readonly<Record<string, string>> = {
  "/api/stats": "src/server/index.ts:572 backfillCustomers -> :1622 UPDATE companies, :1629 INSERT data_backfills (also :1585 UPDATE deals, :1588 marker)",
  "/api/stages": "src/server/index.ts:1378 listStagesRows -> :1342 INSERT OR IGNORE stages",
  "/api/deals": "src/server/index.ts:1742 backfillDealCompanies -> :1585 UPDATE deals, :1588 INSERT data_backfills",
  "/api/deals/board": "src/server/index.ts:1652 backfillDealCompanies -> :1585 UPDATE deals, :1588 INSERT data_backfills; :1657 progressOf -> :1342 INSERT stages",
  "/api/deals/progress": "src/server/index.ts:1693 backfillDealCompanies -> :1585 UPDATE deals, :1588 INSERT data_backfills; :1695 progressOf -> :1342 INSERT stages",
  "/api/deals/{id}": "src/server/index.ts:3761 backfillDealCompanies -> :1585 UPDATE deals, :1588 INSERT data_backfills; :3764 progressOf -> :1342 INSERT stages",
  "/api/customers": "src/server/index.ts:3175 backfillCustomers -> :1622 UPDATE companies, :1629 INSERT data_backfills (also :1585 UPDATE deals, :1588 marker)",
  "/api/lookup": "src/server/index.ts:3223 ensureStagesSeeded -> :1342 INSERT stages; :3224 backfillDealCompanies -> :1585 UPDATE deals, :1588 marker; :3225 backfillCustomers -> :1622 UPDATE companies, :1629 marker",
  "/api/email-sync": "src/server/index.ts:2277 ensureScheduled -> src/server/email-sync.ts:538 enqueueJob, :545 UPDATE email_accounts",
  "/api/contacts/{id}/emails": "src/server/index.ts:2461 importContactIfNeeded -> src/server/email-sync.ts:676 storeAndLink, :677 recomputeLastContacted, :679 INSERT/UPDATE email_contact_imports",
  "/api/meetings/sync": "src/server/index.ts:2513 ensureMeetingsScheduled -> src/server/meetings.ts:603 enqueueJob, :610 UPDATE meeting_sync",
  "/api/views": "src/server/index.ts:3943 ensureDefaultView -> :3934 INSERT OR IGNORE views",
};

export function isWritingGet(path: string): boolean {
  const segments = path.split("/");
  return Object.keys(writingGetRoutes).some(template => {
    const parts = template.split("/");
    return parts.length === segments.length && parts.every((part, i) =>
      part.startsWith("{") && part.endsWith("}") ? segments[i].length > 0 : part === segments[i]);
  });
}
