package com.example.shop.web;

// Two wildcard imports: either package could supply @RestController. The
// second is a third-party package with no shipped listing, so nothing can say
// it does not (ADR-0023 condition 2, ADR-0038). The extractor must emit a
// diagnostic naming both packages and no stereotype or endpoint facts. It must
// not guess. See ADR-0005, ADR-0023.
import org.springframework.web.bind.annotation.*;
import com.acme.reporting.*;

@RestController
@RequestMapping("/api/reports")
public class LegacyReportController {

    @GetMapping("/daily")
    public String daily() {
        return "not-implemented";
    }
}
