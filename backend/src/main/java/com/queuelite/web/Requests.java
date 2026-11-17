package com.queuelite.web;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.util.UUID;
import java.util.regex.Pattern;

/** Small, forgiving readers for path and body values. */
public final class Requests {

    private static final Pattern UUID_PATTERN = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", Pattern.CASE_INSENSITIVE);

    private Requests() {}

    /**
     * A malformed id is answered as "not found" here rather than reaching
     * Postgres, which keeps driver messages out of responses.
     */
    public static UUID uuid(String value, String notFoundMessage) {
        if (value == null || !UUID_PATTERN.matcher(value).matches()) {
            throw ApiException.notFound(notFoundMessage);
        }
        return UUID.fromString(value);
    }

    /** A string field, trimmed; anything that is not a JSON string reads as empty. */
    public static String text(JsonNode body, String field) {
        if (body == null) {
            return "";
        }
        JsonNode value = body.get(field);
        return value != null && value.isTextual() ? value.asText().trim() : "";
    }

    /**
     * A whole number from a JSON number or numeric string ("3" counts, as it
     * did in the Node API), or null for anything else.
     */
    public static Long wholeNumber(JsonNode value) {
        if (value == null || value.isNull()) {
            return null;
        }
        String raw = value.isNumber() ? value.decimalValue().toPlainString()
                : value.isTextual() ? value.asText().trim() : null;
        return wholeNumber(raw);
    }

    public static Long wholeNumber(String raw) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        try {
            BigDecimal number = new BigDecimal(raw);
            if (number.stripTrailingZeros().scale() > 0) {
                return null;
            }
            return number.longValueExact();
        } catch (NumberFormatException | ArithmeticException error) {
            return null;
        }
    }
}
