import type Docker from "dockerode";

export interface FakeContainer {
  Id: string;
  Names: string[];
  State: string;
  Status: string;
  Labels: Record<string, string>;
  Ports: Array<{ PrivatePort: number; PublicPort?: number; Type: string }>;
}

let nextId = 1;

/** Builds the stats payload DockerProvider.cpuPercent() expects, reporting the given CPU %. */
function statsPayload(cpuPercent: number) {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: cpuPercent * 1_000 },
      system_cpu_usage: 100_000,
      online_cpus: 1,
    },
    precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
  };
}

/**
 * In-memory stand-in for dockerode covering the surface DockerProvider uses:
 * container listing/lifecycle, volumes, image inspection (images always
 * "present" so pulls are skipped), and per-container CPU stats.
 */
export class FakeDocker {
  containers: FakeContainer[] = [];
  volumes = new Set<string>();
  createCalls: Docker.ContainerCreateOptions[] = [];
  /** CPU % that stats() reports per container id (default 0). */
  cpu = new Map<string, number>();

  addContainer(
    overrides: Partial<Omit<FakeContainer, "Names">> & { name: string },
  ): FakeContainer {
    const container: FakeContainer = {
      Id: overrides.Id ?? `fake-${nextId++}`,
      Names: [`/${overrides.name}`],
      State: overrides.State ?? "running",
      Status: overrides.Status ?? "Up 5 minutes",
      Labels: overrides.Labels ?? {},
      Ports: overrides.Ports ?? [],
    };
    this.containers.push(container);
    return container;
  }

  asDocker(): Docker {
    return this as unknown as Docker;
  }

  private find(id: string): FakeContainer {
    const container = this.containers.find((c) => c.Id === id);
    if (!container) throw new Error(`no such container: ${id}`);
    return container;
  }

  async listContainers(): Promise<FakeContainer[]> {
    return [...this.containers];
  }

  getContainer(id: string) {
    return {
      start: async () => {
        this.find(id).State = "running";
      },
      stop: async () => {
        this.find(id).State = "exited";
      },
      remove: async () => {
        this.containers = this.containers.filter((c) => c.Id !== id);
      },
      rename: async ({ name }: { name: string }) => {
        this.find(id).Names = [`/${name}`];
      },
      stats: async () => statsPayload(this.cpu.get(id) ?? 0),
    };
  }

  getVolume(name: string) {
    return {
      inspect: async () => {
        if (!this.volumes.has(name)) throw new Error(`no such volume: ${name}`);
        return {};
      },
      remove: async () => {
        if (!this.volumes.delete(name)) {
          throw new Error(`no such volume: ${name}`);
        }
      },
    };
  }

  getImage(_name: string) {
    return { inspect: async () => ({}) };
  }

  async createContainer(opts: Docker.ContainerCreateOptions) {
    this.createCalls.push(opts);
    const ports: FakeContainer["Ports"] = [];
    const bindings = opts.HostConfig?.PortBindings as
      | Record<string, Array<{ HostPort: string }>>
      | undefined;
    for (const [key, binding] of Object.entries(bindings ?? {})) {
      const [portStr, proto] = key.split("/");
      ports.push({
        PrivatePort: Number(portStr),
        PublicPort: Number(binding[0]?.HostPort),
        Type: proto ?? "tcp",
      });
    }
    for (const bind of opts.HostConfig?.Binds ?? []) {
      const volume = bind.split(":")[0];
      if (volume) this.volumes.add(volume);
    }
    const container = this.addContainer({
      name: opts.name ?? "unnamed",
      State: "created",
      Status: "Created",
      Labels: opts.Labels ?? {},
      Ports: ports,
    });
    return {
      start: async () => {
        container.State = "running";
        container.Status = "Up 1 second";
      },
    };
  }
}
