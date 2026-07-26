import {
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { games } from '../games.js';
import { dockerProvider as provider } from '../provisioning/docker.js';
import { type GameServerInfo, UserError } from '../provisioning/provider.js';
import type { Command } from './types.js';

const gameChoices = Object.values(games).map((g) => ({ name: g.label, value: g.id }));

const data = new SlashCommandBuilder()
  .setName('server')
  .setDescription('Manage game servers')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Provision a new game server')
      .addStringOption((opt) =>
        opt
          .setName('game')
          .setDescription('Which game to run')
          .setRequired(true)
          .addChoices(...gameChoices),
      )
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Server name (lowercase letters, numbers, hyphens)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Start a stopped server')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Server name').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('stop')
      .setDescription('Stop a running server')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Server name').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Deprovision a server')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Server name').setRequired(true),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('delete-data')
          .setDescription('Also delete the world/save data (default: keep it)'),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List all game servers'))
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Show the status of a server')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Server name').setRequired(true),
      ),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  // Everything here talks to Docker (creates can pull multi-GB images), so always defer.
  await interaction.deferReply();

  try {
    switch (subcommand) {
      case 'create': {
        const gameId = interaction.options.getString('game', true);
        const name = interaction.options.getString('name', true);
        const template = games[gameId];
        if (!template) {
          throw new UserError(`Unknown game: ${gameId}`);
        }
        const { info, source } = await provider.create(template, name);
        const headline =
          source === 'warm-pool'
            ? `⚡ \`${name}\` is ready now — claimed a warm **${template.label}** server from the pool.`
            : source === 'existing-data'
              ? `Recreated **${template.label}** server \`${name}\` from its kept world data.`
              : `Provisioned **${template.label}** server \`${name}\` — first boot may take a minute.`;
        await interaction.editReply(`${headline}\n${connectInfo(info)}`);
        break;
      }
      case 'start': {
        const name = interaction.options.getString('name', true);
        const info = await provider.start(name);
        await interaction.editReply(`Started \`${name}\`.\n${connectInfo(info)}`);
        break;
      }
      case 'stop': {
        const name = interaction.options.getString('name', true);
        await provider.stop(name);
        await interaction.editReply(`Stopped \`${name}\`. World data is preserved.`);
        break;
      }
      case 'remove': {
        const name = interaction.options.getString('name', true);
        const deleteData = interaction.options.getBoolean('delete-data') ?? false;
        const removed = await provider.remove(name, deleteData);
        if (removed.dataDeleted) {
          await interaction.editReply(`Removed \`${name}\` and deleted its world data.`);
        } else if (removed.reusableByName) {
          await interaction.editReply(
            `Removed \`${name}\`. World data kept — recreate with the same name to reuse it.`,
          );
        } else {
          await interaction.editReply(
            `Removed \`${name}\`. World data kept in volume \`${removed.volume}\` (reattach manually to reuse it).`,
          );
        }
        break;
      }
      case 'list': {
        const [servers, pool] = await Promise.all([provider.list(), provider.poolStatus()]);
        const lines =
          servers.length === 0
            ? ['No game servers provisioned. Use `/server create` to add one.']
            : servers.map(
                (s) =>
                  `${stateEmoji(s.state)} \`${s.name}\` — ${games[s.game]?.label ?? s.game} (${s.status})`,
              );
        if (pool.length > 0) {
          const byGame = new Map<string, { ready: number; total: number }>();
          for (const member of pool) {
            const entry = byGame.get(member.game) ?? { ready: 0, total: 0 };
            entry.total++;
            if (member.state === 'running') entry.ready++;
            byGame.set(member.game, entry);
          }
          const summary = [...byGame.entries()]
            .map(([game, { ready, total }]) => `${games[game]?.label ?? game} ${ready}/${total} ready`)
            .join(', ');
          lines.push('', `Warm pool: ${summary}`);
        }
        await interaction.editReply(lines.join('\n'));
        break;
      }
      case 'status': {
        const name = interaction.options.getString('name', true);
        const info = await provider.status(name);
        const lines = [
          `${stateEmoji(info.state)} \`${info.name}\` — ${games[info.game]?.label ?? info.game}`,
          `State: ${info.status}`,
        ];
        if (info.state === 'running') {
          lines.push(connectInfo(info));
        }
        await interaction.editReply(lines.join('\n'));
        break;
      }
    }
  } catch (error) {
    if (error instanceof UserError) {
      await interaction.editReply(error.message);
    } else {
      throw error;
    }
  }
}

function connectInfo(info: GameServerInfo): string {
  const lines: string[] = [];
  if (info.ports.length === 0) {
    lines.push('Ports: none exposed yet.');
  } else {
    const host = config.PUBLIC_HOST ?? '<host-ip>';
    const ports = info.ports.map((p) => `\`${host}:${p.host}\` (${p.protocol})`).join(', ');
    lines.push(`Connect: ${ports}`);
  }
  if (info.password) {
    lines.push(`Join password: \`${info.password}\``);
  }
  return lines.join('\n');
}

function stateEmoji(state: string): string {
  switch (state) {
    case 'running':
      return '🟢';
    case 'exited':
    case 'created':
      return '🔴';
    default:
      return '🟡';
  }
}

export const server: Command = { data, execute };
