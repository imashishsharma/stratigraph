package com.example.legacy.web;

import javax.annotation.Resource;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;

import com.example.legacy.service.ReportService;

/**
 * Spring MVC as it was written before Boot: @Controller rather than
 * @RestController, the general @RequestMapping form with an explicit method
 * rather than @GetMapping, and field injection rather than a constructor.
 *
 * Expected endpoints:
 *   GET  /reports/daily
 *   POST /reports/daily
 */
@Controller
@RequestMapping("/reports")
public class ReportController {

    @Resource
    private ReportService reportService;

    @RequestMapping(value = "/daily", method = {RequestMethod.GET, RequestMethod.POST})
    public String daily() {
        return reportService.render();
    }

    /** No method element at all, which in Spring MVC maps every verb. */
    @RequestMapping("/index")
    public String index() {
        return "index";
    }
}
