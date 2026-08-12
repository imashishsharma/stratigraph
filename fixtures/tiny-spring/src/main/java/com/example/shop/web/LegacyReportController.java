package com.example.shop.web;

// Two wildcard imports: either package could supply @RestController, and the
// known-annotation table cannot say the second one does not (ADR-0023
// condition 2). The extractor must emit a diagnostic naming both packages and
// no stereotype or endpoint facts. It must not guess. See ADR-0005, ADR-0023.
import org.springframework.web.bind.annotation.*;
import com.example.shop.domain.*;

@RestController
@RequestMapping("/api/reports")
public class LegacyReportController {

    @GetMapping("/daily")
    public String daily() {
        return "not-implemented";
    }
}
