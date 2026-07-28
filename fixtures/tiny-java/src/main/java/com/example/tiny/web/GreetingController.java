package com.example.tiny.web;

import com.example.tiny.domain.Greeting;
import com.example.tiny.domain.GreetingService;

public class GreetingController {

    private final GreetingService service;

    public GreetingController(GreetingService service) {
        this.service = service;
    }

    public String greet(String name) {
        Greeting greeting = service.greet(name);
        return greeting.getText();
    }
}
