package com.example.legacy.service;

import com.example.legacy.domain.Report;

/**
 * No stereotype and no annotation of any kind: this bean is declared in
 * applicationContext.xml, which the extractor does not parse. It must appear
 * as a plain class with no injection facts, and the XML must produce a
 * diagnostic rather than being silently ignored.
 */
public class ReportDao {

    public Report load() {
        return new Report("daily");
    }
}
