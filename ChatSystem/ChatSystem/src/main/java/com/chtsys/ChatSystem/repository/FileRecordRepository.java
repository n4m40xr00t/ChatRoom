package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.FileRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface FileRecordRepository extends JpaRepository<FileRecord, Long> {
    Optional<FileRecord> findByStoredName(String storedName);
}
