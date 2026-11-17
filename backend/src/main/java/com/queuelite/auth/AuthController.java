package com.queuelite.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.queuelite.config.AppConfig;
import com.queuelite.web.ApiResponse;
import com.queuelite.web.RateLimited;
import com.queuelite.web.RateLimiter.Budget;
import com.queuelite.web.StaffOnly;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private static final Logger log = LoggerFactory.getLogger(AuthController.class);

    private final AuthService auth;
    private final AppConfig config;

    public AuthController(AuthService auth, AppConfig config) {
        this.auth = auth;
        this.config = config;
    }

    @PostMapping("/login")
    @RateLimited(Budget.LOGIN)
    public ResponseEntity<?> login(@RequestBody(required = false) JsonNode body, HttpServletRequest request) {
        if (!auth.verifyPasscode(text(body, "passcode"))) {
            log.warn("failed staff login ip={}", request.getRemoteAddr());
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(ApiResponse.error("Incorrect passcode"));
        }

        log.info("staff signed in ip={}", request.getRemoteAddr());

        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, auth.sessionCookie(auth.issueSession("passcode")).toString())
                .body(ApiResponse.ok(Map.of("clinic_slug", config.clinicSlug())));
    }

    /**
     * Break-glass sign-in with the recovery code. A second door into patient
     * data, so it is deliberately narrow: hard rate limited, constant-time
     * compared, absent entirely when no code is configured, and loudly logged.
     */
    @PostMapping("/recover")
    @RateLimited(Budget.RECOVERY)
    public ResponseEntity<?> recover(@RequestBody(required = false) JsonNode body, HttpServletRequest request) {
        if (!auth.isRecoveryEnabled()) {
            // 404 rather than 403: an endpoint that is switched off should not
            // confirm that it exists and might work with the right input.
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiResponse.error("Not found"));
        }

        if (!auth.verifyRecoveryCode(text(body, "code"))) {
            log.warn("failed recovery sign-in ip={}", request.getRemoteAddr());
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(ApiResponse.error("Incorrect recovery code"));
        }

        log.warn("staff signed in with the RECOVERY CODE ip={}", request.getRemoteAddr());

        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, auth.sessionCookie(auth.issueSession("recovery")).toString())
                .body(ApiResponse.ok(Map.of("clinic_slug", config.clinicSlug(), "via", "recovery")));
    }

    @PostMapping("/logout")
    public ResponseEntity<?> logout() {
        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, auth.clearedCookie().toString())
                .body(ApiResponse.ok(Map.of("signed_out", true)));
    }

    @GetMapping("/session")
    @StaffOnly
    public ApiResponse<?> session(@RequestAttribute(StaffSession.REQUEST_ATTRIBUTE) StaffSession staff) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("signed_in", true);
        data.put("clinic_slug", staff.clinic());
        data.put("via", staff.via() == null ? "passcode" : staff.via());
        data.put("recovery_available", auth.isRecoveryEnabled());
        return ApiResponse.ok(data);
    }

    // A passcode that arrives as a number or an object is a wrong passcode, not
    // a crash, so anything but a JSON string is passed on as a non-string.
    private static Object text(JsonNode body, String field) {
        if (body == null || !body.has(field)) {
            return null;
        }
        JsonNode value = body.get(field);
        return value.isTextual() ? value.asText() : Boolean.FALSE;
    }
}
