-- The chain used when no rule fits, editable on the Rules page.
INSERT OR IGNORE INTO settings (key, value)
VALUES ('default_chain', '["supervisor","hod","sales_account","cfo","ceo"]');
