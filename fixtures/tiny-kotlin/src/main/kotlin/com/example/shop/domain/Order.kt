package com.example.shop.domain

import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table

@Entity
@Table(name = "orders")
class Order {
    @Id
    var id: Long? = null
    var reference: String? = null
}
