package com.example.shop.domain;

import java.util.List;
import java.util.Map;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToMany;
import jakarta.persistence.Table;

/** Expected mapping: class com.example.shop.domain.Order -> table `orders`. */
@Entity
@Table(name = "orders")
public class Order {

    @Id
    private Long id;

    @Column(name = "customer_ref")
    private String customerRef;

    /**
     * A direct association. The field's own type names the target, so the
     * relationship is readable without any type argument.
     */
    @ManyToOne
    private Customer customer;

    /**
     * A collection association. The fqn erases this to `java.util.List`, so
     * the target is readable only from the recorded type argument — this is
     * the case an ER diagram is useless without.
     */
    @OneToMany
    private List<OrderLine> lines;

    /**
     * Two type arguments, neither of them an entity. Both are recorded, and
     * neither may become a relationship.
     */
    private Map<String, String> attributes;

    public Long getId() {
        return id;
    }

    public String getCustomerRef() {
        return customerRef;
    }

    public Customer getCustomer() {
        return customer;
    }

    public List<OrderLine> getLines() {
        return lines;
    }

    public Map<String, String> getAttributes() {
        return attributes;
    }
}
