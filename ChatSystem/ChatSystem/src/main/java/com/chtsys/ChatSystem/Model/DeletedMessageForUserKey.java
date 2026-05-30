package com.chtsys.ChatSystem.Model;

import jakarta.persistence.Embeddable;
import lombok.*;
import java.io.Serializable;

@Embeddable
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode
public class DeletedMessageForUserKey implements Serializable {
    private Long messageId;
    private String username;
}
