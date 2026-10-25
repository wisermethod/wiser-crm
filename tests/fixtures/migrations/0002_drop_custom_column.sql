-- Deliberately unsafe: the preservation test must name contacts.cf_test.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE contacts_rebuilt (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  title TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'lead',
  last_contacted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO contacts_rebuilt SELECT
  id, first_name, last_name, email, phone, company_id, title, status,
  last_contacted_at, created_at, updated_at FROM contacts;
DROP TABLE contacts;
ALTER TABLE contacts_rebuilt RENAME TO contacts;
PRAGMA defer_foreign_keys = OFF;
