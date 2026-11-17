package com.queuelite.support;

import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

/**
 * A real Postgres, started once for the whole suite, with sql/schema.sql
 * applied. Running against the actual schema - unique index, check
 * constraints and all - means a change made to the SQL and not the code (or
 * the reverse) fails a test rather than surprising you in production.
 */
public final class TestDatabase {

    public static final UUID CLINIC_ID = UUID.fromString("00000000-0000-0000-0000-00000000c11c");
    public static final String CLINIC_SLUG = "test-clinic";

    private static EmbeddedPostgres postgres;

    private TestDatabase() {}

    public static synchronized EmbeddedPostgres get() {
        if (postgres == null) {
            try {
                postgres = EmbeddedPostgres.builder().start();
                try (Connection connection = postgres.getPostgresDatabase().getConnection();
                     Statement statement = connection.createStatement()) {
                    // Supabase's built-in roles, which the schema's RLS policies name.
                    statement.execute("create role anon nologin");
                    statement.execute("create role authenticated nologin");
                    statement.execute(Files.readString(Path.of("sql/schema.sql")));
                    statement.execute("""
                            insert into clinics (id, name, slug, doctor_name, address, phone, maps_url,
                                                 opens_at, closes_at, avg_consult_minutes)
                            values ('%s', 'Dev Eye Care', '%s', 'Dr. Sachin Dev', 'Civil Lines, Moradabad',
                                    '+919368444330', 'https://maps.google.com/?q=Dev+Eye+Care',
                                    '10:00', '18:00', 6)""".formatted(CLINIC_ID, CLINIC_SLUG));
                }
            } catch (IOException | SQLException error) {
                throw new IllegalStateException("could not start the test database", error);
            }
        }
        return postgres;
    }

    public static String jdbcUrl() {
        return get().getJdbcUrl("postgres", "postgres");
    }

    public static void execute(String sql) {
        try (Connection connection = get().getPostgresDatabase().getConnection();
             Statement statement = connection.createStatement()) {
            statement.execute(sql);
        } catch (SQLException error) {
            throw new IllegalStateException(error);
        }
    }
}
