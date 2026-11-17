package com.queuelite.config;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.function.Function;

/**
 * Every setting the API reads, checked once at startup.
 *
 * The server refuses to start on a missing or malformed value and names it,
 * rather than failing later at the moment somebody needs it. Values come from
 * the environment (Render) or from backend/.env when running locally.
 */
public final class AppConfig {

    public record WhatsApp(
            String phoneNumberId,
            String accessToken,
            String verifyToken,
            String appSecret,
            String graphVersion,
            String templateTokenIssued,
            String templateYourTurn,
            // Optional: leave unset until Meta approves the template and the
            // heads-up reminder simply stays off, rather than failing a send on
            // every call-in.
            String templateHeadsUp,
            String templateLocale,
            String countryCode) {}

    public record Database(String jdbcUrl, String username, String password) {}

    private final String appEnv;
    private final boolean production;
    private final int port;
    private final Database database;
    private final String frontendUrl;
    private final List<String> extraAllowedOrigins;
    private final String clinicSlug;
    private final String sessionSecret;
    private final String staffPasscodeHash;
    private final double sessionTtlHours;
    private final String staffRecoveryCodeHash;
    private final String notifier;
    private final int reminderLeadPatients;
    private final double avgConsultMinutes;
    private final boolean useMeasuredPace;
    private final WhatsApp whatsapp;

