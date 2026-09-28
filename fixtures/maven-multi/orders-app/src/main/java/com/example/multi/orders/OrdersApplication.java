package com.example.multi.orders;

import org.springframework.boot.autoconfigure.SpringBootApplication;

import com.example.multi.shared.Money;

@SpringBootApplication
public class OrdersApplication {
    public long total(Money money) {
        return money.cents();
    }

    public static void main(String[] args) {
    }
}
