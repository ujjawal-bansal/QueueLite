package com.queuelite.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.queuelite.auth.AuthService;
import com.queuelite.auth.StaffSession;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * Applies {@link StaffOnly} and {@link RateLimited}, in that order: a request
 * without a session is turned away before it spends any of the shared budget.
 */
@Component
public class GuardInterceptor implements HandlerInterceptor {

    private final AuthService auth;
    private final RateLimiter limiter;
    private final ObjectMapper json;

    public GuardInterceptor(AuthService auth, RateLimiter limiter, ObjectMapper json) {
        this.auth = auth;
        this.limiter = limiter;
        this.json = json;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler)
            throws IOException {
        if (!(handler instanceof HandlerMethod method)) {
            return true;
        }

        if (method.hasMethodAnnotation(StaffOnly.class)) {
            StaffSession session = auth.readSession(sessionCookie(request));

            if (session == null || !"staff".equals(session.role())) {
                return reject(response, 401, "Not signed in");
            }

            request.setAttribute(StaffSession.REQUEST_ATTRIBUTE, session);
        }

        RateLimited limited = method.getMethodAnnotation(RateLimited.class);

        if (limited != null) {
            RateLimiter.Decision decision = limiter.hit(limited.value(), request.getRemoteAddr());
            long windowSeconds = limited.value().window().toSeconds();

            // draft-7 combined headers, as express-rate-limit sent them.
            response.setHeader("RateLimit-Policy", decision.limit() + ";w=" + windowSeconds);
            response.setHeader("RateLimit", "limit=" + decision.limit() + ", remaining="
                    + decision.remaining() + ", reset=" + decision.resetSeconds());

            if (!decision.allowed()) {
                response.setHeader("Retry-After", String.valueOf(decision.resetSeconds()));
                return reject(response, 429, limited.value().message());
            }
        }

        return true;
    }

    private boolean reject(HttpServletResponse response, int status, String message) throws IOException {
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        json.writeValue(response.getOutputStream(), ApiResponse.error(message));
        return false;
    }

    private static String sessionCookie(HttpServletRequest request) {
        if (request.getCookies() == null) {
            return null;
        }
        for (Cookie cookie : request.getCookies()) {
            if (AuthService.SESSION_COOKIE.equals(cookie.getName())) {
                return cookie.getValue();
            }
        }
        return null;
    }
}
