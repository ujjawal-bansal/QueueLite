package com.queuelite.web;

import com.queuelite.config.AppConfig;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.lang.Nullable;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {

    private static final Logger log = LoggerFactory.getLogger(WebConfig.class);

    private final AppConfig config;
    private final GuardInterceptor guard;

    public WebConfig(AppConfig config, GuardInterceptor guard) {
        this.config = config;
        this.guard = guard;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(guard).addPathPatterns("/api/**");
    }

    /**
     * Only FRONTEND_URL (plus ALLOWED_ORIGINS) may call the API from a browser.
     * Requests with no Origin at all - curl, health checks, Meta's webhook -
     * are not cross-origin and pass straight through.
     */
    @Bean
    public FilterRegistrationBean<CorsFilter> corsFilter() {
        List<String> allowed = new ArrayList<>();
        allowed.add(config.frontendUrl());
        allowed.addAll(config.extraAllowedOrigins());

        LoggingCors cors = new LoggingCors(allowed);
        cors.setAllowCredentials(true);
        cors.setAllowedMethods(List.of("GET", "POST", "PATCH", "OPTIONS"));
        cors.addAllowedHeader("*");

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cors);

        FilterRegistrationBean<CorsFilter> registration = new FilterRegistrationBean<>(new CorsFilter(source));
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE + 2);
        return registration;
    }

    /**
     * The browser only tells the user "failed to fetch", so the real reason is
     * recorded here - otherwise a blocked origin is invisible to diagnose.
     */
    private static final class LoggingCors extends CorsConfiguration {
        private final List<String> allowed;

        LoggingCors(List<String> allowed) {
            this.allowed = allowed;
            setAllowedOrigins(allowed);
        }

        @Override
        @Nullable
        public String checkOrigin(@Nullable String origin) {
            String result = super.checkOrigin(origin);
            if (result == null && origin != null) {
                log.warn("blocked cross-origin request origin={} allowed={}", origin, allowed);
            }
            return result;
        }
    }
}
