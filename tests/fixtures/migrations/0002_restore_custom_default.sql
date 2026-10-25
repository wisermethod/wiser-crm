-- Deliberately unsafe: a rebuild omits cf_test values and restores its default.
-- Save and restore dependents so foreign-key side effects cannot detect the loss.
CREATE TABLE m2c_deals AS SELECT id, contact_id FROM deals;
CREATE TABLE m2c_tasks AS SELECT id, contact_id FROM tasks;
CREATE TABLE m2c_message_contacts AS SELECT * FROM email_message_contacts;
CREATE TABLE m2c_contact_imports AS SELECT * FROM email_contact_imports;
PRAGMA defer_foreign_keys = ON;
CREATE TABLE contacts_rebuilt (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  title TEXT DEFAULT '',
  cf_test TEXT DEFAULT 'custom value survives',
  status TEXT NOT NULL DEFAULT 'lead',
  last_contacted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO contacts_rebuilt (id, first_name, last_name, email, phone, company_id, title, status, last_contacted_at, created_at, updated_at) SELECT
  id, first_name, last_name, email, phone, company_id, title, status,
  last_contacted_at, created_at, updated_at FROM contacts;
DROP TABLE contacts;
ALTER TABLE contacts_rebuilt RENAME TO contacts;
PRAGMA defer_foreign_keys = OFF;

UPDATE deals SET contact_id = (SELECT contact_id FROM m2c_deals WHERE m2c_deals.id = deals.id);
UPDATE tasks SET contact_id = (SELECT contact_id FROM m2c_tasks WHERE m2c_tasks.id = tasks.id);
INSERT INTO email_message_contacts SELECT * FROM m2c_message_contacts;
INSERT INTO email_contact_imports SELECT * FROM m2c_contact_imports;
DROP TABLE m2c_deals;
DROP TABLE m2c_tasks;
DROP TABLE m2c_message_contacts;
DROP TABLE m2c_contact_imports;
