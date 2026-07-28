import { describe, expect, it } from "vitest";
import { games } from "../src/games.js";
import { DockerProvider } from "../src/provisioning/docker.js";
import { UserError } from "../src/provisioning/provider.js";
import { type FakeContainer, FakeDocker } from "./fake-docker.js";

const LABEL = {
  managed: "dev.switchboard.managed",
  game: "dev.switchboard.game",
  ports: "dev.switchboard.ports",
  volume: "dev.switchboard.volume",
  password: "dev.switchboard.password",
};

function newProvider() {
  const docker = new FakeDocker();
  const provider = new DockerProvider(docker.asDocker());
  return { docker, provider };
}

function addPoolMember(
  docker: FakeDocker,
  gameId: string,
  suffix = "abc123",
  state = "running",
): FakeContainer {
  return docker.addContainer({
    name: `sb-pool-${gameId}-${suffix}`,
    State: state,
    Labels: {
      [LABEL.managed]: "true",
      [LABEL.game]: gameId,
      [LABEL.ports]: String(games[gameId]?.basePort ?? 0),
      [LABEL.volume]: `switchboard-pool-${gameId}-${suffix}`,
    },
  });
}

function mustFind(docker: FakeDocker, containerName: string): FakeContainer {
  const container = docker.containers.find(
    (c) => c.Names[0] === `/${containerName}`,
  );
  if (!container) throw new Error(`container ${containerName} not found`);
  return container;
}

describe("create: name validation", () => {
  const invalidNames = [
    "ab", // too short
    "UpperCase",
    "under_score",
    "-leading-hyphen",
    "trailing-hyphen-",
    "pool-sneaky", // reserved prefix
    "a".repeat(33), // too long
  ];

  for (const name of invalidNames) {
    it(`rejects "${name}"`, async () => {
      const { provider } = newProvider();
      await expect(provider.create(games.minecraft, name)).rejects.toThrow(
        UserError,
      );
    });
  }

  it("rejects a name that is already claimed", async () => {
    const { provider } = newProvider();
    await provider.create(games.minecraft, "taken");
    await expect(provider.create(games.minecraft, "taken")).rejects.toThrow(
      /already exists/,
    );
  });
});

describe("create: cold provisioning", () => {
  it("creates, labels, and starts a container from scratch", async () => {
    const { docker, provider } = newProvider();
    const { info, source } = await provider.create(games.minecraft, "mc-one");

    expect(source).toBe("cold");
    expect(docker.createCalls).toHaveLength(1);
    const call = docker.createCalls[0];
    expect(call?.name).toBe("sb-mc-one");
    expect(call?.Labels).toMatchObject({
      [LABEL.managed]: "true",
      [LABEL.game]: "minecraft",
      [LABEL.ports]: "25565",
      [LABEL.volume]: "switchboard-mc-one",
    });
    expect(call?.Env).toContain("EULA=TRUE");
    expect(call?.Env).toContain("MOTD=mc-one");
    expect(call?.StopTimeout).toBe(60);
    expect(call?.HostConfig?.Binds).toEqual(["switchboard-mc-one:/data"]);
    expect(call?.HostConfig?.PortBindings).toEqual({
      "25565/tcp": [{ HostPort: "25565" }],
    });

    expect(info.state).toBe("running");
    expect(info.game).toBe("minecraft");
    expect(info.ports).toEqual([
      { host: 25565, container: 25565, protocol: "tcp" },
    ]);
  });

  it("stores the password label only for games that use one", async () => {
    const { docker, provider } = newProvider();
    await provider.create(games.minecraft, "no-pass");
    await provider.create(games.valheim, "with-pass");

    expect(docker.createCalls[0]?.Labels?.[LABEL.password]).toBeUndefined();
    const password = docker.createCalls[1]?.Labels?.[LABEL.password];
    expect(password).toBeTruthy();
    // The password shown to the creator must be the one the server was configured with.
    expect(docker.createCalls[1]?.Env).toContain(`SERVER_PASS=${password}`);
  });

  it("binds tcp and udp for 'both' protocol ports", async () => {
    const { docker, provider } = newProvider();
    await provider.create(games["7dtd"], "seven");
    const bindings = docker.createCalls[0]?.HostConfig?.PortBindings as Record<
      string,
      unknown
    >;
    expect(Object.keys(bindings)).toContain("26900/tcp");
    expect(Object.keys(bindings)).toContain("26900/udp");
    expect(Object.keys(bindings)).toContain("26901/udp");
  });
});

