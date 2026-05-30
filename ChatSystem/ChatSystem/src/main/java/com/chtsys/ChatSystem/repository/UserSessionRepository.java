package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.UserEntity;
import com.chtsys.ChatSystem.Model.UserSession;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import org.springframework.transaction.annotation.Transactional;

@Repository
public interface UserSessionRepository extends JpaRepository<UserSession, Long> {
    Optional<UserSession> findBySessionId(String sessionId);
    List<UserSession> findByUserAndIsActiveTrue(UserEntity user);

    @Transactional
    void deleteByUser(UserEntity user);

    /**
     * Atomically checks that the session is still active and updates lastActive.
     * Returns the number of rows updated (1 if active, 0 if already revoked).
     */
    @Modifying
    @Transactional
    @Query("UPDATE UserSession s SET s.lastActive = :now WHERE s.sessionId = :sessionId AND s.isActive = true")
    int touchActiveSession(@Param("sessionId") String sessionId, @Param("now") LocalDateTime now);
}
