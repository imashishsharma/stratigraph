package com.example.shop.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** Expected mapping: class com.example.shop.domain.Customer -> table `customers`. */
@Entity
@Table(name = "customers")
public class Customer {

    @Id
    private Long id;

    @Column(name = "display_name")
    private String displayName;

    public Long getId() {
        return id;
    }

    public String getDisplayName() {
        return displayName;
    }
}
