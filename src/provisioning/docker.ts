import { randomBytes } from 'node:crypto';
import Docker from 'dockerode';
import { config, warmPoolSizes } from '../config.js';
import { games, type GameTemplate } from '../games.js';
import {
  type CreateResult,
  type GameServerInfo,
  type PortMapping,
  type RemoveResult,
  type ServerProvider,
  UserError,
} from './provider.js';

const LABEL_MANAGED = 'dev.switchboard.managed';
const LABEL_GAME = 'dev.switchboard.game';
const LABEL_PORTS = 'dev.switchboard.ports';
const LABEL_VOLUME = 'dev.switchboard.volume';
// Join password for games that need one. Env vars are baked at creation, so the
// bot keeps a copy on the container to show the creator; anyone who can read
// labels already has the Docker socket (root), so this adds no new exposure.
const LABEL_PASSWORD = 'dev.switchboard.password';

// The user-facing server name lives in the container name (labels are immutable,
// container names are not — claiming a warm pool server is a single rename).
const CONTAINER_PREFIX = 'sb-';
const POOL_PREFIX = 'sb-pool-';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export class DockerProvider implements ServerProvider {
  private docker: Docker;
  private pulls = new Map<string, Promise<void>>();
  private reconciling = false;
  /** containerId -> consecutive one-minute samples below the idle CPU threshold. */
  private idleSamples = new Map<string, number>();

  constructor(docker = new Docker({ socketPath: config.DOCKER_SOCKET })) {
    this.docker = docker;
  }

  async create(template: GameTemplate, name: string): Promise<CreateResult> {
    if (!NAME_PATTERN.test(name) || name.startsWith('pool-')) {
      throw new UserError(
        'Server names must be 3-32 characters of lowercase letters, numbers, and hyphens, and may not start with `pool-`.',
      );
    }
    if (await this.findClaimed(name)) {
      throw new UserError(`A server named \`${name}\` already exists.`);
    }

    // A kept volume from a previously removed server takes priority: cold-create
    // on top of it so the world comes back, rather than handing out a fresh pool server.
    const namedVolume = `switchboard-${name}`;
    if (await this.volumeExists(namedVolume)) {
      await this.coldCreate(template, {
        container: CONTAINER_PREFIX + name,
        volume: namedVolume,
        envName: name,
      });
      return { info: await this.status(name), source: 'existing-data' };
    }

    const warm = await this.takeWarmContainer(template.id, name);
    if (warm) {
      this.replenishPoolSoon();
      return { info: await this.status(name), source: 'warm-pool' };
    }

    await this.coldCreate(template, {
      container: CONTAINER_PREFIX + name,
      volume: namedVolume,
      envName: name,
    });
    return { info: await this.status(name), source: 'cold' };
  }

  async start(name: string): Promise<GameServerInfo> {
    const info = await this.mustFindClaimed(name);
    if (info.State === 'running') {
      throw new UserError(`\`${name}\` is already running.`);
    }
    await this.docker.getContainer(info.Id).start();
    return this.status(name);
  }

  async stop(name: string): Promise<GameServerInfo> {
    const info = await this.mustFindClaimed(name);
    if (info.State !== 'running') {
      throw new UserError(`\`${name}\` is not running.`);
    }
    await this.docker.getContainer(info.Id).stop();
    return this.status(name);
  }

  async remove(name: string, deleteData: boolean): Promise<RemoveResult> {
    const info = await this.mustFindClaimed(name);
    const volume = info.Labels[LABEL_VOLUME] ?? `switchboard-${name}`;
    await this.docker.getContainer(info.Id).remove({ force: true });
    this.idleSamples.delete(info.Id);
    if (deleteData) {
      await this.docker.getVolume(volume).remove().catch(() => {});
    }
    return {
      volume,
      dataDeleted: deleteData,
      // Pool-allocated servers keep their randomly named pool volume, which
      // create-by-name won't rediscover.
      reusableByName: !deleteData && volume === `switchboard-${name}`,
    };
  }

  async list(): Promise<GameServerInfo[]> {
    const containers = await this.listManaged();
    return containers.filter((c) => !isPool(c)).map(toInfo);
  }

  async status(name: string): Promise<GameServerInfo> {
    return toInfo(await this.mustFindClaimed(name));
  }

  /** Current warm pool members (for display). */
  async poolStatus(): Promise<Array<{ game: string; state: string }>> {
    const containers = await this.listManaged();
    return containers
      .filter(isPool)
      .map((c) => ({ game: c.Labels[LABEL_GAME] ?? 'unknown', state: c.State }));
  }

  /** Pull every game image that isn't already present, so cold creates skip the pull. */
  async prePullAll(): Promise<void> {
    await Promise.all(
      Object.values(games).map(async (template) => {
        try {
          await this.pullImage(template.image);
          console.log(`[images] ${template.image} ready`);
        } catch (error) {
          console.error(`[images] failed to pull ${template.image}:`, error);
        }
      }),
    );
  }

  /** Bring the warm pool to the sizes configured in WARM_POOL; drain anything no longer wanted. */
  async reconcilePool(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const pool = (await this.listManaged()).filter(isPool);

      for (const [gameId, target] of Object.entries(warmPoolSizes)) {
        const template = games[gameId];
        if (!template) continue;
        const members = pool.filter((c) => c.Labels[LABEL_GAME] === gameId);

        for (let i = members.length; i < target; i++) {
          const suffix = randomBytes(3).toString('hex');
          console.log(`[pool] warming a ${gameId} server (${suffix})`);
          await this.coldCreate(template, {
            container: `${POOL_PREFIX}${gameId}-${suffix}`,
            volume: `switchboard-pool-${gameId}-${suffix}`,
            envName: 'switchboard',
          });
        }

        for (const extra of members.slice(target)) {
          await this.removePoolMember(extra);
        }
      }

      for (const member of pool) {
        const gameId = member.Labels[LABEL_GAME] ?? '';
        if (!(gameId in warmPoolSizes)) {
          await this.removePoolMember(member);
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Stop claimed servers whose CPU has stayed below the idle threshold for
   * IDLE_MINUTES consecutive one-minute samples. A heuristic for "no players
   * online" that works across games without game-specific query protocols.
   */
  async reapIdle(): Promise<void> {
    const running = (await this.listManaged()).filter((c) => !isPool(c) && c.State === 'running');
    const seen = new Set<string>();

    for (const container of running) {
      seen.add(container.Id);
      const cpu = await this.cpuPercent(container.Id).catch(() => null);
      if (cpu === null) continue;

      const count = cpu < config.IDLE_CPU_PERCENT ? (this.idleSamples.get(container.Id) ?? 0) + 1 : 0;
      this.idleSamples.set(container.Id, count);

      if (count >= config.IDLE_MINUTES) {
        const name = displayName(container);
        console.log(`[idle] stopping \`${name}\` — cpu below ${config.IDLE_CPU_PERCENT}% for ${count} minutes`);
        this.idleSamples.delete(container.Id);
        await this.docker
          .getContainer(container.Id)
          .stop()
          .catch((error) => console.error(`[idle] failed to stop ${name}:`, error));
      }
    }

    for (const id of this.idleSamples.keys()) {
      if (!seen.has(id)) this.idleSamples.delete(id);
    }
  }

  /** Claim a warm pool server by renaming it; returns false if the pool is empty for this game. */
  private async takeWarmContainer(gameId: string, name: string): Promise<boolean> {
    const pool = (await this.listManaged()).filter(
      (c) => isPool(c) && c.Labels[LABEL_GAME] === gameId,
    );
    // Prefer a running (fully booted) member, but a starting one still beats a cold create.
    const warm = pool.find((c) => c.State === 'running') ?? pool[0];
    if (!warm) return false;

    const container = this.docker.getContainer(warm.Id);
    await container.rename({ name: CONTAINER_PREFIX + name });
    if (warm.State !== 'running') {
      await container.start().catch(() => {});
    }
    return true;
  }

  private replenishPoolSoon(): void {
    void this.reconcilePool().catch((error) => console.error('[pool] reconcile failed:', error));
  }

  private async removePoolMember(member: Docker.ContainerInfo): Promise<void> {
    console.log(`[pool] draining ${displayName(member)}`);
    await this.docker.getContainer(member.Id).remove({ force: true });
    const volume = member.Labels[LABEL_VOLUME];
    if (volume) {
      await this.docker.getVolume(volume).remove().catch(() => {});
    }
  }

  private async coldCreate(
    template: GameTemplate,
    opts: { container: string; volume: string; envName: string },
  ): Promise<void> {
    await this.pullImage(template.image);
    const hostPorts = await this.allocatePorts(template);
    const password = randomBytes(9).toString('base64url');

    const exposedPorts: Record<string, object> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    template.ports.forEach((spec, i) => {
      const containerPort = template.portMode === 'env' ? hostPorts[i] : spec.container;
      const protocols = spec.protocol === 'both' ? (['tcp', 'udp'] as const) : [spec.protocol];
      for (const protocol of protocols) {
        const key = `${containerPort}/${protocol}`;
        exposedPorts[key] = {};
        portBindings[key] = [{ HostPort: String(hostPorts[i]) }];
      }
    });

    const container = await this.docker.createContainer({
      name: opts.container,
      Image: template.image,
      Env: Object.entries(template.env(opts.envName, password, hostPorts)).map(
        ([k, v]) => `${k}=${v}`,
      ),
      Labels: {
        [LABEL_MANAGED]: 'true',
        [LABEL_GAME]: template.id,
        [LABEL_PORTS]: hostPorts.join(','),
        [LABEL_VOLUME]: opts.volume,
        ...(template.usesPassword ? { [LABEL_PASSWORD]: password } : {}),
      },
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        Binds: [`${opts.volume}:${template.dataDir}`],
        RestartPolicy: { Name: 'unless-stopped' },
      },
      StopTimeout: template.stopTimeoutSeconds,
    });
    await container.start();
  }

  private async listManaged(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });
  }

  private async findClaimed(name: string): Promise<Docker.ContainerInfo | undefined> {
    const containers = await this.listManaged();
    return containers.find(
      (c) => !isPool(c) && c.Names.some((n) => n === `/${CONTAINER_PREFIX}${name}`),
    );
  }

  private async mustFindClaimed(name: string): Promise<Docker.ContainerInfo> {
    const info = await this.findClaimed(name);
    if (!info) {
      throw new UserError(`No server named \`${name}\` found.`);
    }
    return info;
  }

  private async volumeExists(name: string): Promise<boolean> {
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch {
      return false;
    }
  }

  private pullImage(image: string): Promise<void> {
    const inFlight = this.pulls.get(image);
    if (inFlight) return inFlight;
    const pull = this.doPull(image).finally(() => this.pulls.delete(image));
    this.pulls.set(image, pull);
    return pull;
  }

  private async doPull(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      // Not present locally — pull it.
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async cpuPercent(containerId: string): Promise<number> {
    const stats = await this.docker.getContainer(containerId).stats({ stream: false });
    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage?.total_usage ?? 0);
    const systemDelta =
      (stats.cpu_stats.system_cpu_usage ?? 0) - (stats.precpu_stats.system_cpu_usage ?? 0);
    if (systemDelta <= 0) return 0;
    const cpus =
      stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    return (cpuDelta / systemDelta) * cpus * 100;
  }

  /**
   * Allocates a consecutive block of host ports for a new instance, starting at the
   * template's base port and skipping blocks already claimed by managed containers
   * (including warm pool members).
   */
  private async allocatePorts(template: GameTemplate): Promise<number[]> {
    const used = new Set<number>();
    for (const container of await this.listManaged()) {
      const ports = container.Labels[LABEL_PORTS];
      if (ports) {
        for (const port of ports.split(',')) used.add(Number(port));
      }
    }

    const blockSize = template.ports.length;
    for (let offset = 0; offset < 100; offset++) {
      const block = template.ports.map((_, i) => template.basePort + offset * blockSize + i);
      if (block.every((port) => !used.has(port))) return block;
    }
    throw new UserError(`No free ports left for ${template.label} servers.`);
  }
}

function rawName(container: Docker.ContainerInfo): string {
  return container.Names[0]?.slice(1) ?? '';
}

function isPool(container: Docker.ContainerInfo): boolean {
  return rawName(container).startsWith(POOL_PREFIX);
}

function displayName(container: Docker.ContainerInfo): string {
  const name = rawName(container);
  return name.startsWith(CONTAINER_PREFIX) ? name.slice(CONTAINER_PREFIX.length) : name;
}

function toInfo(container: Docker.ContainerInfo): GameServerInfo {
  const ports: PortMapping[] = [];
  for (const p of container.Ports ?? []) {
    if (p.PublicPort) {
      ports.push({
        host: p.PublicPort,
        container: p.PrivatePort,
        protocol: p.Type === 'udp' ? 'udp' : 'tcp',
      });
    }
  }
  return {
    name: displayName(container),
    game: container.Labels[LABEL_GAME] ?? 'unknown',
    state: container.State,
    status: container.Status,
    ports,
    password: container.Labels[LABEL_PASSWORD],
  };
}

export const dockerProvider = new DockerProvider();
