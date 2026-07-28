import { describe, expect, it } from "vitest";

// warmPoolSizes is computed from WARM_POOL when config.ts is first imported, so
// set the env before dynamically importing the provider (static imports would
// be hoisted above this line and load config with the default empty pool).
process.env.WARM_POOL = "minecraft=2";

const { DockerProvider } = await import("../src/provisioning/docker.js");
const { FakeDocker } = await import("./fake-docker.js");

const LABEL_MANAGED = "dev.switchboard.managed";
const LABEL_GAME = "dev.switchboard.game";
const LABEL_VOLUME = "dev.switchboard.volume";

function newProvider() {
  const docker = new FakeDocker();
  const provider = new DockerProvider(docker.asDocker());
  return { docker, provider };
}

describe("reconcilePool", () => {
  it("warms the pool up to the configured size", async () => {
    const { docker, provider } = newProvider();
    await provider.reconcilePool();

    expect(docker.createCalls).toHaveLength(2);
    for (const call of docker.createCalls) {
      expect(call.name).toMatch(/^sb-pool-minecraft-[0-9a-f]{6}$/);
      expect(call.Labels?.[LABEL_GAME]).toBe("minecraft");
      // Pool members boot with a placeholder name, not a user's server name.
      expect(call.Env).toContain("MOTD=switchboard");
    }
  });

  it("is idempotent once the pool is full", async () => {
    const { docker, provider } = newProvider();
    await provider.reconcilePool();
    await provider.reconcilePool();
    expect(docker.createCalls).toHaveLength(2);
  });

  it("drains members beyond the configured size", async () => {
    const { docker, provider } = newProvider();
    await provider.reconcilePool();
    docker.addContainer({
      name: "sb-pool-minecraft-extra1",
      Labels: {
        [LABEL_MANAGED]: "true",
        [LABEL_GAME]: "minecraft",
        [LABEL_VOLUME]: "switchboard-pool-minecraft-extra1",
      },
    });
    docker.volumes.add("switchboard-pool-minecraft-extra1");

    await provider.reconcilePool();
    const poolNames = docker.containers.map((c) => c.Names[0]);
    expect(poolNames).toHaveLength(2);
    expect(poolNames).not.toContain("/sb-pool-minecraft-extra1");
    expect(docker.volumes.has("switchboard-pool-minecraft-extra1")).toBe(false);
  });

  it("drains members for games no longer in the warm pool config", async () => {
    const { docker, provider } = newProvider();
    docker.addContainer({
      name: "sb-pool-valheim-old111",
      Labels: {
        [LABEL_MANAGED]: "true",
        [LABEL_GAME]: "valheim",
        [LABEL_VOLUME]: "switchboard-pool-valheim-old111",
      },
    });
    docker.volumes.add("switchboard-pool-valheim-old111");

    await provider.reconcilePool();
    expect(
      docker.containers.some((c) => c.Names[0] === "/sb-pool-valheim-old111"),
    ).toBe(false);
    expect(docker.volumes.has("switchboard-pool-valheim-old111")).toBe(false);
  });
});
