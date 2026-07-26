import { randomBytes } from "node:crypto";

/**
 * Secondary secret for admin/RCON credentials that should not be posted to
 * Discord. Recoverable on the host via `docker inspect` if ever needed.
 */
const internalSecret = () => randomBytes(9).toString("base64url");

export interface PortSpec {
  /** Port the server binds inside the container (ignored when portMode is 'env'). */
  container: number;
  /** 'both' binds tcp and udp on the same number (Source engine style). */
  protocol: "tcp" | "udp" | "both";
}

export interface GameTemplate {
  id: string;
  label: string;
  image: string;
  /** First host port to try; instances are allocated consecutive blocks from here. */
  basePort: number;
  ports: PortSpec[];
  /**
   * 'nat' (default): the container binds its fixed ports and Docker maps allocated
   * host ports onto them. 'env': the server is told its allocated ports via env
   * (see the `ports` argument to `env()`) and binds them directly, so host and
   * container ports match — required by games that advertise their port to Steam.
   */
  portMode?: "nat" | "env";
  /**
   * `password` is a random per-server secret; templates that need one pass it through.
   * `ports` is the allocated host port block, in the same order as the `ports` array.
   */
  env: (
    name: string,
    password: string,
    ports: number[],
  ) => Record<string, string>;
  /** True if the template consumes the generated password (it will be shown to the creator). */
  usesPassword?: boolean;
  /** How to present the password to the creator (default "Join password"). */
  passwordLabel?: string;
  /** Rough RAM the server needs while running, for docs and sizing guidance. */
  approxMemoryGB?: number;
  /** Path inside the container that holds world/save data, persisted to a named volume. */
  dataDir: string;
  /** Grace period before the container is killed on stop — game servers need time to save. */
  stopTimeoutSeconds: number;
}

