package com.example;

import org.hibernate.annotations.Type;

import javax.persistence.Entity;
import javax.persistence.Id;
import java.util.UUID;

@Entity
public class ReceivedFile {

    @Id
    @Type(type = "uuid-char")
    UUID id;
}
