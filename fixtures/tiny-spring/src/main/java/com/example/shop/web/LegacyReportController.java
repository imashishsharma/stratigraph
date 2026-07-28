package com.example.shop.web;

// Wildcard import: the fully-qualified name of @RestController cannot be
// determined from source alone. The extractor must emit a diagnostic here and
// no stereotype or endpoint facts. It must not guess. See ADR-0005.
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/reports")
public class LegacyReportController {

    @GetMapping("/daily")
    public String daily() {
        return "not-implemented";
    }
}