describe("create: port allocation", () => {
  it("allocates the next consecutive block when the base block is taken", async () => {
    const { docker, provider } = newProvider();
    await provider.create(games.valheim, "first");
    await provider.create(games.valheim, "second");

    expect(docker.createCalls[0]?.Labels?.[LABEL.ports]).toBe("2456,2457");
    expect(docker.createCalls[1]?.Labels?.[LABEL.ports]).toBe("2458,2459");
  });

  it("counts warm pool members' ports as used", async () => {
    const { docker, provider } = newProvider();
    addPoolMember(docker, "minecraft"); // holds 25565
    await provider.create(games.factorio, "fact"); // unrelated ports, sanity
    await provider.create(games.valheim, "vik"); // 2456 free → gets base block

    expect(docker.createCalls[1]?.Labels?.[LABEL.ports]).toBe("2456,2457");
  });

  it("in env port mode, binds host port on both sides and passes it via env", async () => {
    const { docker, provider } = newProvider();
    docker.addContainer({
      name: "sb-existing",
      Labels: { [LABEL.managed]: "true", [LABEL.ports]: "27015" },
    });
    await provider.create(games.tf2, "fortress");

    const call = docker.createCalls[0];
    expect(call?.Labels?.[LABEL.ports]).toBe("27016");
    expect(call?.HostConfig?.PortBindings).toEqual({
      "27016/udp": [{ HostPort: "27016" }],
    });
    expect(call?.Env).toContain("SRCDS_PORT=27016");
  });

  it("throws a user-facing error when no port blocks are left", async () => {
    const { docker, provider } = newProvider();
    const allBlocks = Array.from({ length: 100 }, (_, i) => 34_197 + i);
    docker.addContainer({
      name: "sb-hog",
      Labels: { [LABEL.managed]: "true", [LABEL.ports]: allBlocks.join(",") },
    });
    await expect(provider.create(games.factorio, "overflow")).rejects.toThrow(
      /No free ports left/,
    );
  });
});

describe("create: reuse paths", () => {
  it("recreates on top of a kept volume instead of using the pool", async () => {
    const { docker, provider } = newProvider();
    docker.volumes.add("switchboard-oldworld");
    addPoolMember(docker, "minecraft");

    const { source } = await provider.create(games.minecraft, "oldworld");
    expect(source).toBe("existing-data");
    expect(docker.createCalls[0]?.HostConfig?.Binds).toEqual([
      "switchboard-oldworld:/data",
    ]);
  });

  it("claims a warm pool server by renaming it", async () => {
    const { docker, provider } = newProvider();
    const member = addPoolMember(docker, "minecraft");

    const { info, source } = await provider.create(games.minecraft, "fresh");
    expect(source).toBe("warm-pool");
    expect(member.Names).toEqual(["/sb-fresh"]);
    expect(docker.createCalls).toHaveLength(0);
    expect(info.name).toBe("fresh");
  });

  it("prefers a running pool member over one still booting", async () => {
    const { docker, provider } = newProvider();
    const booting = addPoolMember(docker, "minecraft", "boot01", "created");
    const running = addPoolMember(docker, "minecraft", "ready1", "running");

    await provider.create(games.minecraft, "fresh");
    expect(running.Names).toEqual(["/sb-fresh"]);
    expect(booting.Names).toEqual(["/sb-pool-minecraft-boot01"]);
  });

  it("starts a claimed pool member that was not running yet", async () => {
    const { docker, provider } = newProvider();
    const member = addPoolMember(docker, "minecraft", "boot01", "created");

    await provider.create(games.minecraft, "fresh");
    expect(member.State).toBe("running");
  });
});

