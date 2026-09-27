package com.example.split.util;

public final class Numbers {
    private Numbers() {
    }

    public static int parse(String text) {
        return Integer.parseInt(Strings.trim(text));
    }
}