    private AppConfig(Function<String, String> source) {
        List<String> problems = new ArrayList<>();
        Reader env = new Reader(source, problems);

        // APP_ENV is the Java name; NODE_ENV is still honoured so an existing
        // Render service keeps its production behaviour across the switch.
        this.appEnv = env.optional("APP_ENV", env.optional("NODE_ENV", "development"));
        this.production = appEnv.equals("production");

        this.notifier = env.optional("NOTIFIER", "console").toLowerCase(Locale.ROOT);
        boolean useWhatsApp = notifier.equals("whatsapp");

        this.port = env.number("PORT", "3001", problems, "PORT must be a positive number").intValue();

        this.database = parseDatabase(
                env.required("DATABASE_URL", true,
                        "the Postgres connection string from Supabase (Project Settings > Database)"),
                env.optional("DATABASE_USERNAME", ""),
                env.optional("DATABASE_PASSWORD", ""),
                problems);

        this.frontendUrl = stripTrailingSlash(env.required("FRONTEND_URL", true,
                "the public URL of the patient/staff site, used for CORS and tracking links"));

        // Vercel serves the same app on preview hostnames too, and a request from
        // one of those is rejected by CORS in a way the browser reports only as a
        // failed connection. List any extra origins here rather than debugging it.
        this.extraAllowedOrigins = Arrays.stream(env.optional("ALLOWED_ORIGINS", "").split(","))
                .map(String::trim)
                .map(AppConfig::stripTrailingSlash)
                .filter(value -> !value.isEmpty())
                .toList();

        this.clinicSlug = env.required("CLINIC_SLUG", true,
                "the single clinic this deployment serves, e.g. sharma-clinic");

        this.sessionSecret = env.required("SESSION_SECRET", true,
                "random 32+ char string; run `./mvnw -q spring-boot:run -Dspring-boot.run.arguments=generate-secrets`");
        this.staffPasscodeHash = env.required("STAFF_PASSCODE_HASH", true,
                "run the hash-passcode tool and paste the result");
        this.sessionTtlHours = env.number("SESSION_TTL_HOURS", "12", problems,
                "SESSION_TTL_HOURS must be a positive number").doubleValue();

        // Break-glass sign-in for the morning the desk cannot remember the
        // passcode. Unset means the recovery route is off entirely rather than
        // present-but-unusable.
        this.staffRecoveryCodeHash = env.optional("STAFF_RECOVERY_CODE_HASH", "");

        // How many patients ahead trigger the "start heading over" reminder.
        this.reminderLeadPatients = env.number("REMINDER_LEAD_PATIENTS", "3", problems,
                "REMINDER_LEAD_PATIENTS must be a whole number of patients (0 disables it)").intValue();

        // How long the clinic budgets per patient. The clinic row's
        // avg_consult_minutes overrides it.
        this.avgConsultMinutes = env.number("AVG_CONSULT_MINUTES", "15", problems,
                "AVG_CONSULT_MINUTES must be a positive number").doubleValue();

        // Off by default, deliberately: a handful of quick call-ins early on
        // produces a confident-looking figure the desk repeats to patients.
        this.useMeasuredPace = env.optional("USE_MEASURED_PACE", "false").equalsIgnoreCase("true");

        this.whatsapp = new WhatsApp(
                env.required("WHATSAPP_PHONE_NUMBER_ID", useWhatsApp, ""),
                env.required("WHATSAPP_ACCESS_TOKEN", useWhatsApp, ""),
                env.required("WHATSAPP_VERIFY_TOKEN", useWhatsApp, ""),
                env.required("WHATSAPP_APP_SECRET", useWhatsApp, "used to verify webhook signatures"),
                env.optional("WHATSAPP_GRAPH_VERSION", "v21.0"),
                env.optional("WHATSAPP_TEMPLATE_TOKEN_ISSUED", "queue_token_issued"),
                env.optional("WHATSAPP_TEMPLATE_YOUR_TURN", "queue_your_turn"),
                env.optional("WHATSAPP_TEMPLATE_HEADS_UP", ""),
                env.optional("WHATSAPP_TEMPLATE_LOCALE", "en"),
                env.optional("WHATSAPP_COUNTRY_CODE", "91"));

        if (!sessionSecret.isEmpty() && sessionSecret.length() < 32) {
            problems.add("SESSION_SECRET must be at least 32 characters");
        }
        if (port <= 0) {
            problems.add("PORT must be a positive number");
        }
        if (sessionTtlHours <= 0) {
            problems.add("SESSION_TTL_HOURS must be a positive number");
        }

        // The most likely mistake by far is pasting the code where the hash
        // belongs, so say that.
        if (!staffRecoveryCodeHash.isEmpty()) {
            String[] parts = staffRecoveryCodeHash.split("\\$", -1);
            if (parts.length != 3 || !parts[0].equals("scrypt") || parts[2].length() != 128) {
                problems.add("STAFF_RECOVERY_CODE_HASH is malformed - it must be the "
                        + "`scrypt$<salt>$<hash>` line printed by the generate-recovery tool, "
                        + "not the recovery code itself");
            }
        }

        if (reminderLeadPatients < 0) {
            problems.add("REMINDER_LEAD_PATIENTS must be a whole number of patients (0 disables it)");
        }
        if (avgConsultMinutes <= 0) {
            problems.add("AVG_CONSULT_MINUTES must be a positive number");
        }
        if (production && frontendUrl.startsWith("http://")) {
            problems.add("FRONTEND_URL must use https in production");
        }

        if (!problems.isEmpty()) {
            throw new InvalidConfigException(problems.stream().distinct().toList());
        }
    }

    public static AppConfig from(Function<String, String> source) {
        return new AppConfig(source);
    }