describe("start / stop / status", () => {
  it("starts a stopped server and rejects starting a running one", async () => {
    const { docker, provider } = newProvider();
    await provider.create(games.minecraft, "srv");
    await expect(provider.start("srv")).rejects.toThrow(/already running/);

    mustFind(docker, "sb-srv").State = "exited";
    const info = await provider.start("srv");
    expect(info.state).toBe("running");
  });

  it("stops a running server and rejects stopping a stopped one", async () => {
    const { provider } = newProvider();
    await provider.create(games.minecraft, "srv");
    const info = await provider.stop("srv");
    expect(info.state).toBe("exited");
    await expect(provider.stop("srv")).rejects.toThrow(/not running/);
  });

  it("throws a user-facing error for unknown names", async () => {
    const { provider } = newProvider();
    await expect(provider.status("ghost")).rejects.toThrow(/No server named/);
  });

  it("exposes the stored password in status", async () => {
    const { docker, provider } = newProvider();
    await provider.create(games.valheim, "vhs");
    const password = docker.createCalls[0]?.Labels?.[LABEL.password];
    const info = await provider.status("vhs");
    expect(info.password).toBe(password);
  });
});

describe("remove", () => {
  it("keeps the volume by default and reports it reusable by name", async () => {
    const { docker, provider } = newProvider();
    await provider.create(games.minecraft, "keeper");
    const result = await provider.remove("keeper", false);

    expect(result).toEqual({
      volume: "switchboard-keeper",
      dataDeleted: false,
      reusableByName: true,
    });
    expect(docker.volumes.has("switchboard-keeper")).toBe(true);
    expect(await provider.list()).toEqual([]);
  });

  it("deletes the volume when asked", async () => {
    const { docker, provider } = newProvider();
    await provider.create(games.minecraft, "goner");
    const result = await provider.remove("goner", true);

    expect(result.dataDeleted).toBe(true);
    expect(docker.volumes.has("switchboard-goner")).toBe(false);
  });

  it("marks pool-allocated volumes as not reusable by name", async () => {
    const { docker, provider } = newProvider();
    addPoolMember(docker, "minecraft");
    await provider.create(games.minecraft, "claimed");
    const result = await provider.remove("claimed", false);

    expect(result.volume).toBe("switchboard-pool-minecraft-abc123");
    expect(result.reusableByName).toBe(false);
  });
});

describe("list / poolStatus", () => {
  it("separates claimed servers from pool members", async () => {
    const { docker, provider } = newProvider();
    addPoolMember(docker, "minecraft");
    await provider.create(games.factorio, "belts");

    const servers = await provider.list();
    expect(servers.map((s) => s.name)).toEqual(["belts"]);

    const pool = await provider.poolStatus();
    expect(pool).toEqual([{ game: "minecraft", state: "running" }]);
  });
});

describe("reapIdle", () => {
  // IDLE_MINUTES is pinned to 3 and IDLE_CPU_PERCENT to 5 in test/setup.ts.
  it("stops a server only after the configured consecutive idle samples", async () => {
    const { docker, provider } = newProvider();
    await provider.create(games.minecraft, "lazy");
    const container = mustFind(docker, "sb-lazy");
    docker.cpu.set(container.Id, 1);

    await provider.reapIdle();
    await provider.reapIdle();
    expect(container.State).toBe("running");

    await provider.reapIdle();
    expect(container.State).toBe("exited");
  });

  it("resets the idle counter when CPU rises above the threshold", async () => {
    const { docker, provider } = newProvider();
    await provider.create(games.minecraft, "busy");
    const container = mustFind(docker, "sb-busy");

    docker.cpu.set(container.Id, 1);
    await provider.reapIdle();
    await provider.reapIdle();

    docker.cpu.set(container.Id, 50); // player activity
    await provider.reapIdle();

    docker.cpu.set(container.Id, 1);
    await provider.reapIdle();
    await provider.reapIdle();
    expect(container.State).toBe("running"); // only 2 consecutive idle samples

    await provider.reapIdle();
    expect(container.State).toBe("exited");
  });

  it("ignores pool members and stopped servers", async () => {
    const { docker, provider } = newProvider();
    const member = addPoolMember(docker, "minecraft");
    docker.cpu.set(member.Id, 0);

    await provider.reapIdle();
    await provider.reapIdle();
    await provider.reapIdle();
    expect(member.State).toBe("running");
  });
});
