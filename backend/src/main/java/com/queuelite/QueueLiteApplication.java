package com.queuelite;

import com.queuelite.cli.Tools;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class QueueLiteApplication {

    public static void main(String[] args) throws Exception {
        // `java -jar queuelite-api.jar hash-passcode` and friends run a one-off
        // tool instead of the server. See Tools for the list.
        if (args.length > 0 && Tools.handles(args[0])) {
            System.exit(Tools.run(args));
        }

        // Structured JSON logs in production, readable lines locally.
        String env = System.getenv().getOrDefault("APP_ENV", System.getenv().getOrDefault("NODE_ENV", ""));
        if (env.equals("production") && System.getProperty("logging.structured.format.console") == null) {
            System.setProperty("logging.structured.format.console", "logstash");
        }

        SpringApplication.run(QueueLiteApplication.class, args);
    }
}
