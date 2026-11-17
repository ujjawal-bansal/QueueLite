package com.queuelite.web;

import com.fasterxml.jackson.annotation.JsonInclude;

/** Every response is { success, data } or { success, error }. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ApiResponse<T>(boolean success, T data, String error, String message) {

    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(true, data, null, null);
    }

    public static ApiResponse<Void> error(String error) {
        return new ApiResponse<>(false, null, error, null);
    }
}
