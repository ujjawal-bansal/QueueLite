package com.queuelite.auth;

import com.queuelite.config.AppConfig;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.http.ResponseCookie;
import org.springframework.stereotype.Service;

@Service
public class AuthService {

    public static final String SESSION_COOKIE = "ql_session";

    private final AppConfig config;
    private final Clock clock;
    private final SecretKey key;

    public AuthService(AppConfig config, Clock clock) {
        this.config = config;
        this.clock = clock;
        this.key = new SecretKeySpec(config.sessionSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256");
    }

    public boolean verifyPasscode(Object passcode) {
        return Scrypt.verify(passcode, config.staffPasscodeHash(), "STAFF_PASSCODE_HASH");
    }

    public boolean isRecoveryEnabled() {
        return !config.staffRecoveryCodeHash().isEmpty();
    }

    /**
     * The break-glass code. False rather than an exception when none is
     * configured, so a deployment that never set one simply has no second door.
     */
    public boolean verifyRecoveryCode(Object code) {
        if (!isRecoveryEnabled()) {
            return false;
        }
        return Scrypt.verify(code, config.staffRecoveryCodeHash(), "STAFF_RECOVERY_CODE_HASH");
    }

    /**
     * An HS256 JWT with the same claims the Node API issued, so a desk that was
     * signed in before the switch stays signed in after it.
     *
     * {@code via} records how the session was obtained, so the dashboard can
     * keep telling staff they are on the break-glass code.
     */
    public String issueSession(String via) {
        Instant now = clock.instant();
        return Jwts.builder()
                .claim("role", "staff")
                .claim("clinic", config.clinicSlug())
                .claim("via", via)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(sessionTtl())))
                .signWith(key, Jwts.SIG.HS256)
                .compact();
    }

    public StaffSession readSession(String token) {
        if (token == null || token.isEmpty()) {
            return null;
        }
        try {
            Claims claims = Jwts.parser()
                    .verifyWith(key)
                    .clock(() -> Date.from(clock.instant()))
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
            return new StaffSession(
                    claims.get("role", String.class),
                    claims.get("clinic", String.class),
                    claims.get("via", String.class));
        } catch (JwtException | IllegalArgumentException error) {
            return null;
        }
    }

    public ResponseCookie sessionCookie(String value) {
        return cookie(value, sessionTtl());
    }

    public ResponseCookie clearedCookie() {
        return cookie("", Duration.ZERO);
    }

    private ResponseCookie cookie(String value, Duration maxAge) {
        return ResponseCookie.from(SESSION_COOKIE, value)
                .httpOnly(true)
                .secure(config.isProduction())
                .sameSite(config.isProduction() ? "None" : "Lax")
                .maxAge(maxAge)
                .path("/")
                .build();
    }

    private Duration sessionTtl() {
        return Duration.ofSeconds(Math.round(config.sessionTtlHours() * 3600));
    }
}
