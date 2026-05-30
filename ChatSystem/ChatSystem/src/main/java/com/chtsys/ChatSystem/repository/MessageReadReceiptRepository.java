package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.MessageReadReceipt;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface MessageReadReceiptRepository extends JpaRepository<MessageReadReceipt, Long> {

    List<MessageReadReceipt> findByMessageId(Long messageId);

    Optional<MessageReadReceipt> findByMessageIdAndUsername(Long messageId, String username);

    long countByMessageId(Long messageId);

    void deleteByMessageId(Long messageId);
}
