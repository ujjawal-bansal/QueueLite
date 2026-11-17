package com.queuelite.queue;

import com.queuelite.config.AppConfig;
import com.queuelite.web.ApiException;
import org.springframework.stereotype.Component;

/**
 * This deployment serves exactly one clinic. Refusing any other slug keeps a
 * guessed URL from reaching another clinic's queue.
 */
@Component
public class ClinicResolver {

    private final AppConfig config;
    private final QueueService queue;

    public ClinicResolver(AppConfig config, QueueService queue) {
        this.config = config;
        this.queue = queue;
    }

    public Clinic resolve(String slug) {
        if (!config.clinicSlug().equals(slug)) {
            throw ApiException.notFound("Clinic not found");
        }
        return queue.findClinic(slug).orElseThrow(() -> ApiException.notFound("Clinic not found"));
    }

    public Clinic configured() {
        return resolve(config.clinicSlug());
    }
}
