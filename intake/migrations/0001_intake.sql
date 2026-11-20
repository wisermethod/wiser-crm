CREATE TABLE submissions (
  id TEXT PRIMARY KEY NOT NULL,
  received_at TEXT NOT NULL,
  page TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL,
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  claimed_at TEXT,
  claim_id TEXT,
  taken_in_at TEXT,
  contact_id TEXT
);
