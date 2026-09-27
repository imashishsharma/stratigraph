package com.example.clinic.domain;

import jakarta.persistence.Entity;

@Entity(name = "Visit")
public class VisitRecord extends Auditable {

    private String description;
}
