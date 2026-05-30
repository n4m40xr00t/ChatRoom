package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.DeletedMessageForUser;
import com.chtsys.ChatSystem.Model.DeletedMessageForUserKey;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import java.util.Set;
import java.util.List;

@Repository
public interface DeletedMessageForUserRepository
        extends JpaRepository<DeletedMessageForUser, DeletedMessageForUserKey> {

    boolean existsById_MessageIdAndId_Username(Long messageId, String username);

    @Query("SELECT d.id.messageId FROM DeletedMessageForUser d WHERE d.id.username = :username")
    Set<Long> findMessageIdsByUsername(@Param("username") String username);

    @Modifying
    @Transactional
    @Query("DELETE FROM DeletedMessageForUser d WHERE d.id.messageId IN :messageIds")
    void deleteByMessageIdIn(@Param("messageIds") List<Long> messageIds);
}
