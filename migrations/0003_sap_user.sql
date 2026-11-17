-- After final approval, Sales Account sends the form to an SAP user, who
-- creates the sales order in SAP and enters its number.
ALTER TABLE forms ADD COLUMN sap_user_id INTEGER REFERENCES users(id);
