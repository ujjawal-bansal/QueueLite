package com.queuelite.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** The same response headers helmet set on the Node API. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class SecurityHeadersFilter extends OncePerRequestFilter {

    private static final String CSP = String.join(";",
            "default-src 'self'",
            "base-uri 'self'",
            "font-src 'self' https: data:",
            "form-action 'self'",
            "frame-ancestors 'self'",
            "img-src 'self' data:",
            "object-src 'none'",
            "script-src 'self'",
            "script-src-attr 'none'",
            "style-src 'self' https: 'unsafe-inline'",
            "upgrade-insecure-requests");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        response.setHeader("Content-Security-Policy", CSP);
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        response.setHeader("Origin-Agent-Cluster", "?1");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("X-DNS-Prefetch-Control", "off");
        response.setHeader("X-Download-Options", "noopen");
        response.setHeader("X-Frame-Options", "SAMEORIGIN");
        response.setHeader("X-Permitted-Cross-Domain-Policies", "none");
        response.setHeader("X-XSS-Protection", "0");
        chain.doFilter(request, response);
    }
}
