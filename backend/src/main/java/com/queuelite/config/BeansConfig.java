package com.queuelite.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.time.Clock;
import javax.sql.DataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

@Configuration
public class BeansConfig {

    @Bean
    public AppConfig appConfig(Environment environment) {
        return AppConfig.from(environment::getProperty);
    }

    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }

    /**
     * A small pool. Supabase's pooler caps connections per project, and one
     * clinic's traffic is mostly served from the in-process queue snapshot.
     */
    @Bean
    public DataSource dataSource(AppConfig config) {
        HikariConfig hikari = new HikariConfig();
        hikari.setJdbcUrl(config.database().jdbcUrl());
        hikari.setUsername(config.database().username());
        hikari.setPassword(config.database().password());
        hikari.setMaximumPoolSize(5);
        hikari.setMinimumIdle(1);
        hikari.setPoolName("queuelite");
        // Do not fail startup when the database is briefly unreachable: the
        // health check must still answer so the platform keeps the instance.
        hikari.setInitializationFailTimeout(-1);
        return new HikariDataSource(hikari);
    }

}
