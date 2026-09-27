package com.example.clinic.domain;

import jakarta.persistence.Entity;

/** Single-table inheritance by default: this class has no table of its own. */
@Entity
public class CardPayment extends Payment {

    private String cardLast4;
}
