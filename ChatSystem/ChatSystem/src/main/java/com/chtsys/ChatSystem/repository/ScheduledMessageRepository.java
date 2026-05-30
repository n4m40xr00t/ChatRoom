package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.ScheduledMessage;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;

@Repository
public interface ScheduledMessageRepository extends JpaRepository<ScheduledMessage, Long> {
    List<ScheduledMessage> findByScheduledAtBeforeAndSentFalse(LocalDateTime now);
    List<ScheduledMessage> findBySenderNameAndSentFalseOrderByScheduledAtAsc(String senderName);
}
