package com.example.shop.service;

import org.springframework.stereotype.Service;

import com.example.shop.domain.Order;
import com.example.shop.repo.OrderRepository;

@Service
public class OrderService {

    private final OrderRepository orderRepository;

    public OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    public Order findOne(Long id) {
        return orderRepository.findById(id);
    }

    public Order create(Order order) {
        return orderRepository.save(order);
    }
}
