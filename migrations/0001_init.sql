CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  default_currency TEXT NOT NULL DEFAULT 'IDR' CHECK (default_currency IN ('IDR', 'USD', 'EUR')),
  preferred_language TEXT NOT NULL DEFAULT 'id' CHECK (preferred_language IN ('id', 'en')),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  hits INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency IN ('IDR', 'USD', 'EUR')),
  category TEXT NOT NULL,
  date TEXT NOT NULL CHECK (date GLOB '????-??-??'),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (type = 'income' AND category IN ('Gaji', 'Lainnya', 'Salary', 'Other')) OR
    (type = 'expense' AND category IN ('Makan', 'Transportasi', 'Tagihan', 'Hiburan', 'Belanja', 'Kesehatan', 'Pendidikan', 'Lainnya', 'Food', 'Transport', 'Bills', 'Entertainment', 'Shopping', 'Health', 'Education', 'Other'))
  )
);
CREATE INDEX transactions_user_date_idx ON transactions(user_id, date DESC, id DESC);
CREATE INDEX transactions_user_category_date_idx ON transactions(user_id, category, date DESC);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (month GLOB '????-??'),
  category TEXT NOT NULL CHECK (category IN ('Makan', 'Transportasi', 'Tagihan', 'Hiburan', 'Belanja', 'Kesehatan', 'Pendidikan', 'Lainnya', 'Food', 'Transport', 'Bills', 'Entertainment', 'Shopping', 'Health', 'Education', 'Other')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency IN ('IDR', 'USD', 'EUR')),
  UNIQUE(user_id, month, category)
);
CREATE INDEX budgets_user_month_idx ON budgets(user_id, month);
PRAGMA user_version = 1;
