package com.example.clinic.domain;

/** Not a mapped superclass: its field must not become a column. */
public abstract class Auditable extends BaseEntity {

    private String auditNote;
}
