package com.example.gradle.lib;

public final class Text {
    private Text() {
    }

    public static String shout(String text) {
        return text.toUpperCase();
    }
}
