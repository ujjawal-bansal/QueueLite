package com.queuelite.auth;

/** What a signed staff cookie says about its holder. */
public record StaffSession(String role, String clinic, String via) {

    public static final String REQUEST_ATTRIBUTE = "queuelite.staff";
}
