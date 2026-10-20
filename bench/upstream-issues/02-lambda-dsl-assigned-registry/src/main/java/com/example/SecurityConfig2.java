package com.example;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.ExpressionUrlAuthorizationConfigurer;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SecurityConfig2 {

    @Bean
    SecurityFilterChain filterChain2(HttpSecurity http) throws Exception {
        ExpressionUrlAuthorizationConfigurer<HttpSecurity>.ExpressionInterceptUrlRegistry registry =
                http.authorizeRequests()
                        .antMatchers("/public/**").permitAll()
                        .anyRequest().authenticated();
        registry.and().csrf().disable();
        return http.build();
    }
}
