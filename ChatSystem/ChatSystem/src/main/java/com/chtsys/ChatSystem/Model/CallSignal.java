package com.chtsys.ChatSystem.Model;

import lombok.*;

/**
 * WebRTC signaling message for peer-to-peer call setup.
 * Carries SDP offers/answers and ICE candidates between peers.
 */
@Getter
@Setter
@AllArgsConstructor
@NoArgsConstructor
@ToString
public class CallSignal {
    
    /** Unique identifier for this call session */
    private String callId;
    
    /** Username of the caller (initiator) */
    private String caller;
    
    /** Username of the callee (receiver) */
    private String callee;
    
    /** Type of call: "audio" or "video" */
    private String callType;
    
    /** Signal type: CALL_OFFER, CALL_ANSWER, CALL_ICE_CANDIDATE, etc. */
    private Status signalType;
    
    /** SDP (Session Description Protocol) offer or answer */
    private String sdp;
    
    /** ICE candidate data for NAT traversal */
    private IceCandidate iceCandidate;
    
    /** Optional error message */
    private String errorMessage;
    
    /** Timestamp of the signal */
    private String timestamp;
    
    /** For group calls: group ID */
    private Long groupId;
    
    /**
     * ICE Candidate structure for WebRTC connection establishment
     */
    @Getter
    @Setter
    @AllArgsConstructor
    @NoArgsConstructor
    @ToString
    public static class IceCandidate {
        private String candidate;
        private String sdpMid;
        private Integer sdpMLineIndex;
    }
}
