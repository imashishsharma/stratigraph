package com.example.clinic.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

@Entity
@Table(name = "pets", schema = "clinic")
public class Pet extends BaseEntity {

    @Column(name = "petName")
    private String name;

    @ManyToOne
    private Owner owner;
}
