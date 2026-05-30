package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.UserBlock;
import com.chtsys.ChatSystem.Model.UserEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface UserBlockRepository extends JpaRepository<UserBlock, Long> {
    boolean existsByBlockerAndBlocked(UserEntity blocker, UserEntity blocked);
    Optional<UserBlock> findByBlockerAndBlocked(UserEntity blocker, UserEntity blocked);
    List<UserBlock> findByBlocker(UserEntity blocker);
}
