package com.example.clinic.repo;

import com.example.clinic.domain.Owner;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

public interface OwnerRepository extends JpaRepository<Owner, Long> {

    @Query("select o from Owner o join o.pets p where p.name = ?1")
    List<Owner> findByPetName(String name);

    @Modifying
    @Query(value = "update clinic.pets set petname = ?1", nativeQuery = true)
    int renameAllPets(String name);

    @Query("select v from Visit v")
    List<Object> allVisits();
}
