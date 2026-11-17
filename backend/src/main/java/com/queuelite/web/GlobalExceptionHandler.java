package com.queuelite.web;

import com.queuelite.config.AppConfig;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);
    private static final ClassPathResource SPA_INDEX = new ClassPathResource("static/index.html");

    private final AppConfig config;

    public GlobalExceptionHandler(AppConfig config) {
        this.config = config;
    }

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiResponse<Void>> handleApi(ApiException error) {
        return ResponseEntity.status(error.status()).body(ApiResponse.error(error.getMessage()));
    }

    /**
     * Unknown routes. When the React build is bundled into this jar (the
     * single-container deploy), any non-API page is the single-page app's to
     * route, so refreshing /q/... serves index.html instead of a 404.
     */
    @ExceptionHandler({NoResourceFoundException.class, NoHandlerFoundException.class,
            HttpRequestMethodNotSupportedException.class})
    public ResponseEntity<?> handleNotFound(Exception error, HttpServletRequest request) throws IOException {
        String path = request.getRequestURI();

        if (SPA_INDEX.exists() && "GET".equals(request.getMethod()) && !path.startsWith("/api/")) {
            return ResponseEntity.ok()
                    .contentType(MediaType.TEXT_HTML)
                    .header("Cache-Control", "no-cache")
                    .body(SPA_INDEX.getContentAsByteArray());
        }

        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiResponse.error("Not found"));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, HttpMediaTypeNotSupportedException.class,
            MissingServletRequestParameterException.class})
    public ResponseEntity<ApiResponse<Void>> handleBadBody(Exception error) {
        return ResponseEntity.badRequest().body(ApiResponse.error("Request body is not valid JSON"));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleUnexpected(Exception error, HttpServletRequest request) {
        log.error("request failed path={}", request.getRequestURI(), error);

        // Internal failures must not leak stack traces or driver messages.
        String message = config.isProduction()
                ? "Something went wrong. Please try again."
                : (error.getMessage() == null ? "Internal server error" : error.getMessage());

        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(ApiResponse.error(message));
    }
}
