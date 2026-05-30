package com.chtsys.ChatSystem.controller;

import com.chtsys.ChatSystem.Model.*;
import com.chtsys.ChatSystem.Model.MessageReadReceipt;
import com.chtsys.ChatSystem.repository.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import jakarta.servlet.http.HttpSession;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.stream.Collectors;
import java.util.regex.Pattern;
import org.springframework.data.domain.PageRequest;

@RestController
@RequestMapping("/api")
public class ApiController {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private ContactRepository contactRepository;

    @Autowired
    private ChatMessageRepository chatMessageRepository;

    @Autowired
    private InvitationRepository invitationRepository;

    @Autowired
    private UserBlockRepository userBlockRepository;

    @Autowired
    private ChatGroupRepository chatGroupRepository;

    @Autowired
    private GroupMemberRepository groupMemberRepository;

    @Autowired
    private BCryptPasswordEncoder passwordEncoder;

    @Autowired
    private com.chtsys.ChatSystem.config.RateLimiter rateLimiter;

    private static final int PW_CHANGE_MAX_ATTEMPTS = 5;
    private static final int PW_CHANGE_WINDOW_MINUTES = 15;
    private static final int PW_CHANGE_LOCKOUT_MINUTES = 30;

    @Autowired
    private ChatLockRepository chatLockRepository;

    @Autowired
    private SimpMessagingTemplate messagingTemplate;

    @Autowired
    private DeletedMessageForUserRepository deletedMessageForUserRepository;

    @Autowired
    private com.chtsys.ChatSystem.repository.MessageReactionRepository messageReactionRepository;

    @Autowired
    private FileRecordRepository fileRecordRepository;

    @Autowired
    private UserSessionRepository userSessionRepository;

    @Autowired
    private MessageReadReceiptRepository messageReadReceiptRepository;

    @Value("${app.max-file-bytes:8388608}")
    private long maxFileBytes;

    private static final int BIO_MAX_LENGTH = 280;
    private static final DateTimeFormatter LAST_SEEN_FORMAT = DateTimeFormatter.ofPattern("HH:mm");

    private static final Pattern STRONG_PASSWORD =
        Pattern.compile("^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]{8,}$");

    private boolean isAdmin(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return false;
        if ("admin".equals(username)) return true;
        UserEntity u = userRepository.findByUsername(username).orElse(null);
        return u != null && u.isAdmin();
    }

    private String cleanText(String value, int maxLength) {
        if (value == null) return null;
        String cleaned = value.trim()
            .replaceAll("<[^>]*>", "")
            .replaceAll("[\\p{Cntrl}&&[^\r\n\t]]", "");
        return cleaned.length() > maxLength ? cleaned.substring(0, maxLength) : cleaned;
    }

    private String saveProfilePhotoFile(MultipartFile file) {
        try {
            String mimeType = file.getContentType();
            String ext = switch (mimeType != null ? mimeType : "") {
                case "image/png" -> ".png";
                case "image/jpeg" -> ".jpg";
                case "image/webp" -> ".webp";
                case "image/gif" -> ".gif";
                default -> ".jpg";
            };
            String storedName = java.util.UUID.randomUUID().toString() + ext;
            Path dir = Paths.get("uploads", "profiles");
            Files.createDirectories(dir);
            file.transferTo(dir.resolve(storedName));
            return "/uploads/profiles/" + storedName;
        } catch (Exception e) {
            return null;
        }
    }

    private boolean isAllowedImage(MultipartFile file) {
        String type = file.getContentType();
        return type != null && (type.equals("image/png") || type.equals("image/jpeg") || type.equals("image/webp") || type.equals("image/gif"));
    }

    private String formatPresence(UserEntity user) {
        if (!user.isShowOnlineStatus()) return "Offline";
        if (user.isOnline()) return "Online";
        if (user.getLastSeenAt() == null) return "Offline";
        return "Last seen at " + user.getLastSeenAt().format(LAST_SEEN_FORMAT);
    }

    private boolean canViewUser(UserEntity viewer, UserEntity target) {
        if (viewer.getUsername().equals(target.getUsername())) return true;
        if (contactRepository.existsByOwnerAndContactUser(viewer, target)) return true;
        return chatMessageRepository.existsBySenderNameAndReceiverNameOrSenderNameAndReceiverName(
                viewer.getUsername(), target.getUsername(), target.getUsername(), viewer.getUsername());
    }

    @SuppressWarnings("unchecked")
    private boolean isUnlocked(HttpSession session, String key) {
        Set<String> unlocked = (Set<String>) session.getAttribute("unlockedChats");
        return unlocked != null && unlocked.contains(key);
    }

    private void unpinExistingInChat(ChatMessage msg) {
        Optional<ChatMessage> existing = Optional.empty();
        if (msg.isPublic()) {
            existing = chatMessageRepository.findByIsPublicTrueAndPinnedTrue();
        } else if (msg.getGroup() != null) {
            existing = chatMessageRepository.findByGroup_IdAndPinnedTrue(msg.getGroup().getId());
        } else {
            existing = chatMessageRepository.findPinnedPrivateMessage(msg.getSenderName(), msg.getReceiverName());
            if (existing.isEmpty()) {
                existing = chatMessageRepository.findPinnedPrivateMessage(msg.getReceiverName(), msg.getSenderName());
            }
        }
        existing.ifPresent(m -> {
            m.setPinned(false);
            chatMessageRepository.save(m);
        });
    }

    // ---- Global message search ----
    @GetMapping("/messages/search")
    public ResponseEntity<?> searchMessages(@RequestParam String q, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        String trimmed = q == null ? "" : q.trim();
        if (trimmed.length() < 2) return ResponseEntity.ok(Collections.emptyList());

        DateTimeFormatter fmt = DateTimeFormatter.ofPattern("dd.MM HH:mm");
        List<Map<String, Object>> result = new ArrayList<>();
        int limit = 60;

        Set<Long> groupIdSet = groupMemberRepository.findByUsername(username)
                .stream().map(gm -> gm.getChatGroup().getId()).collect(Collectors.toSet());

        Map<Long, String> groupNames = new HashMap<>();
        groupMemberRepository.findByUsername(username).forEach(gm -> {
            ChatGroup g = gm.getChatGroup();
            groupNames.put(g.getId(), g.getName());
        });

        List<ChatLock> userLocks = chatLockRepository.findByOwnerUsername(username);
        Set<String> lockedUsers = new HashSet<>();
        Set<Long> lockedGroups = new HashSet<>();
        for (ChatLock l : userLocks) {
            if (l.getTargetUsername() != null && !isUnlocked(session, "USER_" + l.getTargetUsername()))
                lockedUsers.add(l.getTargetUsername());
            if (l.getTargetGroupId() != null && !isUnlocked(session, "GROUP_" + l.getTargetGroupId()))
                lockedGroups.add(l.getTargetGroupId());
        }

        // Search public messages
        for (ChatMessage m : chatMessageRepository.searchPublicMessages(trimmed, org.springframework.data.domain.PageRequest.of(0, limit))) {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("id", m.getId());
            map.put("senderName", m.getSenderName());
            map.put("content", m.getContent());
            map.put("timestamp", m.getTimestamp() != null ? m.getTimestamp().format(fmt) : "");
            map.put("chatLabel", "Public Chat");
            map.put("chatType", "public");
            map.put("chatId", "public");
            result.add(map);
        }

        // Search private messages (skip locked chats)
        for (ChatMessage m : chatMessageRepository.searchPrivateMessages(username, trimmed, org.springframework.data.domain.PageRequest.of(0, limit))) {
            String other = username.equals(m.getSenderName()) ? m.getReceiverName() : m.getSenderName();
            if (other != null && lockedUsers.contains(other)) continue;
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("id", m.getId());
            map.put("senderName", m.getSenderName());
            map.put("content", m.getContent());
            map.put("timestamp", m.getTimestamp() != null ? m.getTimestamp().format(fmt) : "");
            map.put("chatLabel", other != null ? other : "");
            map.put("chatType", "private");
            map.put("chatId", other != null ? other : "");
            result.add(map);
        }

        // Search group messages
        List<Long> groupIds = new ArrayList<>(groupIdSet);
        if (!groupIds.isEmpty()) {
            for (ChatMessage m : chatMessageRepository.searchGroupMessages(groupIds, trimmed, org.springframework.data.domain.PageRequest.of(0, limit))) {
                if (lockedGroups.contains(m.getGroup().getId())) continue;
                Map<String, Object> map = new LinkedHashMap<>();
                map.put("id", m.getId());
                map.put("senderName", m.getSenderName());
                map.put("content", m.getContent());
                map.put("timestamp", m.getTimestamp() != null ? m.getTimestamp().format(fmt) : "");
                map.put("chatLabel", groupNames.getOrDefault(m.getGroup().getId(), "Group"));
                map.put("chatType", "group");
                map.put("chatId", m.getGroup().getId());
                result.add(map);
            }
        }

        result.sort((a, b) -> {
            String ta = (String) a.get("timestamp");
            String tb = (String) b.get("timestamp");
            return tb.compareTo(ta);
        });
        if (result.size() > limit) result = result.subList(0, limit);

        return ResponseEntity.ok(result);
    }

