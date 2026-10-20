package com.example;

import org.hibernate.annotations.Type;

import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import java.util.UUID;
import org.hibernate.type.YesNoConverter;

@Entity
public class Other {

    @Id
    @Type(uuid-binary.class)
    UUID id;

    @Type(text.class)
    String body;

    @Convert(converter = YesNoConverter.class)
    Boolean flag;
}
