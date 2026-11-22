CREATE TABLE wiser_people (
  email TEXT PRIMARY KEY NOT NULL CHECK (email = lower(email)),
  role TEXT CHECK (role IN ('owner', 'member', 'viewer')),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

UPDATE deals SET company_id = (SELECT company_id FROM contacts WHERE contacts.id = deals.contact_id)
 WHERE company_id IS NULL AND contact_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM data_backfills WHERE key = 'deals.company_id');

INSERT OR IGNORE INTO data_backfills (key) VALUES ('deals.company_id');

UPDATE companies SET customer_since = min((
    SELECT MIN(CASE WHEN d.close_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN d.close_date ELSE date(d.updated_at) END)
      FROM deals d JOIN stages s ON s.key = d.stage AND s.is_won = 1
     WHERE d.company_id = companies.id), date('now'))
 WHERE (customer_since IS NULL OR TRIM(customer_since) = '')
   AND EXISTS (SELECT 1 FROM deals d JOIN stages s ON s.key = d.stage AND s.is_won = 1 WHERE d.company_id = companies.id)
   AND NOT EXISTS (SELECT 1 FROM data_backfills WHERE key = 'companies.customer_since');

INSERT OR IGNORE INTO data_backfills (key) VALUES ('companies.customer_since');
