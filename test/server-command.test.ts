import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { server } from "../src/commands/server.js";
import { games } from "../src/games.js";

describe("/server command definition", () => {
  const json = server.data.toJSON();
  const subcommands = (json.options ?? []).filter(
    (o) => o.type === ApplicationCommandOptionType.Subcommand,
  );

  it("is named server and requires Manage Guild", () => {
    expect(json.name).toBe("server");
    expect(json.default_member_permissions).toBeDefined();
  });

  it("exposes the full lifecycle as subcommands", () => {
    expect(subcommands.map((s) => s.name).sort()).toEqual([
      "create",
      "list",
      "remove",
      "start",
      "status",
      "stop",
    ]);
  });

  it("offers every registered game as a create choice", () => {
    const create = subcommands.find((s) => s.name === "create");
    const gameOption = create?.options?.find((o) => o.name === "game");
    expect(gameOption).toBeDefined();
    if (gameOption?.type !== ApplicationCommandOptionType.String) {
      throw new Error("game option should be a string option");
    }
    const choiceValues = (gameOption.choices ?? []).map((c) => c.value);
    expect(choiceValues.sort()).toEqual(Object.keys(games).sort());
  });
});
