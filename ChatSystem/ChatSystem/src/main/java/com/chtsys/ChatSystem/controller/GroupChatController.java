package com.chtsys.ChatSystem.controller;

import com.chtsys.ChatSystem.Model.*;
import com.chtsys.ChatSystem.Model.MessageReadReceipt;
import com.chtsys.ChatSystem.repository.*;
import jakarta.servlet.http.HttpSession;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.web.bind.annotation.*;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api")
@Transactional
public class GroupChatController {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private ContactRepository contactRepository;

    @Autowired
    private ChatGroupRepository chatGroupRepository;

    @Autowired
    private GroupMemberRepository groupMemberRepository;

    @Autowired
    private ChatMessageRepository chatMessageRepository;

    @Autowired
    private SimpMessagingTemplate simpMessagingTemplate;

    @Autowired
    private InvitationRepository invitationRepository;

    @Autowired
    private ChatLockRepository chatLockRepository;

    @Autowired
    private com.chtsys.ChatSystem.repository.MessageReactionRepository messageReactionRepository;

    @Autowired
    private com.chtsys.ChatSystem.repository.MessageReadReceiptRepository messageReadReceiptRepository;

    @SuppressWarnings("unchecked")
    private boolean isUnlocked(HttpSession session, String key) {
        Set<String> unlocked = (Set<String>) session.getAttribute("unlockedChats");
        return unlocked != null && unlocked.contains(key);
    }

    /** Trims, strips HTML tags and control chars, truncates to maxLength. */
    private String cleanText(String value, int maxLength) {
        if (value == null) return null;
        String cleaned = value.trim()
            .replaceAll("<[^>]*>", "")
            .replaceAll("[\\p{Cntrl}&&[^\r\n\t]]", "");
        return cleaned.length() > maxLength ? cleaned.substring(0, maxLength) : cleaned;
    }

    @GetMapping("/groups")
    public ResponseEntity<?> listMyGroups(HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        List<ChatLock> userLocks = chatLockRepository.findByOwnerUsername(username);
        Set<Long> lockedGroups = userLocks.stream()
                .filter(l -> l.getTargetGroupId() != null)
                .map(ChatLock::getTargetGroupId)
                .collect(Collectors.toSet());

        List<GroupMember> memberships = groupMemberRepository.findByUsername(username);
        List<Map<String, Object>> out = new ArrayList<>();
        for (GroupMember gm : memberships) {
            ChatGroup g = gm.getChatGroup();
            Map<String, Object> row = new HashMap<>();
            row.put("id", g.getId());
            row.put("name", g.getName());
            if (g.getPicture() != null) row.put("picture", g.getPicture());
            row.put("myRole", gm.getRole().name());
            row.put("locked", lockedGroups.contains(g.getId()));
            out.add(row);
        }
        return ResponseEntity.ok(out);
    }

