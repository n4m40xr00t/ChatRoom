package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.ChatLock;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface ChatLockRepository extends JpaRepository<ChatLock, Long> {
    List<ChatLock> findByOwnerUsername(String ownerUsername);
    Optional<ChatLock> findByOwnerUsernameAndTargetUsername(String ownerUsername, String targetUsername);
    Optional<ChatLock> findByOwnerUsernameAndTargetGroupId(String ownerUsername, Long targetGroupId);
}
