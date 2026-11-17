-- The final PDF (form + signatures + attachments) uploaded when the SO
-- number is entered, and whether the tray app has attached it in SAP.
ALTER TABLE files ADD COLUMN final INTEGER NOT NULL DEFAULT 0;
ALTER TABLE forms ADD COLUMN attach_status TEXT;      -- waiting, attached, failed
ALTER TABLE forms ADD COLUMN attach_message TEXT;
ALTER TABLE forms ADD COLUMN attached_at TEXT;
