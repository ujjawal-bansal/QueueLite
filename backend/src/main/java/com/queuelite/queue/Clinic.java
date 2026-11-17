package com.queuelite.queue;

import java.util.UUID;

/**
 * The one clinic this deployment serves. Name, doctor, hours and pace all live
 * on the row, so changing any of them takes effect without a deploy.
 */
public record Clinic(
        UUID id,
        String name,
        String slug,
        String doctorName,
        String address,
        String phone,
        String mapsUrl,
        // Postgres `time` as text ("18:00:00"), the shape the frontend expects.
        String opensAt,
        String closesAt,
        Integer avgConsultMinutes) {

    /** What a patient may see: everything on its Google listing, nothing about the queue. */
    public record Public(
            UUID id, String name, String slug, String doctorName, String address,
            String phone, String mapsUrl, String opensAt, String closesAt) {}

    public Public toPublic() {
        return new Public(id, name, slug, doctorName, address, phone, mapsUrl, opensAt, closesAt);
    }
}
