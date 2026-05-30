package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.GroupMember;
import com.chtsys.ChatSystem.Model.GroupRole;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

@Repository
public interface GroupMemberRepository extends JpaRepository<GroupMember, Long> {
    List<GroupMember> findByUsername(String username);

    List<GroupMember> findByChatGroup_Id(Long groupId);

    Optional<GroupMember> findByChatGroup_IdAndUsername(Long groupId, String username);

    boolean existsByChatGroup_IdAndUsername(Long groupId, String username);

    long countByChatGroup_Id(Long groupId);

    long countByChatGroup_IdAndRole(Long groupId, GroupRole role);

    long countByUsername(String username);

    @Modifying
    @Transactional
    void deleteByChatGroup_Id(Long groupId);

    @Modifying
    @Transactional
    void deleteByChatGroup_IdAndUsername(Long groupId, String username);
}
