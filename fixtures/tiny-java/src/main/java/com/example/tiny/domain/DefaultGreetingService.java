package com.example.tiny.domain;

import com.example.tiny.repo.GreetingRepository;

public class DefaultGreetingService implements GreetingService {

    private final GreetingRepository repository;

    public DefaultGreetingService(GreetingRepository repository) {
        this.repository = repository;
    }

    @Override
    public Greeting greet(String name) {
        String template = repository.findTemplate();
        return new Greeting(String.format(template, name));
    }
}
