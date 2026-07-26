# Switchboard

Discord bot for provisioning and deprovisioning game servers. Each game server runs as a Docker container on the host, with world data persisted to a named volume so servers can be removed and recreated without losing saves.

Supported games out of the box (add more by extending `src/games.ts`):

| Game | Image | Player ports (first instance) | RAM | First boot |
| --- | --- | --- | --- | --- |
| Minecraft (Java) | `itzg/minecraft-server` | 25565/tcp | ~3 GB | fast |
| Valheim | `lloesche/valheim-server` | 2456-2457/udp | ~4 GB | ~1 GB download |
| Factorio | `factoriotools/factorio` | 34197/udp | ~2 GB | fast |
| Garry's Mod | `gameservermanagers/gameserver:gmod` | 27015/udp | ~2 GB | ~3-5 GB download |
| Team Fortress 2 | `cm2network/tf2` | 27015/udp | ~2 GB | ~15-20 GB download |
| Zombie Panic! Source | `ich777/steamcmd:zombiepanic` | 27015/udp | ~4 GB | ~5-10 GB download |
| Project Zomboid | `danixu86/project-zomboid-dedicated-server` | 16261-16262, 8766-8767/udp | ~4 GB | fast (game baked into image) |
| ARK: Survival Evolved | `hermsi/ark-server` | 7777-7778, 27015/udp | 8 GB+ | ~20-25 GB download, slow start |
| Rust | `didstopia/rust-server` | 28015-28016/udp | 8 GB+ | ~7-10 GB download + map generation |
| 7 Days to Die | `vinanrra/7dtd-server` | 26900/tcp+udp, 26901-26903/udp | 8 GB+ | ~12-15 GB download |

Game-specific notes:

- **Ports**: most games are told their allocated ports via env, so host and container ports always match and extra instances keep working with the Steam server browser. Garry's Mod and 7 Days to Die have no port env vars, so a *second* instance of those gets NAT-remapped ports — direct `ip:port` connects work, but Steam server-browser discovery breaks for that instance.
- **RCON / admin ports are never published** (Source RCON on 27015/tcp, ARK 27020/tcp, Rust web RCON 28016/tcp, 7DTD web admin 8080 + telnet 8081). Admin/RCON passwords are generated randomly and not posted to Discord; recover them on the host with `docker inspect <container>` if needed.
- **Garry's Mod & TF2**: public Steam server-browser listing requires a per-game GSLT token from [Steam game server accounts](https://steamcommunity.com/dev/managegameservers); LAN and direct-IP play work without one (for TF2 set `SRCDS_TOKEN`; for GMod edit the LinuxGSM config in the data volume).
- **Garry's Mod & 7 Days to Die**: server settings (name, passwords, max players) live in config files inside the data volume (LinuxGSM configs / `sdtdserver.xml`), not env vars — edit them after first boot.
- **Zombie Panic! Source**: the image ships a `server.cfg` with default passwords (`Docker` / `adminDocker`) — change them in the data volume after first boot.
- **ARK**: needs ~25 GB free disk per server (the entrypoint enforces this) and can take 5-15 minutes to start even after downloading. Removal uses a 5-minute stop grace so the world saves.
- **Rust**: Facepunch force-wipes monthly; auto-update is enabled (`RUST_UPDATE_CHECKING=1`) so the server keeps accepting current clients.
- **Warm pool synergy**: the big-download games benefit most from `WARM_POOL` — a warm member has already finished its multi-GB SteamCMD download and boot by the time someone claims it.

Built for fast spin-up and automatic spin-down:

- **Pre-pulled images** — all game images are pulled at startup, so creates never wait on a multi-GB download.
- **Warm pool** — optionally keep N fully booted servers per game on standby. `/server create` then hands one over in under a second (a single container rename) instead of waiting for the game to boot.
- **Idle auto-stop** — servers whose CPU stays below a threshold for a configurable window (a proxy for "no players online") are stopped automatically, freeing RAM for the pool.

## Commands

All commands require the **Manage Server** permission in Discord.

| Command | Description |
| --- | --- |
| `/server create <game> <name>` | Provision and start a new game server |
| `/server start <name>` | Start a stopped server |
| `/server stop <name>` | Stop a running server (world data is kept) |
| `/server remove <name> [delete-data]` | Deprovision a server; data volume is kept unless `delete-data` is true |
| `/server list` | List all managed servers |
| `/server status <name>` | Show state and connect info for a server |

## Setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications), add a **Bot**, and copy the bot token and application ID.
2. Invite the bot to your server: OAuth2 URL Generator → scopes `bot` + `applications.commands` (no bot permissions needed — it only responds to slash commands).
3. Copy the environment file and fill it in:

   ```sh
   cp .env.example .env
   ```

