package com.example.multi.billing;

import org.springframework.boot.autoconfigure.SpringBootApplication;

import com.example.multi.shared.Money;

@SpringBootApplication
public class BillingApplication {
    public Money invoice(long cents) {
        return new Money(cents);
    }
}
