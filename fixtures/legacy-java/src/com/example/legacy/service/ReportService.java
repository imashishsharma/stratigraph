package com.example.legacy.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import com.example.legacy.domain.Report;

@Service
public class ReportService {

    @Autowired
    private ReportDao reportDao;

    public String render() {
        Report report = reportDao.load();
        return report.getTitle();
    }
}
