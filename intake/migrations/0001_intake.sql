CREATE TABLE submissions (
  id TEXT PRIMARY KEY NOT NULL,
  received_at TEXT NOT NULL,
  page TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  company TEXT,
  phone TEXT,
  message TEXT,
  claimed_at TEXT,
  claim_id TEXT,
  taken_in_at TEXT,
  contact_id TEXT,
  notice_outcome TEXT
);

CREATE INDEX submissions_with_visitor_fields ON submissions(julianday(received_at))
WHERE first_name IS NOT NULL OR last_name IS NOT NULL OR email IS NOT NULL
   OR company IS NOT NULL OR phone IS NOT NULL OR message IS NOT NULL OR claim_id IS NOT NULL;

CREATE TABLE throttle (
  key TEXT NOT NULL,
  window_ends_at INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_ends_at)
);

CREATE INDEX throttle_window_end ON throttle(window_ends_at);

CREATE TABLE throttle_salts (
  window_ends_at INTEGER PRIMARY KEY,
  salt TEXT NOT NULL
);
