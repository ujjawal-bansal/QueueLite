package com.queuelite.web;

import com.queuelite.config.AppConfig;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RootController {

    private static final ClassPathResource SPA_INDEX = new ClassPathResource("static/index.html");

    private final AppConfig config;

    public RootController(AppConfig config) {
        this.config = config;
    }

    /**
     * With the React build bundled in (the single-container deploy) the root is
     * the app itself. Otherwise the API has no UI, and the bare root answers
     * with something self-explanatory so the service URL does not look like a
     * broken deploy.
     */
    @GetMapping("/")
    public ResponseEntity<?> root() throws IOException {
        if (SPA_INDEX.exists()) {
            return ResponseEntity.ok()
                    .contentType(MediaType.TEXT_HTML)
                    .header("Cache-Control", "no-cache")
                    .body(SPA_INDEX.getContentAsByteArray());
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("success", true);
        body.put("service", "queuelite-api");
        body.put("message", "QueueLite API. The app itself lives at the frontend URL below.");
        body.put("data", Map.of("app", config.frontendUrl(), "health", "/api/health"));
        return ResponseEntity.ok(body);
    }
}
