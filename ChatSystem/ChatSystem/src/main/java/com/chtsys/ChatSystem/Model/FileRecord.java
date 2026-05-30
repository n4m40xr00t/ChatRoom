package com.chtsys.ChatSystem.Model;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

@Entity
@Table(name = "file_records")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class FileRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String storedName;

    @Column(nullable = false)
    private String senderUsername;

    @Column
    private String receiverUsername;

    @Column
    private Long groupId;

    @Column(nullable = false)
    private boolean isPublic;
}