4. Register the slash commands (once, and again whenever command definitions change):

   ```sh
   npm install
   npm run deploy-commands
   ```

## Local development

```sh
npm run dev
```

Requires a local Docker daemon. Set `DISCORD_GUILD_ID` in `.env` so command registration is instant in your test guild.

## Deploying

The bot and the game servers run together on a single host — a VPS or a local Ubuntu machine work identically. Requires Docker with the compose plugin. The bot only makes outbound connections, so a home machine behind NAT needs no inbound setup for the bot itself (players connecting to game servers is a separate matter — see the port notes below).

```sh
git clone https://github.com/CarusonSan/switchboard.git
cd switchboard
cp .env.example .env   # then fill it in
docker compose up -d --build
```

Register slash commands from inside the container (first deploy only):

```sh
docker compose run --rm switchboard node dist/deploy-commands.js
```

Game servers are created as sibling containers on the host (not nested inside the bot's container), so their ports bind directly to the host. For players to connect you need those ports reachable — on a VPS that means the provider firewall; on a home machine it means router port forwarding (or a tunnel like playit.gg if your ISP uses CGNAT). First-instance ports per game are listed in the table above; each additional instance of a game takes the next consecutive block (e.g. a second Minecraft server gets 25566).

Set `PUBLIC_HOST` in `.env` to the address players should connect to (VPS IP, home public IP or dynamic-DNS name, or LAN IP for LAN-only play) so the bot posts correct connect addresses. Note that Docker-published ports bypass `ufw` on Ubuntu — Docker manages iptables directly — so don't rely on ufw to gate game ports.

## Warm pool and idle auto-stop

Enable the warm pool per game in `.env`:

```sh
WARM_POOL=minecraft=1,valheim=1
```

A reconciler loop keeps that many booted servers on standby per game (named `sb-pool-<game>-<id>`, hidden from `/server list` except as a summary line). `/server create` claims one by renaming it — sub-second — and the pool replenishes in the background. When the pool is empty, creates fall back to a cold start.

Sizing note: warm servers hold their full RAM footprint (a Minecraft server is ~2GB), so `WARM_POOL` is opt-in and should be sized to your VPS. Two caveats:

- Warm servers boot with generic settings (e.g. Minecraft MOTD, Valheim world name are baked at container creation), so identity-bearing env vars show as "switchboard" rather than the chosen name. Ports and saves work normally.
- A pool-allocated server keeps its randomly named data volume, so removing it and recreating by name won't auto-reattach the world (the bot tells you the volume name on removal). Servers created cold use `switchboard-<name>` volumes, which do auto-reattach.

Idle auto-stop is on by default: any server whose CPU stays below `IDLE_CPU_PERCENT` (default 5%) for `IDLE_MINUTES` consecutive minutes (default 30) is stopped, with world data intact — `/server start` brings it back. CPU is a heuristic for "no players online"; if a game idles hot on your hardware, raise the threshold or set `IDLE_MINUTES=0` to disable. Idle tracking is in-memory, so a bot restart resets the countdown.

## Security notes

- The bot mounts `/var/run/docker.sock`, which is effectively root on the host. Only run it on a VPS you control, and only invite it to servers whose admins you trust — anyone with **Manage Server** in Discord can create containers.
- Games that need a join password (Valheim) get a random one generated per server; the bot posts it in the channel with the connect info, so anyone who can read that channel can join. It is also stored as a label on the container, which is only readable with Docker socket access.
- The bot only manages containers it created (labelled `dev.switchboard.managed=true`); it will not touch other containers on the host.

## Architecture

```
src/
  index.ts               # Discord client + interaction routing
  deploy-commands.ts     # One-off slash command registration
  config.ts              # Env parsing/validation (zod), warm pool sizes
  games.ts               # Game templates: image, ports, env, data dir
  maintenance.ts         # Background loops: pre-pull, pool reconcile, idle reaper
  commands/
    server.ts            # /server subcommands
  provisioning/
    provider.ts          # ServerProvider interface (swappable backend)
    docker.ts            # Docker implementation (dockerode)
```

Provisioning is behind the `ServerProvider` interface, so the Docker backend could later be swapped for something like a cloud API or an Agones/Kubernetes fleet without touching command code. Host ports are allocated in consecutive blocks per game starting from the template's base port, and each instance's ports are recorded in a container label so allocation survives restarts.

The user-facing server name lives in the *container name* (`sb-<name>`), not a label — Docker labels are immutable, and keeping the name mutable is what makes claiming a warm pool server a single rename call.
