package com.example.shop.service

import com.example.shop.domain.Order
import com.example.shop.repo.OrderRepository
import org.springframework.stereotype.Service

@Service
class OrderService(private val repository: OrderRepository) {
    fun find(id: Long): Order? = repository.findById(id)
}
