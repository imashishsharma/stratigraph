package com.example;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import org.openqa.selenium.WebDriver;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.htmlunit.webdriver.MockMvcHtmlUnitDriverBuilder;
import org.springframework.web.context.WebApplicationContext;

@SpringBootTest
class AppTest {

    @Autowired
    WebApplicationContext context;

    @Test
    void pageTitle() {
        WebDriver driver = MockMvcHtmlUnitDriverBuilder.webAppContextSetup(context).build();
        driver.get("http://localhost/");
        assertEquals("hello", driver.getTitle());
    }
}
