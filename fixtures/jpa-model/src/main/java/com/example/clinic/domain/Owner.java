package com.example.clinic.domain;

import jakarta.persistence.Embedded;
import jakarta.persistence.Entity;
import jakarta.persistence.OneToMany;
import jakarta.persistence.Transient;
import java.util.List;

@Entity
public class Owner extends BaseEntity {

    private String firstName;

    private transient String scratch;

    @Transient
    private String displayName;

    @Embedded
    private Address address;

    @OneToMany(mappedBy = "owner")
    private List<Pet> pets;
}