    // Fetch all shared images the user has access to
    @GetMapping("/messages/images")
    public ResponseEntity<?> getImages(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        Set<Long> groupIdSet = groupMemberRepository.findByUsername(username)
                .stream().map(gm -> gm.getChatGroup().getId()).collect(Collectors.toSet());

        Map<Long, String> groupNames = new HashMap<>();
        groupMemberRepository.findByUsername(username).forEach(gm -> {
            ChatGroup g = gm.getChatGroup();
            groupNames.put(g.getId(), g.getName());
        });

        List<ChatLock> userLocks = chatLockRepository.findByOwnerUsername(username);
        Set<String> lockedUsers = new HashSet<>();
        Set<Long> lockedGroups = new HashSet<>();
        for (ChatLock l : userLocks) {
            if (l.getTargetUsername() != null && !isUnlocked(session, "USER_" + l.getTargetUsername()))
                lockedUsers.add(l.getTargetUsername());
            if (l.getTargetGroupId() != null && !isUnlocked(session, "GROUP_" + l.getTargetGroupId()))
                lockedGroups.add(l.getTargetGroupId());
        }

        DateTimeFormatter fmt = DateTimeFormatter.ofPattern("dd.MM HH:mm");
        List<Map<String, Object>> result = new ArrayList<>();

        // Public images
        for (ChatMessage m : chatMessageRepository.findPublicImages(org.springframework.data.domain.PageRequest.of(0, 200))) {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("id", m.getId());
            map.put("senderName", m.getSenderName());
            map.put("content", m.getContent());
            map.put("timestamp", m.getTimestamp() != null ? m.getTimestamp().format(fmt) : "");
            map.put("fileName", m.getFileName());
            map.put("chatLabel", "Public Chat");
            map.put("chatType", "public");
            result.add(map);
        }

        // Private images
        for (ChatMessage m : chatMessageRepository.findPrivateImages(username, org.springframework.data.domain.PageRequest.of(0, 200))) {
            String other = username.equals(m.getSenderName()) ? m.getReceiverName() : m.getSenderName();
            if (other != null && lockedUsers.contains(other)) continue;
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("id", m.getId());
            map.put("senderName", m.getSenderName());
            map.put("content", m.getContent());
            map.put("timestamp", m.getTimestamp() != null ? m.getTimestamp().format(fmt) : "");
            map.put("fileName", m.getFileName());
            map.put("chatLabel", other != null ? other : "Unknown");
            map.put("chatType", "private");
            result.add(map);
        }

        // Group images
        List<Long> groupIds = new ArrayList<>(groupIdSet);
        if (!groupIds.isEmpty()) {
            for (ChatMessage m : chatMessageRepository.findGroupImages(groupIds, org.springframework.data.domain.PageRequest.of(0, 200))) {
                if (lockedGroups.contains(m.getGroup().getId())) continue;
                Map<String, Object> map = new LinkedHashMap<>();
                map.put("id", m.getId());
                map.put("senderName", m.getSenderName());
                map.put("content", m.getContent());
                map.put("timestamp", m.getTimestamp() != null ? m.getTimestamp().format(fmt) : "");
                map.put("fileName", m.getFileName());
                map.put("chatLabel", groupNames.getOrDefault(m.getGroup().getId(), "Group"));
                map.put("chatType", "group");
                result.add(map);
            }
        }

        result.sort((a, b) -> ((String) b.get("timestamp")).compareTo((String) a.get("timestamp")));

        return ResponseEntity.ok(result);
    }

    // Fetch user's contact list
    @GetMapping("/contacts")
    public ResponseEntity<?> getContacts(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).build();

        List<ChatLock> userLocks = chatLockRepository.findByOwnerUsername(username);
        Set<String> lockedUsers = userLocks.stream()
                .filter(l -> l.getTargetUsername() != null)
                .map(ChatLock::getTargetUsername)
                .collect(Collectors.toSet());

        List<Contact> contacts = contactRepository.findByOwner(user);
        List<Map<String, String>> contactList = contacts.stream().map(c -> {
            Map<String, String> map = new HashMap<>();
            String contactUsername = c.getContactUser().getUsername();
            map.put("username", contactUsername);
            String fname = c.getContactUser().getName() != null ? c.getContactUser().getName() : "";
            String sname = c.getContactUser().getSurname() != null ? c.getContactUser().getSurname() : "";
            map.put("fullname", (fname + " " + sname).trim());
            map.put("bio", c.getContactUser().getBio() != null ? c.getContactUser().getBio() : "");
            map.put("presence", formatPresence(c.getContactUser()));
            boolean showOnline = c.getContactUser().isShowOnlineStatus();
            map.put("online", Boolean.toString(showOnline && c.getContactUser().isOnline()));
            map.put("showOnlineStatus", Boolean.toString(showOnline));
            map.put("blocked", Boolean.toString(userBlockRepository.existsByBlockerAndBlocked(user, c.getContactUser())));
            map.put("blockedBy", Boolean.toString(userBlockRepository.existsByBlockerAndBlocked(c.getContactUser(), user)));
            map.put("locked", Boolean.toString(lockedUsers.contains(contactUsername)));
            map.put("unread", String.valueOf(chatMessageRepository.countUnreadBySender(contactUsername, username)));
            if (c.getContactUser().getProfilePicture() != null)
                map.put("profilePicture", c.getContactUser().getProfilePicture());
            return map;
        }).collect(Collectors.toList());

