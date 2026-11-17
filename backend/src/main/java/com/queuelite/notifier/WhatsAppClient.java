package com.queuelite.notifier;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.queuelite.config.AppConfig;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** The official Meta WhatsApp Cloud API. Never an unofficial WhatsApp Web library. */
@Component
public class WhatsAppClient {

    private static final Logger log = LoggerFactory.getLogger(WhatsAppClient.class);

    private final AppConfig.WhatsApp config;
    private final ObjectMapper json;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    public WhatsAppClient(AppConfig appConfig, ObjectMapper json) {
        this.config = appConfig.whatsapp();
        this.json = json;
    }

    /**
     * Meta expects E.164 without the leading "+". A bare 10-digit Indian number
     * gets the country code; anything already longer is passed through.
     * Leading zeros come off first: "0 63966 34403" is a ten-digit number
     * behind a zero.
     */
    public static String toE164(String phone, String countryCode) {
        String digits = (phone == null ? "" : phone).replaceAll("\\D", "").replaceFirst("^0+", "");
        return digits.length() == 10 ? countryCode + digits : digits;
    }

    /**
     * Business-initiated messages must use a template approved in Meta's
     * dashboard. {@code variables} fill its {{1}}, {{2}}, ... in order.
     */
    public JsonNode sendTemplate(String phone, String template, List<String> variables)
            throws IOException, InterruptedException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("to", toE164(phone, config.countryCode()));
        body.put("type", "template");
        body.put("template", Map.of(
                "name", template,
                "language", Map.of("code", config.templateLocale()),
                "components", variables.isEmpty() ? List.of() : List.of(Map.of(
                        "type", "body",
                        "parameters", variables.stream().map(text -> Map.of("type", "text", "text", text)).toList()))));

        JsonNode result = post(body);
        log.info("whatsapp template sent template={} messageId={}", template, result.at("/messages/0/id").asText(""));
        return result;
    }

    /** Free-form text, only deliverable inside the 24-hour service window. */
    public JsonNode sendText(String phone, String text) throws IOException, InterruptedException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("to", toE164(phone, config.countryCode()));
        body.put("type", "text");
        body.put("text", Map.of("preview_url", true, "body", text));

        JsonNode result = post(body);
        log.info("whatsapp reply sent messageId={}", result.at("/messages/0/id").asText(""));
        return result;
    }

    private JsonNode post(Map<String, Object> payload) throws IOException, InterruptedException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("messaging_product", "whatsapp");
        body.putAll(payload);

        HttpRequest request = HttpRequest.newBuilder(URI.create(
                        "https://graph.facebook.com/" + config.graphVersion() + "/" + config.phoneNumberId() + "/messages"))
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + config.accessToken())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
                .build();

        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        JsonNode parsed;
        try {
            parsed = json.readTree(response.body());
        } catch (IOException error) {
            parsed = json.createObjectNode();
        }

        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            String detail = parsed.at("/error/message").asText("HTTP " + response.statusCode());
            throw new IOException("WhatsApp send failed: " + detail);
        }

        return parsed;
    }
}
