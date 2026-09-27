-- Flyway applies these by version, not by name: V10 runs after V2.
CREATE TABLE invoice (
    id BIGINT NOT NULL PRIMARY KEY,
    amount_cents BIGINT NOT NULL,
    customer_ref VARCHAR(64)
);

CREATE TABLE line_item (
    id BIGINT NOT NULL,
    invoice_id BIGINT NOT NULL,
    description TEXT,
    PRIMARY KEY (id),
    CONSTRAINT fk_line_invoice FOREIGN KEY (invoice_id) REFERENCES invoice (id)
);
