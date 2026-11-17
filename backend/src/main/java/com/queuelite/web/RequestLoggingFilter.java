package com.queuelite.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * One line per request: method, path, status and time. Never the body or
 * cookies, so patient names, phone numbers and passcodes cannot reach the logs.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
public class RequestLoggingFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger("http");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long started = System.nanoTime();
        try {
            chain.doFilter(request, response);
        } finally {
            String path = request.getRequestURI();
            if (!path.equals("/api/health") && path.startsWith("/api")) {
                log.info("{} {} {} {}ms", request.getMethod(), path, response.getStatus(),
                        (System.nanoTime() - started) / 1_000_000);
            }
        }
    }
}
