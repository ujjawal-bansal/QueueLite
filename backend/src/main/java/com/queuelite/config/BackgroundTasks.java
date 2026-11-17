package com.queuelite.config;

import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.stereotype.Component;

/**
 * Where reminder passes and webhook replies run: off the request path, so a
 * slow WhatsApp call never sits between the desk and their button. One virtual
 * thread per task; the tests swap in an inline version so they can assert on
 * what was sent without waiting.
 */
@Component
public class BackgroundTasks implements Executor, DisposableBean {

    private final ExecutorService delegate = Executors.newVirtualThreadPerTaskExecutor();

    @Override
    public void execute(Runnable task) {
        delegate.execute(task);
    }

    @Override
    public void destroy() {
        delegate.close();
    }
}
