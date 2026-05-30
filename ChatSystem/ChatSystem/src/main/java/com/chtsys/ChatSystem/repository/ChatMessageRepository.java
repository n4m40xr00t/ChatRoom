package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.ChatMessage;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

@Repository
public interface ChatMessageRepository extends JpaRepository<ChatMessage, Long> {
    List<ChatMessage> findByIsPublicTrueOrderByTimestampAsc();
    List<ChatMessage> findBySenderNameAndReceiverNameOrSenderNameAndReceiverNameOrderByTimestampAsc(
            String sender1, String receiver1, String sender2, String receiver2);
    boolean existsBySenderNameAndReceiverNameOrSenderNameAndReceiverName(
            String sender1, String receiver1, String sender2, String receiver2);

    List<ChatMessage> findByGroup_IdOrderByTimestampAsc(Long groupId);
    List<ChatMessage> findByGroup_IdAndMessageTypeOrderByTimestampAsc(Long groupId, String messageType);
    List<ChatMessage> findByIsPublicTrueAndMessageTypeOrderByTimestampAsc(String messageType);

    @Query("SELECT m FROM ChatMessage m WHERE m.messageType = :messageType AND ((m.senderName = :user1 AND m.receiverName = :user2) OR (m.senderName = :user2 AND m.receiverName = :user1)) ORDER BY m.timestamp ASC")
    List<ChatMessage> findMessagesByTypeBetweenUsers(@Param("user1") String user1, @Param("user2") String user2, @Param("messageType") String messageType);

    @Query("SELECT COUNT(m) FROM ChatMessage m WHERE m.senderName = :sender AND m.receiverName = :receiver AND m.isRead = false")
    long countUnreadBySender(@Param("sender") String sender, @Param("receiver") String receiver);

    long countByTimestampBetween(LocalDateTime start, LocalDateTime end);
    long countBySenderName(String senderName);

    @Modifying
    @Transactional
    void deleteByGroup_Id(Long groupId);

    @Modifying
    @Transactional
    void deleteBySenderNameAndReceiverName(String senderName, String receiverName);

    // Pinned message queries
    Optional<ChatMessage> findByIsPublicTrueAndPinnedTrue();

    Optional<ChatMessage> findByGroup_IdAndPinnedTrue(Long groupId);

    @Query("SELECT m FROM ChatMessage m WHERE m.pinned = true AND ((m.senderName = :user1 AND m.receiverName = :user2) OR (m.senderName = :user2 AND m.receiverName = :user1))")
    Optional<ChatMessage> findPinnedPrivateMessage(@Param("user1") String user1, @Param("user2") String user2);

    // Thread queries
    List<ChatMessage> findByThreadRootIdOrderByTimestampAsc(Long threadRootId);

    // ---- Stats queries ----
    long countByReceiverName(String receiverName);

    long countBySenderNameAndTimestampBetween(String senderName, LocalDateTime start, LocalDateTime end);

    @Query("SELECT m.receiverName as partner, COUNT(m) as cnt FROM ChatMessage m WHERE m.senderName = :username AND m.receiverName IS NOT NULL AND m.group IS NULL GROUP BY m.receiverName ORDER BY cnt DESC")
    List<Object[]> findTopChatPartner(@Param("username") String username, Pageable pageable);

    @Query("SELECT m.messageType, COUNT(m) FROM ChatMessage m WHERE m.senderName = :username GROUP BY m.messageType")
    List<Object[]> countByMessageType(@Param("username") String username);

    // ---- Export queries ----
    @Query("SELECT m FROM ChatMessage m WHERE m.senderName = :username OR m.receiverName = :username ORDER BY m.timestamp ASC")
    List<ChatMessage> findAllByUser(@Param("username") String username);

    @Modifying
    @Transactional
    @Query("DELETE FROM ChatMessage m WHERE m.senderName = :username OR m.receiverName = :username")
    void deleteAllByUser(@Param("username") String username);

    // ---- Search queries ----
    @Query("SELECT m FROM ChatMessage m WHERE m.isPublic = true AND m.messageType = 'TEXT' AND LOWER(CAST(m.content AS string)) LIKE LOWER(CONCAT('%', :q, '%')) ORDER BY m.timestamp DESC")
    List<ChatMessage> searchPublicMessages(@Param("q") String q, Pageable pageable);

    @Query("SELECT m FROM ChatMessage m WHERE m.isPublic = false AND m.group IS NULL AND m.messageType = 'TEXT' AND LOWER(CAST(m.content AS string)) LIKE LOWER(CONCAT('%', :q, '%')) AND (m.senderName = :username OR m.receiverName = :username) ORDER BY m.timestamp DESC")
    List<ChatMessage> searchPrivateMessages(@Param("username") String username, @Param("q") String q, Pageable pageable);

    @Query("SELECT m FROM ChatMessage m WHERE m.group.id IN :groupIds AND m.messageType = 'TEXT' AND LOWER(CAST(m.content AS string)) LIKE LOWER(CONCAT('%', :q, '%')) ORDER BY m.timestamp DESC")
    List<ChatMessage> searchGroupMessages(@Param("groupIds") List<Long> groupIds, @Param("q") String q, Pageable pageable);

    // ---- Images queries ----
    @Query("SELECT m FROM ChatMessage m WHERE m.isPublic = true AND m.messageType = 'IMAGE' AND m.content IS NOT NULL ORDER BY m.timestamp DESC")
    List<ChatMessage> findPublicImages(Pageable pageable);

    @Query("SELECT m FROM ChatMessage m WHERE m.isPublic = false AND m.group IS NULL AND m.messageType = 'IMAGE' AND m.content IS NOT NULL AND (m.senderName = :username OR m.receiverName = :username) ORDER BY m.timestamp DESC")
    List<ChatMessage> findPrivateImages(@Param("username") String username, Pageable pageable);

    @Query("SELECT m FROM ChatMessage m WHERE m.group.id IN :groupIds AND m.messageType = 'IMAGE' AND m.content IS NOT NULL ORDER BY m.timestamp DESC")
    List<ChatMessage> findGroupImages(@Param("groupIds") List<Long> groupIds, Pageable pageable);
}
