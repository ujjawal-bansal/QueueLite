package com.queuelite.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class AppConfigTest {

    static Map<String, String> valid() {
        Map<String, String> env = new HashMap<>();
        env.put("DATABASE_URL", "postgresql://postgres.abcd:p%40ss@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require");
        env.put("FRONTEND_URL", "https://queuelite.vercel.app/");
        env.put("CLINIC_SLUG", "dev-eye-care");
        env.put("SESSION_SECRET", "x".repeat(64));
        env.put("STAFF_PASSCODE_HASH", "scrypt$salt$" + "0".repeat(128));
        return env;
    }

    @Test
    void aSupabaseConnectionStringBecomesAJdbcUrlAndCredentials() {
        AppConfig config = AppConfig.from(valid()::get);
        assertThat(config.database().jdbcUrl()).isEqualTo(
                "jdbc:postgresql://aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require&prepareThreshold=0");
        assertThat(config.database().username()).isEqualTo("postgres.abcd");
        assertThat(config.database().password()).isEqualTo("p@ss");
        assertThat(config.frontendUrl()).isEqualTo("https://queuelite.vercel.app");
    }

    @Test
    void aPasswordWithCharactersAUriWouldRejectStillParses() {
        Map<String, String> env = valid();
        env.put("DATABASE_URL", "postgresql://postgres.abcd:a[b]c^d#e/f@g+h@aws-1-us-west-2.pooler.supabase.com:5432/postgres");
        AppConfig config = AppConfig.from(env::get);
        assertThat(config.database().jdbcUrl()).isEqualTo(
                "jdbc:postgresql://aws-1-us-west-2.pooler.supabase.com:5432/postgres?prepareThreshold=0");
        assertThat(config.database().username()).isEqualTo("postgres.abcd");
        assertThat(config.database().password()).isEqualTo("a[b]c^d#e/f@g+h");
    }

    @Test
    void theLeftoverPasswordPlaceholderIsNamed() {
        Map<String, String> env = valid();
        env.put("DATABASE_URL", "postgresql://postgres.abcd:[YOUR-DATABASE-PASSWORD]@aws-1-us-west-2.pooler.supabase.com:5432/postgres");
        assertThatThrownBy(() -> AppConfig.from(env::get)).hasMessageContaining("placeholder");
    }

    @Test
    void defaultsMatchTheNodeApi() {
        AppConfig config = AppConfig.from(valid()::get);
        assertThat(config.port()).isEqualTo(3001);
        assertThat(config.notifier()).isEqualTo("console");
        assertThat(config.reminderLeadPatients()).isEqualTo(3);
        assertThat(config.avgConsultMinutes()).isEqualTo(15);
        assertThat(config.useMeasuredPace()).isFalse();
        assertThat(config.sessionTtlHours()).isEqualTo(12);
        assertThat(config.whatsapp().templateHeadsUp()).isEmpty();
    }

    @Test
    void everyProblemIsNamedAtOnce() {
        assertThatThrownBy(() -> AppConfig.from(key -> null))
                .isInstanceOf(AppConfig.InvalidConfigException.class)
                .hasMessageContaining("DATABASE_URL is required")
                .hasMessageContaining("FRONTEND_URL is required")
                .hasMessageContaining("SESSION_SECRET is required")
                .hasMessageContaining("STAFF_PASSCODE_HASH is required");
    }

    @Test
    void pastingTheRecoveryCodeWhereItsHashBelongsIsCaught() {
        Map<String, String> env = valid();
        env.put("STAFF_RECOVERY_CODE_HASH", "Xk2pQ9rT7vW1yZ3a5b7c");
        assertThatThrownBy(() -> AppConfig.from(env::get)).hasMessageContaining("not the recovery code itself");
    }

    @Test
    void whatsAppSettingsAreRequiredOnlyWhenWhatsAppIsOn() {
        Map<String, String> env = valid();
        env.put("NOTIFIER", "whatsapp");
        assertThatThrownBy(() -> AppConfig.from(env::get)).hasMessageContaining("WHATSAPP_APP_SECRET is required");
    }

    @Test
    void productionRefusesAPlainHttpFrontend() {
        Map<String, String> env = valid();
        env.put("APP_ENV", "production");
        env.put("FRONTEND_URL", "http://queuelite.vercel.app");
        assertThatThrownBy(() -> AppConfig.from(env::get)).hasMessageContaining("must use https");
    }

    @Test
    void theOldNodeEnvSettingStillMeansProduction() {
        Map<String, String> env = valid();
        env.put("NODE_ENV", "production");
        assertThat(AppConfig.from(env::get).isProduction()).isTrue();
    }

    @Test
    void malformedNumbersAreRefused() {
        Map<String, String> env = valid();
        env.put("REMINDER_LEAD_PATIENTS", "2.5");
        env.put("AVG_CONSULT_MINUTES", "-1");
        assertThatThrownBy(() -> AppConfig.from(env::get))
                .hasMessageContaining("REMINDER_LEAD_PATIENTS")
                .hasMessageContaining("AVG_CONSULT_MINUTES");
    }
}