        return ResponseEntity.ok(contactList);
    }

    // Fetch chat history
    @GetMapping("/messages/{contact}")
    public ResponseEntity<?> getChatHistory(@PathVariable String contact, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        if (!"public".equals(contact)) {
            boolean locked = chatLockRepository.findByOwnerUsernameAndTargetUsername(username, contact).isPresent();
            if (locked && !isUnlocked(session, "USER_" + contact))
                return ResponseEntity.status(403).body(Map.of("locked", true));
        }

        List<ChatMessage> messages;
        if ("public".equals(contact)) {
            messages = chatMessageRepository.findByIsPublicTrueOrderByTimestampAsc();
        } else {
            List<ChatMessage> raw = chatMessageRepository
                    .findBySenderNameAndReceiverNameOrSenderNameAndReceiverNameOrderByTimestampAsc(
                            username, contact, contact, username);

            Set<Long> hiddenIds = deletedMessageForUserRepository.findMessageIdsByUsername(username);
            messages = hiddenIds.isEmpty()
                    ? raw
                    : raw.stream().filter(m -> !hiddenIds.contains(m.getId())).collect(Collectors.toList());
        }

        List<Map<String, Object>> response = messages.stream().map(m -> {
            Map<String, Object> map = new HashMap<>();
            map.put("id", m.getId());
            map.put("senderName", m.getSenderName());
            map.put("receiverName", m.getReceiverName());
            map.put("content", m.getContent());
            map.put("messageType", m.getMessageType());
            map.put("edited", m.isEdited());
            map.put("delivered", m.isDelivered());
            map.put("read", m.isRead());
            map.put("deliveredAt", m.getDeliveredAt());
            map.put("readAt", m.getReadAt());
            map.put("replyToId", m.getReplyToId());
            map.put("replyToContent", m.getReplyToContent());
            map.put("replyToSender", m.getReplyToSender());
            map.put("threadRootId", m.getThreadRootId());
            map.put("forwardedFrom", m.getForwardedFrom());
            map.put("pinned", m.isPinned());
            map.put("fileName", m.getFileName());
            map.put("fileSize", m.getFileSize());
            map.put("mimeType", m.getMimeType());
            map.put("reactions", buildReactionSummary(m.getId(), username));
            return map;
        }).collect(Collectors.toList());

        return ResponseEntity.ok(response);
    }

    // Delete a message for the current user only (server-side persistence)
    @PostMapping("/messages/{id}/delete-for-me")
    public ResponseEntity<?> deleteForMe(@PathVariable Long id, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        ChatMessage msg = chatMessageRepository.findById(id).orElse(null);
        if (msg == null) return ResponseEntity.status(404).build();

        DeletedMessageForUserKey key = new DeletedMessageForUserKey(id, username);
        if (!deletedMessageForUserRepository.existsById(key)) {
            deletedMessageForUserRepository.save(new DeletedMessageForUser(key));
        }
        return ResponseEntity.ok(Map.of("success", true));
    }

    // Generate Invitation Link
    @PostMapping("/invite/generate")
    public ResponseEntity<?> generateInvite(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        UserEntity inviter = userRepository.findByUsername(username).orElse(null);
        if (inviter == null) return ResponseEntity.status(401).build();

        String token = UUID.randomUUID().toString();
        Invitation invite = new Invitation();
        invite.setInviter(inviter);
        invite.setToken(token);
        invite.setCreatedAt(LocalDateTime.now());
        invite.setExpiresAt(LocalDateTime.now().plusDays(7));
        invite.setUsed(false);
        invitationRepository.save(invite);

        return ResponseEntity.ok(Map.of("token", token));
    }

    // Accept Invitation Link
    @PostMapping("/invite/accept/{token}")
    public ResponseEntity<?> acceptInvite(@PathVariable String token, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).body("Not logged in");

        UserEntity currentUser = userRepository.findByUsername(username).orElse(null);
        if (currentUser == null) return ResponseEntity.status(401).build();

        Invitation invite = invitationRepository.findByToken(token).orElse(null);
        if (invite == null) return ResponseEntity.status(404).body("Invalid invitation link");
        if (invite.isUsed()) return ResponseEntity.status(400).body("Invitation already used");
        if (invite.getExpiresAt() != null && invite.getExpiresAt().isBefore(LocalDateTime.now()))
            return ResponseEntity.status(410).body("Invitation link has expired");

        UserEntity inviter = invite.getInviter();
        if (inviter.getUsername().equals(currentUser.getUsername()))
            return ResponseEntity.status(400).body("You cannot invite yourself");

        if (!contactRepository.existsByOwnerAndContactUser(currentUser, inviter)) {
            Contact c1 = new Contact();
            c1.setOwner(currentUser);
            c1.setContactUser(inviter);
            contactRepository.save(c1);
        }
        if (!contactRepository.existsByOwnerAndContactUser(inviter, currentUser)) {
            Contact c2 = new Contact();
            c2.setOwner(inviter);
            c2.setContactUser(currentUser);
            contactRepository.save(c2);
        }

        invite.setUsed(true);
        invitationRepository.save(invite);

        return ResponseEntity.ok(Map.of("success", true, "contactAdded", inviter.getUsername()));
    }

    // ---- User info (for contact tooltip) ----
    @GetMapping("/users/{username}")
    public ResponseEntity<?> getUserInfo(@PathVariable String username, HttpSession session) {
        String currentUsername = (String) session.getAttribute("username");
        if (currentUsername == null) return ResponseEntity.status(401).build();
        UserEntity currentUser = userRepository.findByUsername(currentUsername).orElse(null);
        if (currentUser == null) return ResponseEntity.status(401).build();
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(404).build();
        if (!canViewUser(currentUser, user)) return ResponseEntity.status(403).build();

        boolean isContact = contactRepository.existsByOwnerAndContactUser(currentUser, user);

        Map<String, Object> info = new HashMap<>();
        String fname = user.getName() != null ? user.getName() : "";
        String sname = user.getSurname() != null ? user.getSurname() : "";
        info.put("username", user.getUsername());
        info.put("fullname", (fname + " " + sname).trim().isEmpty() ? user.getUsername() : (fname + " " + sname).trim());
        info.put("bio", user.getBio() != null ? user.getBio() : "");
        info.put("online", user.isShowOnlineStatus() && user.isOnline());
        info.put("presence", formatPresence(user));
        info.put("showOnlineStatus", user.isShowOnlineStatus());
        info.put("sendReadReceipts", user.isSendReadReceipts());
        info.put("blocked", userBlockRepository.existsByBlockerAndBlocked(currentUser, user));
        info.put("blockedBy", userBlockRepository.existsByBlockerAndBlocked(user, currentUser));
        info.put("contactPrivacy", user.getContactPrivacy() != null ? user.getContactPrivacy() : "everyone");
        info.put("isContact", isContact);
        if (user.getProfilePicture() != null) info.put("profilePicture", user.getProfilePicture());
        return ResponseEntity.ok(info);
    }

    // ---- Settings: update profile ----
    @PostMapping("/settings/update")
    public ResponseEntity<?> updateProfile(
            @RequestParam(required = false) String name,
            @RequestParam(required = false) String surname,
            @RequestParam(required = false) String email,
            @RequestParam(required = false) String bio,
            @RequestParam(required = false) MultipartFile profilePhoto,
            HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).body("Not logged in");
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(404).body("User not found");

        if (name != null && !name.isBlank()) user.setName(cleanText(name, 80));
        if (surname != null && !surname.isBlank()) user.setSurname(cleanText(surname, 80));
        if (email != null && !email.isBlank()) user.setEmail(cleanText(email, 180));
        if (bio != null) user.setBio(cleanText(bio, BIO_MAX_LENGTH));

        if (profilePhoto != null && !profilePhoto.isEmpty()) {
            if (profilePhoto.getSize() > 5 * 1024 * 1024 || !isAllowedImage(profilePhoto))
                return ResponseEntity.badRequest().body("Profile photo must be a PNG, JPG, GIF, or WebP image under 5 MB.");
            String photoUrl = saveProfilePhotoFile(profilePhoto);
            if (photoUrl != null) user.setProfilePicture(photoUrl);
        }
        userRepository.save(user);
        return ResponseEntity.ok(Map.of("success", true));
    }

    @GetMapping("/blocks")
    public ResponseEntity<?> listBlocks(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).build();

        List<Map<String, String>> blocks = userBlockRepository.findByBlocker(user).stream().map(block -> {
            UserEntity blocked = block.getBlocked();
            Map<String, String> item = new HashMap<>();
            item.put("username", blocked.getUsername());
            String fname = blocked.getName() != null ? blocked.getName() : "";
            String sname = blocked.getSurname() != null ? blocked.getSurname() : "";
            item.put("fullname", (fname + " " + sname).trim());
            return item;
        }).collect(Collectors.toList());
        return ResponseEntity.ok(blocks);
    }

    @PostMapping("/blocks/{targetUsername}")
    public ResponseEntity<?> blockUser(@PathVariable String targetUsername, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();
        if (username.equals(targetUsername)) return ResponseEntity.badRequest().body("You cannot block yourself.");

        UserEntity blocker = userRepository.findByUsername(username).orElse(null);
        UserEntity blocked = userRepository.findByUsername(targetUsername).orElse(null);
        if (blocker == null) return ResponseEntity.status(401).build();
        if (blocked == null) return ResponseEntity.status(404).body("User not found");
        if (!canViewUser(blocker, blocked)) return ResponseEntity.status(403).body("You cannot block this user.");

        if (!userBlockRepository.existsByBlockerAndBlocked(blocker, blocked)) {
            UserBlock userBlock = new UserBlock();
            userBlock.setBlocker(blocker);
            userBlock.setBlocked(blocked);
            userBlockRepository.save(userBlock);
        }
        return ResponseEntity.ok(Map.of("success", true));
    }

    @DeleteMapping("/blocks/{targetUsername}")
    public ResponseEntity<?> unblockUser(@PathVariable String targetUsername, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        UserEntity blocker = userRepository.findByUsername(username).orElse(null);
        UserEntity blocked = userRepository.findByUsername(targetUsername).orElse(null);
        if (blocker == null) return ResponseEntity.status(401).build();
        if (blocked == null) return ResponseEntity.status(404).body("User not found");

        userBlockRepository.findByBlockerAndBlocked(blocker, blocked).ifPresent(userBlockRepository::delete);
        return ResponseEntity.ok(Map.of("success", true));
    }

    // ---- Settings: save theme & chat background ----
    private static final java.util.Set<String> VALID_THEMES =
        java.util.Set.of("dark", "midnight", "ocean", "forest", "rose", "slate");
    private static final java.util.Set<String> VALID_CHAT_BGS =
        java.util.Set.of("none", "dots", "grid", "waves", "bubbles");

    @PostMapping("/settings/theme")
    public ResponseEntity<?> updateTheme(@RequestBody Map<String, String> body, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).body("Not logged in");
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(404).body("User not found");

        String theme  = body.get("theme");
        String chatBg = body.get("chatBg");

        if (theme != null && VALID_THEMES.contains(theme))   user.setTheme(theme);
        if (chatBg != null && VALID_CHAT_BGS.contains(chatBg)) user.setChatBg(chatBg);

        userRepository.save(user);
        return ResponseEntity.ok(Map.of("success", true));
    }

    @GetMapping("/settings/theme")
    public ResponseEntity<?> getTheme(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).build();
        return ResponseEntity.ok(Map.of(
            "theme",  user.getTheme()  != null ? user.getTheme()  : "dark",
            "chatBg", user.getChatBg() != null ? user.getChatBg() : "bubbles"
        ));
    }

    // ---- Contacts: auto-add when starting a private chat ----
    /**
     * Adds targetUsername to the current user's contact list (one-sided).
     * Safe to call multiple times — does nothing if the contact already exists.
     * Returns { added: true } if a new record was created, { added: false } if it already existed.
     */
    @PostMapping("/contacts/{targetUsername}")
    public ResponseEntity<?> addContact(@PathVariable String targetUsername, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();
        if (username.equals(targetUsername))
            return ResponseEntity.badRequest().body(Map.of("error", "Cannot add yourself as a contact."));

        UserEntity currentUser = userRepository.findByUsername(username).orElse(null);
        if (currentUser == null) return ResponseEntity.status(401).build();

        UserEntity target = userRepository.findByUsername(targetUsername).orElse(null);
        if (target == null) return ResponseEntity.status(404).body(Map.of("error", "User not found."));

        if (contactRepository.existsByOwnerAndContactUser(currentUser, target)) {
            return ResponseEntity.ok(Map.of("added", false));
        }

        // Respect contactPrivacy
        String privacy = target.getContactPrivacy();
        if ("invitation".equals(privacy)) {
            boolean mutual = contactRepository.existsByOwnerAndContactUser(target, currentUser);
            if (!mutual) {
                return ResponseEntity.status(403).body(Map.of("error", "privacy_restricted", "message", "This user requires an invitation. Ask them for an invite link."));
            }
        }

        Contact contact = new Contact();
        contact.setOwner(currentUser);
        contact.setContactUser(target);
        contactRepository.save(contact);

        return ResponseEntity.ok(Map.of("added", true));
    }

    /**
     * Returns the list of groups that both the current user and targetUsername share.
     */
    @GetMapping("/users/{targetUsername}/shared-groups")
    public ResponseEntity<?> getSharedGroups(@PathVariable String targetUsername, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        // Groups the current user belongs to
        Set<Long> myGroupIds = groupMemberRepository.findByUsername(username)
                .stream().map(gm -> gm.getChatGroup().getId()).collect(java.util.stream.Collectors.toSet());

        // Groups the target user belongs to — intersect with mine
        List<Map<String, Object>> shared = groupMemberRepository.findByUsername(targetUsername)
                .stream()
                .filter(gm -> myGroupIds.contains(gm.getChatGroup().getId()))
                .map(gm -> {
                    com.chtsys.ChatSystem.Model.ChatGroup g = gm.getChatGroup();
                    Map<String, Object> item = new java.util.LinkedHashMap<>();
                    item.put("id",     g.getId());
                    item.put("name",   g.getName());
                    item.put("photo",  g.getPicture());
                    item.put("members", groupMemberRepository.countByChatGroup_Id(g.getId()));
                    return item;
                })
                .collect(java.util.stream.Collectors.toList());

        return ResponseEntity.ok(shared);
    }

    /**
     * Permanently deletes all private messages between the current user and targetUsername.
     * Requires the current user's password as confirmation.
     * This is a destructive, irreversible operation — both sides of the conversation are deleted.
     */
    @DeleteMapping("/conversations/{targetUsername}")
    public ResponseEntity<?> deleteConversation(@PathVariable String targetUsername,
                                                @RequestBody Map<String, String> body,
                                                HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        UserEntity currentUser = userRepository.findByUsername(username).orElse(null);
        if (currentUser == null) return ResponseEntity.status(401).build();

        // Password confirmation
        String password = body.get("password");
        if (password == null || password.isBlank())
            return ResponseEntity.badRequest().body(Map.of("error", "Password is required."));
        if (!passwordEncoder.matches(password, currentUser.getPassword()))
            return ResponseEntity.status(400).body(Map.of("error", "Incorrect password."));

        // Fetch and delete all messages between the two users
        List<ChatMessage> messages = chatMessageRepository
                .findBySenderNameAndReceiverNameOrSenderNameAndReceiverNameOrderByTimestampAsc(
                        username, targetUsername, targetUsername, username);

        if (messages.isEmpty()) {
            return ResponseEntity.ok(Map.of("deleted", 0));
        }

        // Bulk-remove any "deleted for me" records for these messages first
        List<Long> ids = messages.stream()
                .map(ChatMessage::getId)
                .collect(java.util.stream.Collectors.toList());
        deletedMessageForUserRepository.deleteByMessageIdIn(ids);

        chatMessageRepository.deleteAll(messages);

        return ResponseEntity.ok(Map.of("deleted", messages.size()));
    }

    @PostMapping("/settings/update-password")
    public ResponseEntity<?> updatePassword(@RequestBody Map<String, String> body, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).body("Not logged in");
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(404).body("User not found");

        // Rate limit password change attempts per user
        String rateLimitKey = "pwchange:" + username;
        if (rateLimiter.isBlocked(rateLimitKey)) {
            return ResponseEntity.status(429).body(Map.of("error", "Too many password change attempts. Please try again later."));
        }

        String currentPw = body.get("currentPassword");
        String newPw     = body.get("newPassword");
        if (currentPw == null || newPw == null) return ResponseEntity.badRequest().body("Missing fields");
        if (!passwordEncoder.matches(currentPw, user.getPassword())) {
            rateLimiter.recordFailure(rateLimitKey, PW_CHANGE_MAX_ATTEMPTS, PW_CHANGE_WINDOW_MINUTES, PW_CHANGE_LOCKOUT_MINUTES);
            return ResponseEntity.status(400).body("Current password is incorrect");
        }

        if (!STRONG_PASSWORD.matcher(newPw).matches()) {
            return ResponseEntity.badRequest().body(
                "Password must be at least 8 characters and contain an uppercase letter, " +
                "a lowercase letter, a digit, and a special character (@$!%*?&).");
        }

        user.setPassword(passwordEncoder.encode(newPw));
        userRepository.save(user);
        return ResponseEntity.ok(Map.of("success", true));
    }

    // ---- Emoji Reactions ----

    /**
     * Returns aggregated reactions for a message.
     * Each entry: { emoji, count, reactedByMe }
     */
    @GetMapping("/messages/{id}/reactions")
    public ResponseEntity<?> getReactions(@PathVariable Long id, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        ChatMessage msg = chatMessageRepository.findById(id).orElse(null);
        if (msg == null) return ResponseEntity.status(404).build();

        // Access check: user must be sender, receiver, or group member
        if (!canAccessMessage(msg, username)) return ResponseEntity.status(403).build();

        return ResponseEntity.ok(buildReactionSummary(id, username));
    }

    /**
     * Add or replace the current user's reaction on a message.
     * Body: { "emoji": "👍" }
     * One reaction per user per message (upsert).
     */
    @PostMapping("/messages/{id}/reactions")
    public ResponseEntity<?> addReaction(@PathVariable Long id,
                                         @RequestBody Map<String, String> body,
                                         HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        ChatMessage msg = chatMessageRepository.findById(id).orElse(null);
        if (msg == null) return ResponseEntity.status(404).build();
        if (!canAccessMessage(msg, username)) return ResponseEntity.status(403).build();

        String emoji = body.get("emoji");
        if (emoji == null || emoji.isBlank() || emoji.length() > 16)
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid emoji"));

        // Upsert: check existing reaction then save new one
        com.chtsys.ChatSystem.Model.MessageReaction existing = messageReactionRepository.findByMessageIdAndUsername(id, username).orElse(null);
        if (existing != null) {
            existing.setEmoji(emoji);
            messageReactionRepository.save(existing);
        } else {
            com.chtsys.ChatSystem.Model.MessageReaction reaction =
                new com.chtsys.ChatSystem.Model.MessageReaction(null, id, username, emoji);
            messageReactionRepository.save(reaction);
        }

        // Broadcast via WebSocket
        broadcastReactionUpdate(msg, id, username);

        return ResponseEntity.ok(buildReactionSummary(id, username));
    }

    /**
     * Remove the current user's reaction on a message.
     * Path: DELETE /api/messages/{id}/reactions/{emoji}
     */
    @DeleteMapping("/messages/{id}/reactions/{emoji}")
    public ResponseEntity<?> removeReaction(@PathVariable Long id,
                                            @PathVariable String emoji,
                                            HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        ChatMessage msg = chatMessageRepository.findById(id).orElse(null);
        if (msg == null) return ResponseEntity.status(404).build();
        if (!canAccessMessage(msg, username)) return ResponseEntity.status(403).build();

        // Only delete if the stored emoji matches (prevents deleting someone else's reaction)
        messageReactionRepository.findByMessageIdAndUsername(id, username).ifPresent(r -> {
            if (r.getEmoji().equals(emoji)) {
                messageReactionRepository.delete(r);
            }
        });

        // Broadcast via WebSocket
        broadcastReactionUpdate(msg, id, username);

        return ResponseEntity.ok(buildReactionSummary(id, username));
    }

    /** Fetch reactions for multiple message IDs at once (used when loading chat history). */
    @PostMapping("/messages/reactions/batch")
    public ResponseEntity<?> getReactionsBatch(@RequestBody Map<String, Object> body,
                                               HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        @SuppressWarnings("unchecked")
        java.util.List<Integer> rawIds = (java.util.List<Integer>) body.get("ids");
        if (rawIds == null || rawIds.isEmpty()) return ResponseEntity.ok(Map.of());

        // Cap at 200 IDs per request to prevent abuse
        if (rawIds.size() > 200) return ResponseEntity.badRequest().body(Map.of("error", "Too many IDs"));

        Map<String, Object> result = new java.util.LinkedHashMap<>();
        for (Integer rawId : rawIds) {
            Long msgId = rawId.longValue();
            result.put(String.valueOf(msgId), buildReactionSummary(msgId, username));
        }
        return ResponseEntity.ok(result);
    }

    // ---- Thread endpoint ----
    @GetMapping("/messages/{id}/thread")
    public ResponseEntity<?> getThread(@PathVariable Long id, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        ChatMessage root = chatMessageRepository.findById(id).orElse(null);
        if (root == null) return ResponseEntity.status(404).build();

        if (!canAccessMessage(root, username)) return ResponseEntity.status(403).build();

        Long rootId = root.getThreadRootId() != null ? root.getThreadRootId() : root.getId();

        List<ChatMessage> all = new ArrayList<>();
        ChatMessage rootMsg = chatMessageRepository.findById(rootId).orElse(null);
        if (rootMsg != null) all.add(rootMsg);
        all.addAll(chatMessageRepository.findByThreadRootIdOrderByTimestampAsc(rootId));

        List<Map<String, Object>> response = all.stream().map(m -> {
            Map<String, Object> map = new HashMap<>();
            map.put("id", m.getId());
            map.put("senderName", m.getSenderName());
            map.put("content", m.getContent());
            map.put("messageType", m.getMessageType());
            map.put("timestamp", m.getTimestamp() != null ? m.getTimestamp().toString() : "");
            map.put("edited", m.isEdited());
            map.put("replyToId", m.getReplyToId());
            map.put("replyToContent", m.getReplyToContent());
            map.put("replyToSender", m.getReplyToSender());
            map.put("forwardedFrom", m.getForwardedFrom());
            map.put("pinned", m.isPinned());
            map.put("fileName", m.getFileName());
            map.put("fileSize", m.getFileSize());
            map.put("mimeType", m.getMimeType());
            map.put("reactions", buildReactionSummary(m.getId(), username));
            return map;
        }).collect(Collectors.toList());

        return ResponseEntity.ok(response);
    }

    // ---- Group Read Receipts ----
    @GetMapping("/messages/{id}/read-by")
    public ResponseEntity<?> getReadBy(@PathVariable Long id, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        ChatMessage msg = chatMessageRepository.findById(id).orElse(null);
        if (msg == null) return ResponseEntity.status(404).build();
        if (!canAccessMessage(msg, username)) return ResponseEntity.status(403).build();

        // Only the sender can see who read their message
        if (!username.equals(msg.getSenderName()))
            return ResponseEntity.status(403).body(Map.of("error", "Only the sender can see read receipts"));

        List<MessageReadReceipt> receipts = messageReadReceiptRepository.findByMessageId(id);
        List<Map<String, Object>> result = receipts.stream().map(r -> {
            Map<String, Object> entry = new HashMap<>();
            entry.put("username", r.getUsername());
            entry.put("readAt", r.getReadAt() != null ? r.getReadAt().toString() : null);
            return entry;
        }).collect(Collectors.toList());

        return ResponseEntity.ok(result);
    }

    // ---- Personal Statistics ----
    @GetMapping("/settings/stats")
    public ResponseEntity<?> getPersonalStats(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).build();

        long totalSent = chatMessageRepository.countBySenderName(username);
        long totalReceived = chatMessageRepository.countByReceiverName(username);

        Map<String, Long> typeBreakdown = new HashMap<>();
        List<Object[]> typeRows = chatMessageRepository.countByMessageType(username);
        for (Object[] row : typeRows) {
            typeBreakdown.put((String) row[0], (Long) row[1]);
        }

        List<Map<String, Object>> dailyActivity = new ArrayList<>();
        for (int i = 6; i >= 0; i--) {
            LocalDateTime dayStart = LocalDateTime.now().minusDays(i).withHour(0).withMinute(0).withSecond(0).withNano(0);
            LocalDateTime dayEnd = dayStart.plusDays(1);
            long count = chatMessageRepository.countBySenderNameAndTimestampBetween(username, dayStart, dayEnd);
            Map<String, Object> point = new HashMap<>();
            point.put("date", dayStart.format(DateTimeFormatter.ofPattern("yyyy-MM-dd")));
            point.put("count", count);
            dailyActivity.add(point);
        }

        String topPartner = null;
        long topPartnerCount = 0;
        List<Object[]> partnerRows = chatMessageRepository.findTopChatPartner(username, org.springframework.data.domain.PageRequest.of(0, 1));
        if (!partnerRows.isEmpty()) {
            topPartner = (String) partnerRows.get(0)[0];
            topPartnerCount = (Long) partnerRows.get(0)[1];
        }

        long groupsCount = groupMemberRepository.countByUsername(username);
        long sessionsCount = userSessionRepository.findByUserAndIsActiveTrue(user).size();

        Map<String, Object> stats = new HashMap<>();
        stats.put("totalSent", totalSent);
        stats.put("totalReceived", totalReceived);
        stats.put("typeBreakdown", typeBreakdown);
        stats.put("dailyActivity", dailyActivity);
        stats.put("topPartner", topPartner);
        stats.put("topPartnerCount", topPartnerCount);
        stats.put("createdAt", user.getCreatedAt() != null ? user.getCreatedAt().toString() : null);
        stats.put("groupsCount", groupsCount);
        stats.put("sessionsCount", sessionsCount);
        return ResponseEntity.ok(stats);
    }

    // ---- Privacy Settings ----
    @GetMapping("/settings/privacy")
    public ResponseEntity<?> getPrivacySettings(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).build();

        return ResponseEntity.ok(Map.of(
            "contactPrivacy", user.getContactPrivacy() != null ? user.getContactPrivacy() : "everyone",
            "showOnlineStatus", user.isShowOnlineStatus(),
            "sendReadReceipts", user.isSendReadReceipts()
        ));
    }

    @PostMapping("/settings/privacy")
    public ResponseEntity<?> updatePrivacySettings(@RequestBody Map<String, Object> body, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();
        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).build();

        if (body.containsKey("contactPrivacy")) {
            String val = (String) body.get("contactPrivacy");
            if ("everyone".equals(val) || "invitation".equals(val))
                user.setContactPrivacy(val);
        }
        if (body.containsKey("showOnlineStatus"))
            user.setShowOnlineStatus(Boolean.TRUE.equals(body.get("showOnlineStatus")));
        if (body.containsKey("sendReadReceipts"))
            user.setSendReadReceipts(Boolean.TRUE.equals(body.get("sendReadReceipts")));

        userRepository.save(user);
        return ResponseEntity.ok(Map.of("success", true));
    }

    // ---- Danger Zone ----
    @DeleteMapping("/settings/account")
    public ResponseEntity<?> deleteAccount(@RequestBody Map<String, String> body, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        String password = body.get("password");
        if (password == null || password.isBlank())
            return ResponseEntity.badRequest().body(Map.of("error", "Password is required."));

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(404).build();
        if (!passwordEncoder.matches(password, user.getPassword()))
            return ResponseEntity.status(400).body(Map.of("error", "Incorrect password."));

        // Delete all user data
        chatMessageRepository.deleteAllByUser(username);
        userSessionRepository.deleteByUser(user);
        groupMemberRepository.deleteByChatGroup_IdAndUsername(null, username); // handled per-group
        userRepository.delete(user);
        session.invalidate();
        return ResponseEntity.ok(Map.of("success", true));
    }

    @DeleteMapping("/settings/conversations/all")
    public ResponseEntity<?> clearAllConversations(@RequestBody Map<String, String> body, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        String password = body.get("password");
        if (password == null || password.isBlank())
            return ResponseEntity.badRequest().body(Map.of("error", "Password is required."));

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(404).build();
        if (!passwordEncoder.matches(password, user.getPassword()))
            return ResponseEntity.status(400).body(Map.of("error", "Incorrect password."));

        chatMessageRepository.deleteAllByUser(username);
        return ResponseEntity.ok(Map.of("success", true, "message", "All conversations deleted."));
    }

    @GetMapping("/settings/export")
    public ResponseEntity<?> exportData(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(401).build();

        List<ChatMessage> messages = chatMessageRepository.findAllByUser(username);
        List<Map<String, Object>> export = messages.stream().map(m -> {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", m.getId());
            item.put("sender", m.getSenderName());
            item.put("receiver", m.getReceiverName());
            item.put("content", m.getContent());
            item.put("type", m.getMessageType());
            item.put("timestamp", m.getTimestamp() != null ? m.getTimestamp().toString() : null);
            item.put("group", m.getGroup() != null ? m.getGroup().getId() : null);
            item.put("public", m.isPublic());
            return item;
        }).collect(Collectors.toList());

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("exportedAt", LocalDateTime.now().toString());
        data.put("username", username);
        data.put("totalMessages", export.size());
        data.put("messages", export);

        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"chat-export.json\"")
            .contentType(MediaType.APPLICATION_JSON)
            .body(data);
    }

    // ---- Reaction helpers ----

    private boolean canAccessMessage(ChatMessage msg, String username) {
        if (msg.isPublic()) return true;
        if (username.equals(msg.getSenderName())) return true;
        if (username.equals(msg.getReceiverName())) return true;
        if (msg.getGroup() != null) {
            return groupMemberRepository.existsByChatGroup_IdAndUsername(msg.getGroup().getId(), username);
        }
        return false;
    }

    private java.util.List<Map<String, Object>> buildReactionSummary(Long messageId, String currentUser) {
        java.util.List<com.chtsys.ChatSystem.Model.MessageReaction> all =
            messageReactionRepository.findByMessageId(messageId);

        // Group by emoji, count, and track if current user reacted
        java.util.LinkedHashMap<String, long[]> counts = new java.util.LinkedHashMap<>();
        java.util.Set<String> mine = new java.util.HashSet<>();

        for (com.chtsys.ChatSystem.Model.MessageReaction r : all) {
            counts.computeIfAbsent(r.getEmoji(), k -> new long[]{0})[0]++;
            if (r.getUsername().equals(currentUser)) mine.add(r.getEmoji());
        }

        java.util.List<Map<String, Object>> summary = new java.util.ArrayList<>();
        counts.forEach((emoji, cnt) -> {
            Map<String, Object> entry = new java.util.LinkedHashMap<>();
            entry.put("emoji", emoji);
            entry.put("count", cnt[0]);
            entry.put("reactedByMe", mine.contains(emoji));
            summary.add(entry);
        });
        return summary;
    }

    private void broadcastReactionUpdate(ChatMessage msg, Long messageId, String actingUser) {
        com.chtsys.ChatSystem.Model.Message update = new com.chtsys.ChatSystem.Model.Message();
        update.setId(messageId);
        update.setStatus(com.chtsys.ChatSystem.Model.Status.REACTION);
        update.setSenderName(actingUser);

        // Build reaction summary for both participants (reactedByMe differs per user)
        // We broadcast a generic summary; the client will re-fetch or use the payload
        update.setReactions(buildReactionSummary(messageId, actingUser));

        if (msg.isPublic()) {
            messagingTemplate.convertAndSend("/chatroom/public", update);
        } else if (msg.getGroup() != null) {
            Long groupId = msg.getGroup().getId();
            update.setGroupId(groupId);
            for (com.chtsys.ChatSystem.Model.GroupMember member :
                    groupMemberRepository.findByChatGroup_Id(groupId)) {
                // Build per-user summary so reactedByMe is correct for each recipient
                com.chtsys.ChatSystem.Model.Message perUser = new com.chtsys.ChatSystem.Model.Message();
                perUser.setId(messageId);
                perUser.setStatus(com.chtsys.ChatSystem.Model.Status.REACTION);
                perUser.setSenderName(actingUser);
                perUser.setGroupId(groupId);
                perUser.setReactions(buildReactionSummary(messageId, member.getUsername()));
                messagingTemplate.convertAndSendToUser(member.getUsername(), "/private", perUser);
            }
        } else {
            // Private chat: send to both sender and receiver with their own reactedByMe
            String other = actingUser.equals(msg.getSenderName())
                ? msg.getReceiverName() : msg.getSenderName();

            com.chtsys.ChatSystem.Model.Message forActor = new com.chtsys.ChatSystem.Model.Message();
            forActor.setId(messageId);
            forActor.setStatus(com.chtsys.ChatSystem.Model.Status.REACTION);
            forActor.setSenderName(actingUser);
            forActor.setReactions(buildReactionSummary(messageId, actingUser));
            messagingTemplate.convertAndSendToUser(actingUser, "/private", forActor);

            if (other != null) {
                com.chtsys.ChatSystem.Model.Message forOther = new com.chtsys.ChatSystem.Model.Message();
                forOther.setId(messageId);
                forOther.setStatus(com.chtsys.ChatSystem.Model.Status.REACTION);
                forOther.setSenderName(actingUser);
                forOther.setReactions(buildReactionSummary(messageId, other));
                messagingTemplate.convertAndSendToUser(other, "/private", forOther);
            }
        }
    }

    // ---- Admin endpoints ----
    @GetMapping("/admin/users")
    public ResponseEntity<?> getAllUsers(HttpSession session) {
        if (!isAdmin(session)) return ResponseEntity.status(403).build();

        List<UserEntity> users = userRepository.findAll();
        List<Map<String, Object>> result = users.stream().map(u -> {
            Map<String, Object> map = new HashMap<>();
            map.put("username", u.getUsername());
            map.put("email", u.getEmail());
            map.put("fullname", (u.getName() != null ? u.getName() : "") + " " + (u.getSurname() != null ? u.getSurname() : ""));
            map.put("banned", u.isBanned());
            map.put("online", u.isOnline());
            map.put("lastSeen", u.getLastSeenAt() != null ? u.getLastSeenAt().format(LAST_SEEN_FORMAT) : "");
            map.put("messageCount", chatMessageRepository.countBySenderName(u.getUsername()));
            return map;
        }).collect(Collectors.toList());
        return ResponseEntity.ok(result);
    }

    @PostMapping("/admin/ban/{targetUser}")
    public ResponseEntity<?> banUser(@PathVariable String targetUser, HttpSession session) {
        if (!isAdmin(session)) return ResponseEntity.status(403).build();

        UserEntity user = userRepository.findByUsername(targetUser).orElse(null);
        if (user == null) return ResponseEntity.status(404).body("User not found");
        user.setBanned(true);
        userRepository.save(user);
        return ResponseEntity.ok(Map.of("success", true));
    }

    @PostMapping("/admin/unban/{targetUser}")
    public ResponseEntity<?> unbanUser(@PathVariable String targetUser, HttpSession session) {
        if (!isAdmin(session)) return ResponseEntity.status(403).build();

        UserEntity user = userRepository.findByUsername(targetUser).orElse(null);
        if (user == null) return ResponseEntity.status(404).body("User not found");
        user.setBanned(false);
        userRepository.save(user);
        return ResponseEntity.ok(Map.of("success", true));
    }

    @GetMapping("/admin/stats")
    public ResponseEntity<?> getStats(HttpSession session) {
        if (!isAdmin(session)) return ResponseEntity.status(403).build();

        long totalMessages = chatMessageRepository.count();
        long totalUsers = userRepository.count();
        long onlineUsers = userRepository.countByOnlineTrue();
        long totalGroups = chatGroupRepository.count();

        List<Map<String, Object>> messageChart = new ArrayList<>();
        for (int i = 6; i >= 0; i--) {
            LocalDateTime dayStart = LocalDateTime.now().minusDays(i).withHour(0).withMinute(0).withSecond(0).withNano(0);
            LocalDateTime dayEnd = dayStart.plusDays(1);
            long count = chatMessageRepository.countByTimestampBetween(dayStart, dayEnd);
            Map<String, Object> point = new HashMap<>();
            point.put("date", dayStart.format(DateTimeFormatter.ofPattern("MM/dd")));
            point.put("count", count);
            messageChart.add(point);
        }

        Map<String, Object> stats = new HashMap<>();
        stats.put("totalMessages", totalMessages);
        stats.put("totalUsers", totalUsers);
        stats.put("onlineUsers", onlineUsers);
        stats.put("totalGroups", totalGroups);
        stats.put("messageChart", messageChart);
        return ResponseEntity.ok(stats);
    }

    @PostMapping("/admin/announce")
    public ResponseEntity<?> globalAnnounce(@RequestBody Map<String, String> body, HttpSession session) {
        if (!isAdmin(session)) return ResponseEntity.status(403).build();

        String message = body.get("message");
        if (message == null || message.isBlank())
            return ResponseEntity.badRequest().body("Message is required");

        Message ann = new Message();
        ann.setSenderName("System");
        ann.setMessage(cleanText(message, 500).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#x27;"));
        ann.setStatus(Status.MESSAGE);
        ann.setMessageType("TEXT");

        messagingTemplate.convertAndSend("/chatroom/public", ann);
        return ResponseEntity.ok(Map.of("success", true));
    }

    @PostMapping("/messages/forward")
    public ResponseEntity<?> forwardMessage(@RequestBody Map<String, Object> body, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        Long messageId = body.get("messageId") instanceof Number ? ((Number) body.get("messageId")).longValue() : null;
        if (messageId == null) return ResponseEntity.badRequest().body(Map.of("error", "messageId is required"));

        ChatMessage original = chatMessageRepository.findById(messageId).orElse(null);
        if (original == null) return ResponseEntity.status(404).body(Map.of("error", "Original message not found"));

        // Verify the current user can access the original message
        boolean canAccess = original.getSenderName().equals(username)
                || original.getReceiverName() != null && original.getReceiverName().equals(username)
                || original.isPublic();
        if (!canAccess && original.getGroup() != null) {
            canAccess = groupMemberRepository.existsByChatGroup_IdAndUsername(original.getGroup().getId(), username);
        }
        if (!canAccess) return ResponseEntity.status(403).body(Map.of("error", "Access denied to original message"));

        // Prevent forwarding private (1-to-1) messages to the public chat
        boolean isPrivateOneToOne = !original.isPublic() && original.getGroup() == null;

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> targets = (List<Map<String, Object>>) body.get("targets");
        if (targets == null || targets.isEmpty())
            return ResponseEntity.badRequest().body(Map.of("error", "targets is required"));

        List<Map<String, Object>> results = new ArrayList<>();

        for (Map<String, Object> target : targets) {
            String type = (String) target.get("type");
            Object idObj = target.get("id");
            if (type == null || idObj == null) continue;

            // Block forwarding private 1-to-1 messages to public chat
            if (isPrivateOneToOne && "user".equals(type) && "public".equals(idObj)) {
                continue;
            }

            ChatMessage newMsg = new ChatMessage();
            newMsg.setSenderName(username);
            newMsg.setContent(original.getContent());
            newMsg.setMessageType(original.getMessageType() != null ? original.getMessageType() : "TEXT");
            newMsg.setTimestamp(LocalDateTime.now());
            newMsg.setStatus(Status.MESSAGE);
            newMsg.setForwardedFrom(original.getId());

            if ("user".equals(type) && "public".equals(idObj)) {
                newMsg.setPublic(true);
            } else if ("user".equals(type)) {
                String receiver = (String) idObj;
                UserEntity receiverEntity = userRepository.findByUsername(receiver).orElse(null);
                if (receiverEntity == null) continue;
                UserEntity sender = userRepository.findByUsername(username).orElse(null);
                if (sender == null || receiverEntity == null) continue;
                if (userBlockRepository.existsByBlockerAndBlocked(sender, receiverEntity)
                        || userBlockRepository.existsByBlockerAndBlocked(receiverEntity, sender)) continue;
                newMsg.setReceiverName(receiver);
                newMsg.setPublic(false);
            } else if ("group".equals(type)) {
                Long groupId = idObj instanceof Number ? ((Number) idObj).longValue() : Long.parseLong(idObj.toString());
                ChatGroup group = chatGroupRepository.findById(groupId).orElse(null);
                if (group == null) continue;
                if (!groupMemberRepository.existsByChatGroup_IdAndUsername(groupId, username)) continue;
                newMsg.setGroup(group);
                newMsg.setPublic(false);
            } else {
                continue;
            }

            chatMessageRepository.save(newMsg);

            // Broadcast via WebSocket
            Message out = new Message();
            out.setId(newMsg.getId());
            out.setSenderName(username);
            out.setMessage(newMsg.getContent());
            out.setStatus(Status.MESSAGE);
            out.setMessageType(newMsg.getMessageType());
            out.setForwardedFrom(original.getId());

            if (newMsg.isPublic()) {
                messagingTemplate.convertAndSend("/chatroom/public", out);
            } else if (newMsg.getGroup() != null) {
                out.setGroupId(newMsg.getGroup().getId());
                for (GroupMember member : groupMemberRepository.findByChatGroup_Id(newMsg.getGroup().getId())) {
                    messagingTemplate.convertAndSendToUser(member.getUsername(), "/private", out);
                }
            } else {
                messagingTemplate.convertAndSendToUser(newMsg.getReceiverName(), "/private", out);
                messagingTemplate.convertAndSendToUser(username, "/private", out);
            }

            Map<String, Object> result = new HashMap<>();
            result.put("type", type);
            result.put("id", idObj);
            result.put("messageId", newMsg.getId());
            results.add(result);
        }

        return ResponseEntity.ok(Map.of("success", true, "results", results));
    }

    @PostMapping("/messages/{id}/pin")
    public ResponseEntity<?> pinMessage(@PathVariable Long id, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        ChatMessage msg = chatMessageRepository.findById(id).orElse(null);
        if (msg == null) return ResponseEntity.status(404).body(Map.of("error", "Message not found"));

        // Only message author or group admin can pin
        boolean isAdmin = isAdmin(session);
        boolean isAuthor = msg.getSenderName().equals(username);
        boolean isGroupAdmin = false;
        if (msg.getGroup() != null) {
            GroupMember member = groupMemberRepository
                .findByChatGroup_IdAndUsername(msg.getGroup().getId(), username).orElse(null);
            isGroupAdmin = member != null && member.getRole() == com.chtsys.ChatSystem.Model.GroupRole.ADMIN;
        }
        if (!isAuthor && !isAdmin && !isGroupAdmin)
            return ResponseEntity.status(403).body(Map.of("error", "Only the message author or a group admin can pin"));

        // Unpin any previously pinned message in this chat
        unpinExistingInChat(msg);

        // Pin this message
        msg.setPinned(true);
        chatMessageRepository.save(msg);

        return ResponseEntity.ok(Map.of("success", true, "messageId", msg.getId()));
    }

    @PostMapping("/messages/{id}/unpin")
    public ResponseEntity<?> unpinMessage(@PathVariable Long id, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        ChatMessage msg = chatMessageRepository.findById(id).orElse(null);
        if (msg == null) return ResponseEntity.status(404).body(Map.of("error", "Message not found"));

        boolean isAdmin = isAdmin(session);
        boolean isAuthor = msg.getSenderName().equals(username);
        boolean isGroupAdmin = false;
        if (msg.getGroup() != null) {
            GroupMember member = groupMemberRepository
                .findByChatGroup_IdAndUsername(msg.getGroup().getId(), username).orElse(null);
            isGroupAdmin = member != null && member.getRole() == com.chtsys.ChatSystem.Model.GroupRole.ADMIN;
        }
        if (!isAuthor && !isAdmin && !isGroupAdmin)
            return ResponseEntity.status(403).body(Map.of("error", "Only the message author or a group admin can unpin"));

        msg.setPinned(false);
        chatMessageRepository.save(msg);

        return ResponseEntity.ok(Map.of("success", true));
    }

    @GetMapping("/messages/pinned")
    public ResponseEntity<?> getPinnedMessage(
            @RequestParam String type,
            @RequestParam String id,
            HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        Optional<ChatMessage> pinned = Optional.empty();

        if ("public".equals(type)) {
            pinned = chatMessageRepository.findByIsPublicTrueAndPinnedTrue();
        } else if ("group".equals(type)) {
            Long groupId = Long.parseLong(id);
            if (!groupMemberRepository.existsByChatGroup_IdAndUsername(groupId, username))
                return ResponseEntity.status(403).build();
            pinned = chatMessageRepository.findByGroup_IdAndPinnedTrue(groupId);
        } else if ("user".equals(type)) {
            pinned = chatMessageRepository.findPinnedPrivateMessage(username, id);
        }

        if (pinned.isEmpty() || !pinned.get().isPinned())
            return ResponseEntity.ok(Map.of("pinned", false));

        ChatMessage m = pinned.get();
        Map<String, Object> result = new HashMap<>();
        result.put("pinned", true);
        result.put("id", m.getId());
        result.put("senderName", m.getSenderName());
        result.put("content", m.getContent());
        result.put("messageType", m.getMessageType());

        if (m.getGroup() != null) {
            result.put("groupId", m.getGroup().getId());
        }

        return ResponseEntity.ok(result);
    }

    private static final Set<String> ALLOWED_MIME_TYPES = Set.of(
        // Images
        "image/png", "image/jpeg", "image/webp", "image/gif",
        // Documents
        "application/pdf", "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain", "text/csv",
        // Spreadsheets
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        // Presentations
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        // Archives
        "application/zip", "application/x-rar-compressed", "application/x-7z-compressed",
        "application/gzip",
        // Audio
        "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm",
        // Video
        "video/mp4", "video/webm", "video/ogg"
    );

    @PostMapping("/upload")
    public ResponseEntity<?> uploadFile(
            @RequestParam("file") MultipartFile file,
            @RequestParam(required = false) String to,
            @RequestParam(required = false) Long groupId,
            HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        if (file.isEmpty())
            return ResponseEntity.badRequest().body(Map.of("error", "File is empty"));

        if (file.getSize() > maxFileBytes)
            return ResponseEntity.badRequest().body(Map.of("error", "File exceeds maximum size of 8 MB"));

        String mimeType = file.getContentType();
        // Strip any parameters (e.g. "audio/webm;codecs=opus" -> "audio/webm")
        String baseMime = mimeType != null ? mimeType.replaceAll(";.*", "").trim() : null;
        if (baseMime == null || !ALLOWED_MIME_TYPES.contains(baseMime))
            return ResponseEntity.badRequest().body(Map.of("error", "File type not allowed: " + mimeType));

        // Sanitize original filename
        String originalName = file.getOriginalFilename();
        if (originalName == null || originalName.isBlank()) originalName = "unnamed";
        originalName = originalName.replaceAll("[^a-zA-Z0-9._-]", "_");
        if (originalName.length() > 200) originalName = originalName.substring(0, 200);

        // Generate unique filename on disk
        String uuid = java.util.UUID.randomUUID().toString();
        String extension = "";
        int dot = originalName.lastIndexOf('.');
        if (dot > 0) extension = originalName.substring(dot);
        String storedName = uuid + extension;

        try {
            Path uploadDir = Paths.get("uploads");
            Files.createDirectories(uploadDir);
            Path targetPath = uploadDir.resolve(storedName);
            file.transferTo(targetPath);

            // Record access info
            boolean isPublic = false;
            String receiverUsername = null;
            Long accessGroupId = groupId;

            if (groupId != null) {
                isPublic = false;
            } else if (to != null && to.equals("public")) {
                isPublic = true;
            } else if (to != null) {
                receiverUsername = to;
            }

            FileRecord fr = new FileRecord();
            fr.setStoredName(storedName);
            fr.setSenderUsername(username);
            fr.setReceiverUsername(receiverUsername);
            fr.setGroupId(accessGroupId);
            fr.setPublic(isPublic);
            fileRecordRepository.save(fr);

            Map<String, Object> result = new HashMap<>();
            result.put("url", "/uploads/" + storedName);
            result.put("fileName", originalName);
            result.put("fileSize", file.getSize());
            result.put("mimeType", mimeType);
            return ResponseEntity.ok(result);
        } catch (IOException e) {
            return ResponseEntity.internalServerError().body(Map.of("error", "File upload failed: " + e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", "Upload error: " + e.getClass().getSimpleName() + " - " + e.getMessage()));
        }
    }

    @GetMapping("/user/{username}/profile")
    public ResponseEntity<?> getUserProfile(@PathVariable String username, HttpSession session) {
        String sessionUsername = (String) session.getAttribute("username");
        if (sessionUsername == null) return ResponseEntity.status(401).build();

        UserEntity user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return ResponseEntity.status(404).build();

        Map<String, Object> profile = new HashMap<>();
        profile.put("username", user.getUsername());
        profile.put("fullname", user.getName() + " " + user.getSurname());
        profile.put("online", user.isOnline());
        if (user.getProfilePicture() != null) {
            profile.put("profilePicture", user.getProfilePicture());
        }
        return ResponseEntity.ok(profile);
    }
}
