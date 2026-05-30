package com.chtsys.ChatSystem.Model;

public enum Status {
    JOIN,
    MESSAGE,
    LEAVE,
    EDIT,
    DELETE,
    BULK_DELETE,
    DELIVERED,
    READ,
    ONLINE,
    OFFLINE,
    TYPING,
    REACTION,

    // WebRTC Call Signaling
    CALL_OFFER,           // Initiating a call with SDP offer
    CALL_ANSWER,          // Answering a call with SDP answer
    CALL_ICE_CANDIDATE,   // Exchanging ICE candidates
    CALL_RINGING,         // Call is ringing on receiver's end
    CALL_ACCEPTED,        // Call was accepted
    CALL_REJECTED,        // Call was rejected
    CALL_END,             // Client sends this to request ending a call (→ /app/call-end)
    CALL_ENDED,           // Server broadcasts this to both parties once the call is over
    CALL_BUSY,            // Receiver is already in a call
    CALL_UNAVAILABLE,     // Receiver is offline or unavailable
    CALL_TIMEOUT,         // Call wasn't answered in time
    CALL_ERROR            // Error during call setup
}
