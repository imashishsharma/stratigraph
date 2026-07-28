package com.example.shop.repo;

import org.springframework.stereotype.Repository;

import com.example.shop.domain.Order;

/**
 * Deliberately a plain interface rather than one extending JpaRepository:
 * without the classpath, the supertype is an unresolved stub node, which is a
 * separate case worth its own fixture rather than being tangled up with
 * annotation resolution.
 */
@Repository
public interface OrderRepository {

    Order findById(Long id);

    Order save(Order order);
}
