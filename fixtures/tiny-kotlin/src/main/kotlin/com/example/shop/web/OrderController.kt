package com.example.shop.web

import com.example.shop.domain.Order
import com.example.shop.service.OrderService
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RestController

@RestController
class OrderController(private val service: OrderService) {

    @GetMapping("/api/orders/{id}")
    fun byId(@PathVariable id: Long): Order? = service.find(id)
}
