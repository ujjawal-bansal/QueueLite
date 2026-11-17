package com.queuelite.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.queuelite.support.ApiTestBase;
import org.junit.jupiter.api.Test;

class ScryptTest {

    @Test
    void aHashMadeByTheNodeApiStillVerifies() {
        // The STAFF_PASSCODE_HASH already on Render must keep working.
        assertThat(Scrypt.verify(ApiTestBase.PASSCODE, ApiTestBase.PASSCODE_HASH, "STAFF_PASSCODE_HASH")).isTrue();
    }

    @Test
    void wrongEmptyAndNonStringPasscodesAreRejected() {
        String hash = ApiTestBase.PASSCODE_HASH;
        assertThat(Scrypt.verify("front-desk-2025", hash, "STAFF_PASSCODE_HASH")).isFalse();
        assertThat(Scrypt.verify("", hash, "STAFF_PASSCODE_HASH")).isFalse();
        assertThat(Scrypt.verify(null, hash, "STAFF_PASSCODE_HASH")).isFalse();
        assertThat(Scrypt.verify(12345, hash, "STAFF_PASSCODE_HASH")).isFalse();
    }

    @Test
    void aNewHashRoundTrips() {
        String hash = Scrypt.hash("a new passcode");
        assertThat(hash).matches("scrypt\\$[0-9a-f]{32}\\$[0-9a-f]{128}");
        assertThat(Scrypt.verify("a new passcode", hash, "STAFF_PASSCODE_HASH")).isTrue();
    }

    @Test
    void aMalformedStoredHashIsAConfigurationErrorNotAWrongGuess() {
        assertThatThrownBy(() -> Scrypt.verify("x", "not-a-hash", "STAFF_PASSCODE_HASH"))
                .hasMessageContaining("STAFF_PASSCODE_HASH is malformed");
    }
}
