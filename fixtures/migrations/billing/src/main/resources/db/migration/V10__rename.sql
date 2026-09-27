/* Runs last: renames a table created in V1. */
ALTER TABLE line_item RENAME TO invoice_line;
ALTER TABLE invoice DROP COLUMN customer_ref;
