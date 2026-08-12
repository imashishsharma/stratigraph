package com.example.shop.web;

// The JHipster shape: one wildcard import of Spring's web annotations. Under
// ADR-0023 the annotations resolve — the known-annotation table places each
// name in the one wildcard-imported package, and no type of these names is
// declared anywhere in this source set — with provenance
// `resolution: "wildcard-import"`.
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/summaries")
public class DailySummaryController {

    @GetMapping("/today")
    public String today() {
        return "not-implemented";
    }
}
