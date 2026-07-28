package com.example.shop.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** Expected mapping: class com.example.shop.domain.Order -> table `orders`. */
@Entity
@Table(name = "orders")
public class Order {

    @Id
    private Long id;

    @Column(name = "customer_ref")
    private String customerRef;

    public Long getId() {
        return id;
    }

    public String getCustomerRef() {
        return customerRef;
    }
}
