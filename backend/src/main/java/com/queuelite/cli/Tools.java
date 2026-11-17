package com.queuelite.cli;

import com.queuelite.auth.Scrypt;
import java.io.Console;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.Scanner;
import java.util.Set;

/**
 * One-off setup tools, the Java versions of the old npm scripts:
 *
 *   java -jar target/queuelite-api.jar generate-secrets
 *   java -jar target/queuelite-api.jar hash-passcode [passcode]
 *   java -jar target/queuelite-api.jar generate-recovery
 *   java -jar target/queuelite-api.jar test-whatsapp 9876543210 [template]
 */
public final class Tools {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Set<String> COMMANDS =
            Set.of("generate-secrets", "hash-passcode", "generate-recovery", "test-whatsapp");

    private Tools() {}

    public static boolean handles(String command) {
        return COMMANDS.contains(command);
    }

    public static int run(String[] args) throws Exception {
        return switch (args[0]) {
            case "generate-secrets" -> generateSecrets();
            case "hash-passcode" -> hashPasscode(args.length > 1 ? args[1] : null);
            case "generate-recovery" -> generateRecovery();
            case "test-whatsapp" -> testWhatsApp(args);
            default -> 1;
        };
    }

    private static int generateSecrets() {
        System.out.println("\nAdd these to backend/.env (and to Render's environment):\n");
        System.out.println("SESSION_SECRET=" + randomHex(32));
        System.out.println("WHATSAPP_VERIFY_TOKEN=" + randomHex(16));
        System.out.println();
        return 0;
    }

    private static int hashPasscode(String passcode) {
        if (passcode == null) {
            Console console = System.console();
            if (console != null) {
                char[] typed = console.readPassword("Choose a staff passcode: ");
                passcode = typed == null ? "" : new String(typed);
            } else {
                System.out.print("Choose a staff passcode: ");
                passcode = new Scanner(System.in).nextLine();
            }

            if (passcode.length() < 6) {
                System.err.println("\nUse at least 6 characters.\n");
                return 1;
            }
        }

        System.out.println("\nSTAFF_PASSCODE_HASH=" + Scrypt.hash(passcode) + "\n");
        return 0;
    }

    /**
     * A break-glass code for the one morning the desk cannot remember the
     * passcode. Generated rather than chosen, and only the hash is stored.
     */
    private static int generateRecovery() {
        byte[] bytes = new byte[15];
        RANDOM.nextBytes(bytes);
        String code = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);

        System.out.println("""

                ================================================================
                  1. THE RECOVERY CODE - keep this, do NOT put it in .env
                ================================================================

                     %s

                  Print it and keep it where the front desk can reach it. It is
                  not stored anywhere and cannot be recovered if lost.

                ================================================================
                  2. THE HASH - copy this whole line into .env and Render
                ================================================================

                STAFF_RECOVERY_CODE_HASH=%s

                  The two are different on purpose: the server only ever stores
                  the hash, so a leaked .env does not hand anyone the code.

                  Restart the backend afterwards.
                """.formatted(code, Scrypt.hash(code)));
        return 0;
    }

    /**
     * Sends one WhatsApp message with the configured credentials, isolating
     * "are my credentials right?" from "is my app right?".
     */
    private static int testWhatsApp(String[] args) throws IOException, InterruptedException {
        if (args.length < 2) {
            System.err.println("\n  Usage: test-whatsapp <10-digit-phone> [template-name]\n");
            return 1;
        }

        Map<String, String> env = readEnv();
        String phoneId = env.getOrDefault("WHATSAPP_PHONE_NUMBER_ID", "");
        String token = env.getOrDefault("WHATSAPP_ACCESS_TOKEN", "");
        String version = env.getOrDefault("WHATSAPP_GRAPH_VERSION", "v21.0");
        String country = env.getOrDefault("WHATSAPP_COUNTRY_CODE", "91");

        if (phoneId.isEmpty() || token.isEmpty()) {
            System.err.println("\n  Not set in .env: WHATSAPP_PHONE_NUMBER_ID and/or WHATSAPP_ACCESS_TOKEN\n");
            return 1;
        }

        String template = args.length > 2 ? args[2] : "hello_world";
        String digits = args[1].replaceAll("\\D", "");
        String to = digits.length() == 10 ? country + digits : digits.replaceFirst("^0+", "");

        // hello_world is pre-approved by Meta and takes no variables, so it
        // proves the credentials work before your own templates are approved.
        String payload = """
                {"messaging_product":"whatsapp","to":"%s","type":"template",
                 "template":{"name":"%s","language":{"code":"%s"}}}"""
                .formatted(to, template, template.equals("hello_world") ? "en_US"
                        : env.getOrDefault("WHATSAPP_TEMPLATE_LOCALE", "en"));

        System.out.println("\n  -> sending \"" + template + "\" to +" + to + "\n");

        HttpResponse<String> response = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create("https://graph.facebook.com/" + version + "/" + phoneId + "/messages"))
                        .header("Authorization", "Bearer " + token)
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(payload))
                        .build(),
                HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() / 100 == 2) {
            System.out.println("  SENT. " + response.body());
            System.out.println("  Check the phone. If nothing arrives, the number is likely");
            System.out.println("  not in the test allow-list.\n");
            return 0;
        }

        System.err.println("  FAILED (HTTP " + response.statusCode() + ")\n  " + response.body());
        System.err.println("""

                  Common causes:
                    190     access token invalid or expired - use a permanent System User token
                    100     bad phone number id, or a template name/locale that does not exist
                    131030  recipient not in the test allow-list (WhatsApp > API Setup)
                    132001  template not found or not APPROVED
                    132000  template variable count mismatch
                """);
        return 1;
    }

    private static Map<String, String> readEnv() throws IOException {
        Map<String, String> values = new HashMap<>();
        Path file = Path.of(".env");

        if (Files.exists(file)) {
            for (String line : Files.readAllLines(file)) {
                int equals = line.indexOf('=');
                if (equals > 0 && !line.stripLeading().startsWith("#")) {
                    values.put(line.substring(0, equals).trim(), line.substring(equals + 1).trim());
                }
            }
        }

        values.putAll(System.getenv());
        return values;
    }

    private static String randomHex(int bytes) {
        byte[] buffer = new byte[bytes];
        RANDOM.nextBytes(buffer);
        return HexFormat.of().formatHex(buffer);
    }
}
