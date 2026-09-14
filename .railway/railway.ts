import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

// The runner is a single persistent service. Applying this file is
// intentionally separate from deploying application code: use `railway
// config plan` first and review its readback before `railway config apply`.
export default defineRailway((_ctx) => {
  const data = volume("sandra-repair-data", { sizeMB: 512 });
  const runner = service("sandra-sentry-repair", {
    source: github("biginkc/sandra", { branch: "main" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "deployment/sentry-repair/Dockerfile",
    },
    // This invokes the image's root bootstrap and then drops to UID 10001.
    start: "/usr/local/bin/sandra-sentry-repair-entrypoint",
    healthcheck: "/readyz",
    healthcheckTimeout: 300,
    replicas: 1,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    volumeMounts: {
      "/data": data,
    },
    env: {
      SANDRA_REPAIR_VOLUME_PATH: "/data",
      SANDRA_REPAIR_DB_PATH: "/data/repair.db",
      SANDRA_GITHUB_PUBLISH_ENABLED: "false",
      SANDRA_REPAIR_DISPATCH_ENABLED: "false",
      SANDRA_GITHUB_REPOSITORY: "biginkc/sandra",
      SENTRY_AUTH_TOKEN: preserve(),
      SANDRA_GITHUB_APP_ID: preserve(),
      SANDRA_GITHUB_INSTALLATION_ID: preserve(),
      SANDRA_GITHUB_APP_PRIVATE_KEY: preserve(),
    },
  });

  return project("sandra-sentry-repair", { resources: [data, runner] });
});
