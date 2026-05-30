package com.chtsys.ChatSystem.repository;

import com.chtsys.ChatSystem.Model.Contact;
import com.chtsys.ChatSystem.Model.UserEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface ContactRepository extends JpaRepository<Contact, Long> {
    List<Contact> findByOwner(UserEntity owner);
    boolean existsByOwnerAndContactUser(UserEntity owner, UserEntity contactUser);
}