    @PostMapping("/groups")
    public ResponseEntity<?> createGroup(@RequestBody Map<String, Object> body, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        UserEntity creator = userRepository.findByUsername(username).orElse(null);
        if (creator == null) return ResponseEntity.status(401).build();

        Object nameRaw = body.get("name");
        if (nameRaw == null || nameRaw.toString().isBlank()) {
            return ResponseEntity.badRequest().body("Group name required");
        }
        // SECURITY: sanitize to strip control chars and cap length
        String name = cleanText(nameRaw.toString(), 80);
        if (name == null || name.isBlank()) {
            return ResponseEntity.badRequest().body("Group name required");
        }

        String picture = null;
        Object pic = body.get("picture");
        if (pic instanceof String s && !s.isBlank()) {
            picture = s;
            if (picture.length() > 6_000_000) {
                return ResponseEntity.badRequest().body("Picture is too large");
            }
        }

        @SuppressWarnings("unchecked")
        List<String> memberUsernames = (List<String>) body.getOrDefault("memberUsernames", Collections.emptyList());
        Set<String> toAdd = new LinkedHashSet<>();
        if (memberUsernames != null) {
            for (String u : memberUsernames) {
                if (u == null || u.isBlank()) continue;
                if (u.equals(username)) continue;
                toAdd.add(u.trim());
            }
        }

        for (String mu : toAdd) {
            UserEntity invited = userRepository.findByUsername(mu).orElse(null);
            if (invited == null || !contactRepository.existsByOwnerAndContactUser(creator, invited)) {
                return ResponseEntity.badRequest().body("One or more users cannot be added.");
            }
        }

        ChatGroup group = new ChatGroup();
        group.setName(name);
        group.setPicture(picture);
        group.setCreatedByUsername(username);
        group.setCreatedAt(LocalDateTime.now());
        chatGroupRepository.save(group);

        GroupMember admin = new GroupMember();
        admin.setChatGroup(group);
        admin.setUsername(username);
        admin.setRole(GroupRole.ADMIN);
        groupMemberRepository.save(admin);

        for (String mu : toAdd) {
            GroupMember m = new GroupMember();
            m.setChatGroup(group);
            m.setUsername(mu);
            m.setRole(GroupRole.MEMBER);
            groupMemberRepository.save(m);
        }

        return ResponseEntity.ok(Map.of(
                "id", group.getId(),
                "name", group.getName(),
                "myRole", GroupRole.ADMIN.name()));
    }

