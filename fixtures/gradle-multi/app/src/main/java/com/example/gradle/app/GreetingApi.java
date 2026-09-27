package com.example.gradle.app;

import com.example.gradle.lib.Text;

public class GreetingApi {
    public String greet(String name) {
        return Text.shout("hello " + name);
    }
}
