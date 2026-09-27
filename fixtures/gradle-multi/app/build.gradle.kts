// A Boot application proved by its own plugins block, with no main class.
plugins {
    java
    id("org.springframework.boot")
}

dependencies {
    implementation(project(":lib"))
}
