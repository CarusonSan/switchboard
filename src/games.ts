export interface PortSpec {
  container: number;
  protocol: 'tcp' | 'udp';
}

export interface GameTemplate {
  id: string;
  label: string;
  image: string;
  /** First host port to try; instances are allocated consecutive blocks from here. */
  basePort: number;
  ports: PortSpec[];
  /** `password` is a random per-server secret; templates that need one pass it through. */
  env: (name: string, password: string) => Record<string, string>;
  /** True if the template consumes the generated password (it will be shown to the creator). */
  usesPassword?: boolean;
  /** Path inside the container that holds world/save data, persisted to a named volume. */
  dataDir: string;
  /** Grace period before the container is killed on stop — game servers need time to save. */
  stopTimeoutSeconds: number;
}

export const games: Record<string, GameTemplate> = {
  minecraft: {
    id: 'minecraft',
    label: 'Minecraft (Java)',
    image: 'itzg/minecraft-server:latest',
    basePort: 25565,
    ports: [{ container: 25565, protocol: 'tcp' }],
    env: (name) => ({
      EULA: 'TRUE',
      MOTD: name,
      MEMORY: '2G',
    }),
    dataDir: '/data',
    stopTimeoutSeconds: 60,
  },
  valheim: {
    id: 'valheim',
    label: 'Valheim',
    image: 'lloesche/valheim-server:latest',
    basePort: 2456,
    ports: [
      { container: 2456, protocol: 'udp' },
      { container: 2457, protocol: 'udp' },
    ],
    env: (name, password) => ({
      SERVER_NAME: name,
      WORLD_NAME: name,
      SERVER_PASS: password,
      SERVER_PUBLIC: 'false',
    }),
    usesPassword: true,
    dataDir: '/config',
    stopTimeoutSeconds: 120,
  },
  factorio: {
    id: 'factorio',
    label: 'Factorio',
    image: 'factoriotools/factorio:stable',
    basePort: 34197,
    ports: [{ container: 34197, protocol: 'udp' }],
    env: () => ({}),
    dataDir: '/factorio',
    stopTimeoutSeconds: 60,
  },
};
