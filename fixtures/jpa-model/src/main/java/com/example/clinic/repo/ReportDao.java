package com.example.clinic.repo;

import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class ReportDao {

    private final JdbcTemplate jdbc;

    public ReportDao(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<Map<String, Object>> ownersWithPets() {
        return jdbc.queryForList("SELECT o.first_name FROM owner o JOIN clinic.pets p ON p.owner_id = o.id");
    }

    public void logVisit(long id) {
        jdbc.update("INSERT INTO visit_log (visit_id) VALUES (?)", id);
    }
}
