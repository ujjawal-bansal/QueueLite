package com.queuelite.support;

import com.queuelite.auth.Scrypt;
import com.queuelite.queue.QueueService;
import com.queuelite.queue.TokenRepository;
import com.queuelite.web.RateLimiter;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * The real application, on a real port, against a real Postgres. Only the
 * clock, the notifier and the background executor are swapped out.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(TestBeans.class)
public abstract class ApiTestBase {

    public static final String PASSCODE = "front-desk-2026";
    // Produced by Node's crypto.scryptSync(PASSCODE, salt, 64) - the hash format
    // already sitting in Render's environment.
    public static final String PASSCODE_HASH = "scrypt$fixedsalt0123456$"
            + "17a4a91f8d4b9c5ca81ab9a25cd76fa65396969a6a65a401265b96c3758ad9a4"
            + "b7d004c28bf5032090a2af8fd859c10da35a4d74a316dfad7ca70765c1213981";
    public static final String CLINIC = "/api/clinics/" + TestDatabase.CLINIC_SLUG;

    @DynamicPropertySource
    static void environment(DynamicPropertyRegistry registry) {
        // The pom points the .env import at a file that does not exist, so a
        // developer's own .env never leaks into the suite; the settings the
        // tests depend on are pinned here regardless.
        registry.add("APP_ENV", () -> "test");
        registry.add("DATABASE_URL", TestDatabase::jdbcUrl);
        registry.add("DATABASE_USERNAME", () -> "postgres");
        registry.add("DATABASE_PASSWORD", () -> "postgres");
        registry.add("FRONTEND_URL", () -> "http://localhost:5173");
        registry.add("ALLOWED_ORIGINS", () -> "");
        registry.add("CLINIC_SLUG", () -> TestDatabase.CLINIC_SLUG);
        registry.add("SESSION_SECRET", () -> "a".repeat(48));
        registry.add("SESSION_TTL_HOURS", () -> "12");
        registry.add("STAFF_PASSCODE_HASH", () -> PASSCODE_HASH);
        registry.add("NOTIFIER", () -> "console");
        registry.add("USE_MEASURED_PACE", () -> "false");
        registry.add("AVG_CONSULT_MINUTES", () -> "15");
        registry.add("REMINDER_LEAD_PATIENTS", () -> "3");
        registry.add("WHATSAPP_COUNTRY_CODE", () -> "91");
        registry.add("WHATSAPP_APP_SECRET", () -> "test-app-secret");
        registry.add("WHATSAPP_VERIFY_TOKEN", () -> "test-verify-token");
    }

    @LocalServerPort
    protected int port;

    @Autowired
    protected MutableClock clock;

    @Autowired
    protected RecordingNotifier notifier;

    @Autowired
    protected QueueService queue;

    @Autowired
    protected TokenRepository tokens;

    @Autowired
    protected RateLimiter limiter;

    protected Api api;

    /** A fresh day: no tokens, nothing sent, the clock back at mid-morning. */
    protected void resetDay() {
        TestDatabase.execute("delete from tokens");
        queue.invalidate(TestDatabase.CLINIC_ID);
        notifier.reset();
        limiter.reset();
        clock.set(MutableClock.MORNING);
    }

    @BeforeEach
    void connect() {
        api = new Api(port);
    }

    protected Api signedIn() {
        Api staff = new Api(port);
        staff.signIn(PASSCODE);
        return staff;
    }

    protected Api.Response issue(Api staff, String name, String phone) {
        return staff.post(CLINIC + "/tokens",
                "{\"patient_name\":\"" + name + "\",\"patient_phone\":\"" + phone + "\"}");
    }

    static {
        // Fail loudly if the fixture hash ever stops matching, rather than every
        // sign-in in the suite failing with a confusing 401.
        if (!Scrypt.verify(PASSCODE, PASSCODE_HASH, "STAFF_PASSCODE_HASH")) {
            throw new IllegalStateException("test passcode hash does not verify");
        }
    }
}
