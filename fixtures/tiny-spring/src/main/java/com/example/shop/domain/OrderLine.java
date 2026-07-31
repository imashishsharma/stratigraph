package com.example.shop.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** Expected mapping: class com.example.shop.domain.OrderLine -> table `order_lines`. */
@Entity
@Table(name = "order_lines")
public class OrderLine {

    @Id
    private Long id;

    private int quantity;

    public Long getId() {
        return id;
    }

    public int getQuantity() {
        return quantity;
    }
}
