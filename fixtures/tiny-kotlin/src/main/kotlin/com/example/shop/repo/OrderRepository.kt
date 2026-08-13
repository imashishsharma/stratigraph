package com.example.shop.repo

import com.example.shop.domain.Order
import org.springframework.stereotype.Repository

@Repository
class OrderRepository {
    fun findById(id: Long): Order? = null
}
