package com.queuelite.support;

import com.queuelite.config.BackgroundTasks;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

@TestConfiguration
public class TestBeans {

    @Bean
    @Primary
    public MutableClock testClock() {
        return new MutableClock();
    }

    @Bean
    @Primary
    public RecordingNotifier recordingNotifier() {
        return new RecordingNotifier();
    }

    /** Runs background work inline, so a test can assert as soon as a request returns. */
    @Bean
    @Primary
    public BackgroundTasks inlineTasks() {
        return new BackgroundTasks() {
            @Override
            public void execute(Runnable task) {
                task.run();
            }
        };
    }
}