    @GetMapping("/groups/{id}")
    public ResponseEntity<?> getGroup(@PathVariable Long id, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        Optional<GroupMember> meOpt = groupMemberRepository.findByChatGroup_IdAndUsername(id, username);
        if (meOpt.isEmpty()) return ResponseEntity.status(403).build();

        ChatGroup g = chatGroupRepository.findById(id).orElse(null);
        if (g == null) return ResponseEntity.status(404).build();

        List<Map<String, Object>> members = groupMemberRepository.findByChatGroup_Id(id).stream()
                .map(m -> {
                    Map<String, Object> mm = new HashMap<>();
                    mm.put("username", m.getUsername());
                    mm.put("role", m.getRole().name());
                    return mm;
                })
                .collect(Collectors.toList());

        Map<String, Object> dto = new HashMap<>();
        dto.put("id", g.getId());
        dto.put("name", g.getName());
        if (g.getPicture() != null) dto.put("picture", g.getPicture());
        dto.put("createdByUsername", g.getCreatedByUsername());
        dto.put("myRole", meOpt.get().getRole().name());
        dto.put("members", members);
        if (g.getCreatedAt() != null) {
            dto.put("createdAt", g.getCreatedAt().format(DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm")));
        }
        return ResponseEntity.ok(dto);
    }

    @PatchMapping("/groups/{id}")
    public ResponseEntity<?> patchGroup(@PathVariable Long id, @RequestBody Map<String, Object> body,
                                        HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        Optional<GroupMember> meOpt = groupMemberRepository.findByChatGroup_IdAndUsername(id, username);
        if (meOpt.isEmpty()) return ResponseEntity.status(403).build();
        if (meOpt.get().getRole() != GroupRole.ADMIN) return ResponseEntity.status(403).body("Admin only");

        ChatGroup g = chatGroupRepository.findById(id).orElse(null);
        if (g == null) return ResponseEntity.notFound().build();

        Object n = body.get("name");
        if (n instanceof String ns && !ns.isBlank()) {
            // SECURITY: sanitize group name on update
            String cleaned = cleanText(ns, 80);
            if (cleaned != null && !cleaned.isBlank()) g.setName(cleaned);
        }

        Object pic = body.get("picture");
        if (pic instanceof String s && !s.isBlank()) {
            if (s.length() > 6_000_000) return ResponseEntity.badRequest().body("Picture is too large");
            g.setPicture(s);
        }

        chatGroupRepository.save(g);
        return ResponseEntity.ok(Map.of("success", true));
    }

    @PostMapping("/groups/{id}/members")
    public ResponseEntity<?> addMember(@PathVariable Long id, @RequestBody Map<String, String> body,
                                       HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        Optional<GroupMember> meOpt = groupMemberRepository.findByChatGroup_IdAndUsername(id, username);
        if (meOpt.isEmpty()) return ResponseEntity.status(403).build();
        if (meOpt.get().getRole() != GroupRole.ADMIN) return ResponseEntity.status(403).body("Admin only");

        String newUser = body.get("username");
        if (newUser == null || newUser.isBlank()) return ResponseEntity.badRequest().body("username required");

        UserEntity admin = userRepository.findByUsername(username).orElse(null);
        UserEntity invitee = userRepository.findByUsername(newUser.trim()).orElse(null);
        if (admin == null || invitee == null) return ResponseEntity.badRequest().body("User not found");

        if (groupMemberRepository.existsByChatGroup_IdAndUsername(id, invitee.getUsername())) {
            return ResponseEntity.badRequest().body("Already a member");
        }

        if (!contactRepository.existsByOwnerAndContactUser(admin, invitee)) {
            return ResponseEntity.status(403).body("You can only add users from your contacts");
        }

        GroupMember m = new GroupMember();
        m.setChatGroup(chatGroupRepository.getReferenceById(id));
        m.setUsername(invitee.getUsername());
        m.setRole(GroupRole.MEMBER);
        groupMemberRepository.save(m);

        postGroupSystemMessage(id, invitee.getUsername() + " joined the group", "SYSTEM_JOIN");
        return ResponseEntity.ok(Map.of("success", true));
    }

    @DeleteMapping("/groups/{id}/members/{memberUsername:.+}")
    public ResponseEntity<?> removeMember(@PathVariable Long id, @PathVariable String memberUsername,
                                          HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        Optional<GroupMember> adminOpt = groupMemberRepository.findByChatGroup_IdAndUsername(id, username);
        if (adminOpt.isEmpty()) return ResponseEntity.status(403).build();
        if (adminOpt.get().getRole() != GroupRole.ADMIN) return ResponseEntity.status(403).body("Admin only");

        if (memberUsername.equals(username)) {
            return ResponseEntity.badRequest().body("Use Leave to remove yourself");
        }

        Optional<GroupMember> targetOpt = groupMemberRepository.findByChatGroup_IdAndUsername(id, memberUsername);
        if (targetOpt.isEmpty()) return ResponseEntity.status(404).body("Member not found");

        if (targetOpt.get().getRole() == GroupRole.ADMIN && groupMemberRepository.countByChatGroup_IdAndRole(id, GroupRole.ADMIN) == 1) {
            return ResponseEntity.badRequest().body("Cannot remove the only admin");
        }

        groupMemberRepository.deleteByChatGroup_IdAndUsername(id, memberUsername);

        postGroupSystemMessage(id, memberUsername + " was removed from the group", "SYSTEM_LEAVE");
        maybeDeleteEmptyGroup(id);
        return ResponseEntity.ok(Map.of("success", true));
    }

    @PostMapping("/groups/{id}/leave")
    public ResponseEntity<?> leaveGroup(@PathVariable Long id, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        Optional<GroupMember> meOpt = groupMemberRepository.findByChatGroup_IdAndUsername(id, username);
        if (meOpt.isEmpty()) return ResponseEntity.status(403).build();

        GroupMember me = meOpt.get();
        List<GroupMember> allOthers = groupMemberRepository.findByChatGroup_Id(id).stream()
                .filter(gm -> !gm.getUsername().equals(username))
                .sorted(Comparator.comparing(GroupMember::getId))
                .collect(Collectors.toList());

        boolean soleAdminLeaving = me.getRole() == GroupRole.ADMIN
                && groupMemberRepository.countByChatGroup_IdAndRole(id, GroupRole.ADMIN) == 1;

        if (soleAdminLeaving && !allOthers.isEmpty()) {
            GroupMember promoted = allOthers.get(0);
            promoted.setRole(GroupRole.ADMIN);
            groupMemberRepository.save(promoted);
        }

        groupMemberRepository.delete(me);

        postGroupSystemMessage(id, username + " left the group", "SYSTEM_LEAVE");
        maybeDeleteEmptyGroup(id);
        return ResponseEntity.ok(Map.of("success", true));
    }

    private void maybeDeleteEmptyGroup(Long groupId) {
        if (groupMemberRepository.countByChatGroup_Id(groupId) > 0) return;
        chatMessageRepository.deleteByGroup_Id(groupId);
        groupMemberRepository.deleteByChatGroup_Id(groupId);
        chatGroupRepository.deleteById(groupId);
    }

    private void postGroupSystemMessage(Long groupId, String content, String messageType) {
        ChatGroup g = chatGroupRepository.findById(groupId).orElse(null);
        if (g == null) return;

        ChatMessage sysMsg = new ChatMessage();
        sysMsg.setSenderName("System");
        sysMsg.setContent(content);
        sysMsg.setTimestamp(LocalDateTime.now());
        sysMsg.setStatus(Status.MESSAGE);
        sysMsg.setPublic(false);
        sysMsg.setMessageType(messageType);
        sysMsg.setGroup(g);
        chatMessageRepository.save(sysMsg);

        Message outbound = new Message();
        outbound.setId(sysMsg.getId());
        outbound.setSenderName("System");
        outbound.setMessage(content);
        outbound.setMessageType(messageType);
        outbound.setStatus(Status.MESSAGE);
        outbound.setGroupId(groupId);

        for (GroupMember member : groupMemberRepository.findByChatGroup_Id(groupId)) {
            simpMessagingTemplate.convertAndSendToUser(member.getUsername(), "/private", outbound);
        }
    }

    private java.util.List<Map<String, Object>> buildReactionSummary(Long messageId, String currentUser) {
        java.util.List<com.chtsys.ChatSystem.Model.MessageReaction> all =
            messageReactionRepository.findByMessageId(messageId);
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

    // ---- Group Invite Link ----
    @PostMapping("/groups/{id}/invite")
    public ResponseEntity<?> generateGroupInvite(@PathVariable Long id, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        Optional<GroupMember> me = groupMemberRepository.findByChatGroup_IdAndUsername(id, username);
        if (me.isEmpty()) return ResponseEntity.status(403).build();

        ChatGroup g = chatGroupRepository.findById(id).orElse(null);
        if (g == null) return ResponseEntity.status(404).build();

        Invitation invite = new Invitation();
        invite.setInviter(userRepository.findByUsername(username).orElse(null));
        invite.setToken(UUID.randomUUID().toString());
        invite.setCreatedAt(LocalDateTime.now());
        invite.setExpiresAt(LocalDateTime.now().plusDays(7));
        invite.setUsed(false);
        invite.setGroupId(id);
        invitationRepository.save(invite);

        return ResponseEntity.ok(Map.of("token", invite.getToken(), "groupId", id));
    }

    /**
     * Sets the maximum number of uses for a group invite link.
     * Only group admins can set this limit.
     * Body: { "inviteToken": "...", "maxUses": 5 }
     * If maxUses is 0, the invite has unlimited uses.
     */
    @PostMapping("/groups/{groupId}/invite/limit")
    public ResponseEntity<?> setInviteLimit(@PathVariable Long groupId,
                                            @RequestBody Map<String, Object> body,
                                            HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        Optional<GroupMember> me = groupMemberRepository.findByChatGroup_IdAndUsername(groupId, username);
        if (me.isEmpty() || me.get().getRole() != GroupRole.ADMIN)
            return ResponseEntity.status(403).body("Admin only");

        String token = (String) body.get("inviteToken");
        if (token == null || token.isBlank())
            return ResponseEntity.badRequest().body("inviteToken required");

        int maxUses;
        try {
            maxUses = ((Number) body.get("maxUses")).intValue();
        } catch (Exception e) {
            return ResponseEntity.badRequest().body("maxUses must be a number (0 = unlimited)");
        }
        if (maxUses < 0) return ResponseEntity.badRequest().body("maxUses cannot be negative");

        Invitation invite = invitationRepository.findByToken(token).orElse(null);
        if (invite == null) return ResponseEntity.status(404).body("Invite not found");
        if (!groupId.equals(invite.getGroupId()))
            return ResponseEntity.badRequest().body("Invite does not belong to this group");

        invite.setMaxUses(Integer.valueOf(maxUses));
        invitationRepository.save(invite);

        return ResponseEntity.ok(Map.of("success", true, "maxUses", maxUses));
    }

    // Accept group invite via REST (called from invite page)
    @PostMapping("/groups/invite/accept/{token}")
    public ResponseEntity<?> acceptGroupInvite(@PathVariable String token, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).body("Not logged in");

        Invitation invite = invitationRepository.findByToken(token).orElse(null);
        if (invite == null) return ResponseEntity.status(404).body("Invalid invite");
        if (invite.getGroupId() == null) return ResponseEntity.status(400).body("Not a group invite");

        // Check expiration
        if (invite.getExpiresAt() != null && invite.getExpiresAt().isBefore(java.time.LocalDateTime.now()))
            return ResponseEntity.status(410).body("Invitation link has expired");

        // Check usage limit
        int maxUses = invite.getMaxUses() != null ? invite.getMaxUses() : 0;
        int useCount = invite.getUseCount() != null ? invite.getUseCount() : 0;
        if (maxUses > 0 && useCount >= maxUses) {
            return ResponseEntity.status(410).body("This invite link has reached its usage limit and is no longer valid");
        }

        Long groupId = invite.getGroupId();
        ChatGroup g = chatGroupRepository.findById(groupId).orElse(null);
        if (g == null) return ResponseEntity.status(404).body("Group not found");

        if (groupMemberRepository.existsByChatGroup_IdAndUsername(groupId, username)) {
            return ResponseEntity.badRequest().body("You are already a member of this group");
        }

        GroupMember member = new GroupMember();
        member.setChatGroup(g);
        member.setUsername(username);
        member.setRole(GroupRole.MEMBER);
        groupMemberRepository.save(member);

        // Increment use count
        invite.setUseCount((invite.getUseCount() != null ? invite.getUseCount() : 0) + 1);
        invitationRepository.save(invite);

        postGroupSystemMessage(groupId, username + " joined the group via invite", "SYSTEM_JOIN");

        return ResponseEntity.ok(Map.of("success", true, "groupId", groupId, "groupName", g.getName()));
    }

    @GetMapping("/messages/group/{groupId}")
    public ResponseEntity<?> groupHistory(@PathVariable Long groupId, HttpSession session) {
        String username = (String) session.getAttribute("username");
        if (username == null) return ResponseEntity.status(401).build();

        if (!groupMemberRepository.existsByChatGroup_IdAndUsername(groupId, username)) {
            return ResponseEntity.status(403).build();
        }

        boolean locked = chatLockRepository.findByOwnerUsernameAndTargetGroupId(username, groupId).isPresent();
        if (locked && !isUnlocked(session, "GROUP_" + groupId)) {
            return ResponseEntity.status(403).body(Map.of("locked", true));
        }

        List<ChatMessage> messages = chatMessageRepository.findByGroup_IdOrderByTimestampAsc(groupId);
        List<Map<String, Object>> response = messages.stream().map(m -> {
            Map<String, Object> map = new HashMap<>();
            map.put("id", m.getId());
            map.put("senderName", m.getSenderName());
            map.put("content", m.getContent());
            map.put("messageType", m.getMessageType());
            map.put("edited", m.isEdited());
            map.put("groupId", groupId);
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
            // Include read receipt info for group messages
            if (username.equals(m.getSenderName())) {
                List<MessageReadReceipt> receipts = messageReadReceiptRepository.findByMessageId(m.getId());
                map.put("readBy", receipts.stream().map(r -> r.getUsername()).collect(java.util.stream.Collectors.toList()));
            }
            return map;
        }).collect(Collectors.toList());

        return ResponseEntity.ok(response);
    }
}
