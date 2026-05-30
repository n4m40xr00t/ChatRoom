package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.MessageReaction;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

@Repository
public interface MessageReactionRepository extends JpaRepository<MessageReaction, Long> {

    /** All reactions for a given message. */
    List<MessageReaction> findByMessageId(Long messageId);

    /** Find a specific user's reaction on a message (at most one per the unique constraint). */
    Optional<MessageReaction> findByMessageIdAndUsername(Long messageId, String username);

    /** Remove a specific user's reaction on a message. */
    @Modifying
    @Transactional
    void deleteByMessageIdAndUsername(Long messageId, String username);

    /** Remove all reactions when a message is deleted. */
    @Modifying
    @Transactional
    void deleteByMessageId(Long messageId);

    /** Remove all reactions for a list of message IDs (bulk delete). */
    @Modifying
    @Transactional
    void deleteByMessageIdIn(List<Long> messageIds);
}
