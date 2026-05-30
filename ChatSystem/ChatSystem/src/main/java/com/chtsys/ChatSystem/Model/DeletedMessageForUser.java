package com.chtsys.ChatSystem.Model;

import jakarta.persistence.*;
import lombok.*;

@Entity
@Table(name = "deleted_messages_for_user")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class DeletedMessageForUser {

    @EmbeddedId
    private DeletedMessageForUserKey id;
}
