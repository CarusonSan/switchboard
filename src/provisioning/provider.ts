import type { GameTemplate } from "../games.js";

export interface PortMapping {
  host: number;
  container: number;
  protocol: "tcp" | "udp";
}

export interface GameServerInfo {
  name: string;
  game: string;
  /** Docker-style state: running, exited, created, ... */
  state: string;
  /** Human-readable status, e.g. "Up 2 hours". */
  status: string;
  ports: PortMapping[];
  /** Join password, present for games that use one (generated per server). */
  password?: string;
}

/** How a create request was fulfilled. */
export type CreateSource =
  /** Claimed an already-booted server from the warm pool — ready immediately. */
  | "warm-pool"
  /** Recreated on top of a kept data volume from a previously removed server. */
  | "existing-data"
  /** Created from scratch. */
  | "cold";

export interface CreateResult {
  info: GameServerInfo;
  source: CreateSource;
}

export interface RemoveResult {
  /** Name of the data volume that held the world. */
  volume: string;
  dataDeleted: boolean;
  /** True if recreating a server with the same name will automatically reuse the kept volume. */
  reusableByName: boolean;
}

/** Thrown for user-facing failures (bad input, name taken, not found) — safe to show in Discord. */
export class UserError extends Error {}

export interface ServerProvider {
  create(template: GameTemplate, name: string): Promise<CreateResult>;
  start(name: string): Promise<GameServerInfo>;
  stop(name: string): Promise<GameServerInfo>;
  /** Stops (if needed) and removes the server. World data is kept unless deleteData is true. */
  remove(name: string, deleteData: boolean): Promise<RemoveResult>;
  list(): Promise<GameServerInfo[]>;
  status(name: string): Promise<GameServerInfo>;
}
