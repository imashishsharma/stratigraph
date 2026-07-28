package com.example.shop.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.example.shop.domain.Order;
import com.example.shop.service.OrderService;

/**
 * Every annotation here is resolvable from its import. Expected endpoints:
 *   GET  /api/orders/{id}
 *   POST /api/orders
 */
@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping("/{id}")
    public Order findOne(@PathVariable Long id) {
        return orderService.findOne(id);
    }

    @PostMapping
    public Order create(@RequestBody Order order) {
        return orderService.create(order);
    }
}
