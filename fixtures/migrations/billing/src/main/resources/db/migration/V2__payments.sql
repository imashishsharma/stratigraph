CREATE TABLE payment (
    id BIGINT PRIMARY KEY,
    invoice_id BIGINT REFERENCES invoice(id),
    paid_at TIMESTAMP
);
ALTER TABLE invoice ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'OPEN';
