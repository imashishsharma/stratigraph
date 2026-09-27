package com.example.clinic.domain;

import jakarta.persistence.Entity;

@Entity
public class Payment extends BaseEntity {

    private long amountCents;
}
