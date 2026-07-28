package com.example.legacy.domain;

import javax.persistence.Column;
import javax.persistence.Entity;
import javax.persistence.Id;
import javax.persistence.Table;

/**
 * The javax namespace, not jakarta. Expected mapping:
 * com.example.legacy.domain.Report -> table `report_run`.
 */
@Entity
@Table(name = "report_run")
public class Report {

    @Id
    private Long id;

    @Column(name = "report_title")
    private String title;

    public Report(String title) {
        this.title = title;
    }

    public Long getId() {
        return id;
    }

    public String getTitle() {
        return title;
    }
}
