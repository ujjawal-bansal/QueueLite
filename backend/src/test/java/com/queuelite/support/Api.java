package com.queuelite.support;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

/** Drives the real HTTP API, cookie and all, the way the browser does. */
public class Api {

    public record Response(int status, JsonNode body, HttpHeaders headers, String text) {
        public JsonNode data() {
            return body.get("data");
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    private final HttpClient http = HttpClient.newHttpClient();
    private final String baseUrl;
    private String cookie = "";

    public Api(int port) {
        this.baseUrl = "http://127.0.0.1:" + port;
    }

    public Response get(String path) {
        return send("GET", path, null);
    }

    public Response post(String path, String body) {
        return send("POST", path, body);
    }

    public Response patch(String path, String body) {
        return send("PATCH", path, body);
    }

    public Response signIn(String passcode) {
        Response response = post("/api/auth/login", "{\"passcode\":\"" + passcode + "\"}");
        response.headers().firstValue("set-cookie").ifPresent(value -> cookie = value.split(";")[0]);
        return response;
    }

    /** Keeps whatever session cookie a response set, as the browser would. */
    public Response keepCookie(Response response) {
        response.headers().firstValue("set-cookie").ifPresent(value -> cookie = value.split(";")[0]);
        return response;
    }

    public void signOut() {
        cookie = "";
    }

    public Response send(String method, String path, String body) {
        try {
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(baseUrl + path))
                    .header("Content-Type", "application/json")
                    .method(method, body == null
                            ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofString(body));
            if (!cookie.isEmpty()) {
                request.header("Cookie", cookie);
            }

            HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            JsonNode parsed;
            try {
                parsed = JSON.readTree(response.body());
            } catch (IOException error) {
                parsed = null;
            }
            return new Response(response.statusCode(), parsed, response.headers(), response.body());
        } catch (IOException | InterruptedException error) {
            throw new IllegalStateException(error);
        }
    }
}