    /**
     * Supabase hands out a URI ("postgresql://user:pass@host:5432/postgres").
     * JDBC wants "jdbc:postgresql://host:5432/postgres" with the credentials
     * passed separately, so either form is accepted here.
     */
    static Database parseDatabase(String raw, String username, String password, List<String> problems) {
        if (raw.isEmpty()) {
            return new Database("", "", "");
        }

        if (raw.startsWith("jdbc:postgresql:")) {
            return new Database(withDefaults(raw), username, password);
        }

        if (!raw.startsWith("postgres://") && !raw.startsWith("postgresql://")) {
            problems.add("DATABASE_URL must start with postgresql:// or jdbc:postgresql://");
            return new Database("", "", "");
        }

        try {
            URI uri = URI.create(raw.replaceFirst("^postgres(ql)?://", "http://"));
            String user = username;
            String pass = password;

            if (uri.getRawUserInfo() != null) {
                String[] info = uri.getRawUserInfo().split(":", 2);
                user = URLDecoder.decode(info[0], StandardCharsets.UTF_8);
                pass = info.length > 1 ? URLDecoder.decode(info[1], StandardCharsets.UTF_8) : password;
            }

            String jdbc = "jdbc:postgresql://" + uri.getHost()
                    + (uri.getPort() > 0 ? ":" + uri.getPort() : "")
                    + (uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/postgres" : uri.getRawPath())
                    + (uri.getRawQuery() != null ? "?" + uri.getRawQuery() : "");

            return new Database(withDefaults(jdbc), user, pass);
        } catch (IllegalArgumentException error) {
            problems.add("DATABASE_URL is not a valid connection string");
            return new Database("", "", "");
        }
    }

    // Supabase's transaction pooler (port 6543) cannot hold server-side
    // prepared statements between transactions, so the driver must not create
    // them. Harmless on a direct or session connection.
    private static String withDefaults(String jdbcUrl) {
        if (jdbcUrl.contains("prepareThreshold=")) {
            return jdbcUrl;
        }
        return jdbcUrl + (jdbcUrl.contains("?") ? "&" : "?") + "prepareThreshold=0";
    }

    private static String stripTrailingSlash(String value) {
        return value.replaceAll("/+$", "");
    }

    public String appEnv() { return appEnv; }
    public boolean isProduction() { return production; }
    public int port() { return port; }
    public Database database() { return database; }
    public String frontendUrl() { return frontendUrl; }
    public List<String> extraAllowedOrigins() { return extraAllowedOrigins; }
    public String clinicSlug() { return clinicSlug; }
    public String sessionSecret() { return sessionSecret; }
    public String staffPasscodeHash() { return staffPasscodeHash; }
    public double sessionTtlHours() { return sessionTtlHours; }
    public String staffRecoveryCodeHash() { return staffRecoveryCodeHash; }
    public String notifier() { return notifier; }
    public boolean useWhatsApp() { return notifier.equals("whatsapp"); }
    public int reminderLeadPatients() { return reminderLeadPatients; }
    public double avgConsultMinutes() { return avgConsultMinutes; }
    public boolean useMeasuredPace() { return useMeasuredPace; }
    public WhatsApp whatsapp() { return whatsapp; }

    /** Thrown with every problem at once, so one restart fixes them all. */
    public static final class InvalidConfigException extends IllegalStateException {
        private final List<String> problems;

        InvalidConfigException(List<String> problems) {
            super("QueueLite cannot start - check your .env file:\n\n  "
                    + String.join("\n  ", problems)
                    + "\n\nSee .env.example for the full list.");
            this.problems = problems;
        }

        public List<String> problems() {
            return problems;
        }
    }

    private record Reader(Function<String, String> source, List<String> problems) {
        String raw(String key) {
            String value = source.apply(key);
            return value == null ? "" : value.trim();
        }

        String optional(String key, String fallback) {
            String value = raw(key);
            return value.isEmpty() ? fallback : value;
        }

        String required(String key, boolean when, String hint) {
            String value = raw(key);
            if (when && value.isEmpty()) {
                problems.add(key + " is required" + (hint.isEmpty() ? "" : " - " + hint));
            }
            return value;
        }

        Number number(String key, String fallback, List<String> problems, String message) {
            String value = optional(key, fallback);
            try {
                double parsed = Double.parseDouble(value);
                if (!Double.isFinite(parsed)) {
                    throw new NumberFormatException();
                }
                if (message.contains("whole number") && parsed != Math.rint(parsed)) {
                    problems.add(message);
                }
                return parsed;
            } catch (NumberFormatException error) {
                problems.add(message);
                return 0;
            }
        }
    }
}