export const games: Record<string, GameTemplate> = {
  minecraft: {
    id: "minecraft",
    label: "Minecraft (Java)",
    image: "itzg/minecraft-server:latest",
    basePort: 25565,
    ports: [{ container: 25565, protocol: "tcp" }],
    env: (name) => ({
      EULA: "TRUE",
      MOTD: name,
      MEMORY: "2G",
    }),
    dataDir: "/data",
    stopTimeoutSeconds: 60,
    approxMemoryGB: 3,
  },
  valheim: {
    id: "valheim",
    label: "Valheim",
    image: "lloesche/valheim-server:latest",
    basePort: 2456,
    ports: [
      { container: 2456, protocol: "udp" },
      { container: 2457, protocol: "udp" },
    ],
    env: (name, password) => ({
      SERVER_NAME: name,
      WORLD_NAME: name,
      SERVER_PASS: password,
      SERVER_PUBLIC: "false",
    }),
    usesPassword: true,
    dataDir: "/config",
    stopTimeoutSeconds: 120,
    approxMemoryGB: 4,
  },
  factorio: {
    id: "factorio",
    label: "Factorio",
    image: "factoriotools/factorio:stable",
    basePort: 34197,
    ports: [{ container: 34197, protocol: "udp" }],
    env: () => ({}),
    dataDir: "/factorio",
    stopTimeoutSeconds: 60,
    approxMemoryGB: 2,
  },
  gmod: {
    id: "gmod",
    label: "Garry's Mod",
    image: "gameservermanagers/gameserver:gmod",
    basePort: 27015,
    // 27015/udp carries game traffic + Steam query; 27015/tcp is RCON and stays unpublished.
    // LinuxGSM has no port env vars — config lives in /data/config-lgsm after first boot.
    ports: [{ container: 27015, protocol: "udp" }],
    env: () => ({}),
    dataDir: "/data",
    stopTimeoutSeconds: 60,
    approxMemoryGB: 2,
  },
  tf2: {
    id: "tf2",
    label: "Team Fortress 2",
    image: "cm2network/tf2:latest",
    basePort: 27015,
    ports: [{ container: 27015, protocol: "udp" }],
    portMode: "env",
    env: (name, password, ports) => ({
      SRCDS_HOSTNAME: name,
      SRCDS_PW: password,
      SRCDS_RCONPW: internalSecret(),
      SRCDS_PORT: String(ports[0]),
    }),
    usesPassword: true,
    dataDir: "/home/steam/tf-dedicated",
    stopTimeoutSeconds: 60,
    approxMemoryGB: 2,
  },
  zps: {
    id: "zps",
    label: "Zombie Panic! Source",
    image: "ich777/steamcmd:zombiepanic",
    basePort: 27015,
    ports: [{ container: 27015, protocol: "udp" }],
    portMode: "env",
    env: (name, _password, ports) => ({
      GAME_PORT: String(ports[0]),
      GAME_PARAMS: `-secure +maxplayers 24 +map zpo_biotec +hostname "${name}"`,
    }),
    dataDir: "/serverdata/serverfiles",
    stopTimeoutSeconds: 60,
    approxMemoryGB: 4,
  },
  zomboid: {
    id: "zomboid",
    label: "Project Zomboid",
    image: "danixu86/project-zomboid-dedicated-server:latest",
    basePort: 16261,
    ports: [
      { container: 16261, protocol: "udp" },
      { container: 16262, protocol: "udp" },
      { container: 8766, protocol: "udp" },
      { container: 8767, protocol: "udp" },
    ],
    portMode: "env",
    env: (name, password, ports) => ({
      SERVERNAME: name,
      DISPLAYNAME: name,
      ADMINPASSWORD: password,
      PORT: String(ports[0]),
      UDPPORT: String(ports[1]),
      STEAMPORT1: String(ports[2]),
      STEAMPORT2: String(ports[3]),
    }),
    usesPassword: true,
    passwordLabel: "Admin password",
    dataDir: "/home/steam/Zomboid",
    stopTimeoutSeconds: 120,
    approxMemoryGB: 4,
  },
  ark: {
    id: "ark",
    label: "ARK: Survival Evolved",
    image: "hermsi/ark-server:latest",
    basePort: 7777,
    // ARK's raw UDP socket must be exactly game port + 1; consecutive block
    // allocation guarantees that. 27020/tcp RCON stays unpublished.
    ports: [
      { container: 7777, protocol: "udp" },
      { container: 7778, protocol: "udp" },
      { container: 27015, protocol: "udp" },
    ],
    portMode: "env",
    env: (name, password, ports) => ({
      SESSION_NAME: name,
      SERVER_PASSWORD: password,
      ADMIN_PASSWORD: internalSecret(),
      GAME_CLIENT_PORT: String(ports[0]),
      UDP_SOCKET_PORT: String(ports[1]),
      SERVER_LIST_PORT: String(ports[2]),
    }),
    usesPassword: true,
    dataDir: "/app",
    stopTimeoutSeconds: 300,
    approxMemoryGB: 8,
  },
  rust: {
    id: "rust",
    label: "Rust",
    image: "didstopia/rust-server:latest",
    basePort: 28015,
    // Rust has no join-password concept; the generated secret secures RCON
    // instead (28016/tcp, which stays unpublished — only udp is bound to host).
    ports: [
      { container: 28015, protocol: "udp" },
      { container: 28016, protocol: "udp" },
    ],
    portMode: "env",
    env: (name, _password, ports) => ({
      RUST_SERVER_NAME: name,
      RUST_SERVER_IDENTITY: name,
      RUST_SERVER_PORT: String(ports[0]),
      RUST_SERVER_QUERYPORT: String(ports[1]),
      RUST_RCON_PASSWORD: internalSecret(),
      RUST_UPDATE_CHECKING: "1",
    }),
    dataDir: "/steamcmd/rust",
    stopTimeoutSeconds: 120,
    approxMemoryGB: 8,
  },
  "7dtd": {
    id: "7dtd",
    label: "7 Days to Die",
    image: "vinanrra/7dtd-server:stable",
    basePort: 26900,
    // Ports are fixed in sdtdserver.xml (no env vars) — NAT mode. 8080/8081
    // web admin + telnet stay unpublished.
    ports: [
      { container: 26900, protocol: "both" },
      { container: 26901, protocol: "udp" },
      { container: 26902, protocol: "udp" },
      { container: 26903, protocol: "udp" },
    ],
    env: () => ({
      START_MODE: "1",
      VERSION: "stable",
    }),
    dataDir: "/home/sdtdserver",
    stopTimeoutSeconds: 180,
    approxMemoryGB: 8,
  },
};
