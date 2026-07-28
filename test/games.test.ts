import { describe, expect, it } from "vitest";
import { games } from "../src/games.js";

// Distinctive values so substring checks against env output can't false-positive.
const NAME = "sample-server";
const PASSWORD = "pw-secret-xyz";
const PORT_BASE = 41_000;

describe("game templates", () => {
  for (const [key, template] of Object.entries(games)) {
    describe(key, () => {
      const ports = template.ports.map((_, i) => PORT_BASE + i);
      const env = template.env(NAME, PASSWORD, ports);
      const values = Object.values(env);

      it("has an id matching its registry key", () => {
        expect(template.id).toBe(key);
      });

      it("declares at least one port, all in valid range", () => {
        expect(template.ports.length).toBeGreaterThan(0);
        for (const spec of template.ports) {
          expect(spec.container).toBeGreaterThan(0);
          expect(spec.container).toBeLessThanOrEqual(65_535);
        }
        expect(template.basePort).toBeGreaterThan(1_024);
        expect(template.basePort).toBeLessThanOrEqual(65_535);
      });

      it("uses an absolute data dir and a positive stop timeout", () => {
        expect(template.dataDir.startsWith("/")).toBe(true);
        expect(template.stopTimeoutSeconds).toBeGreaterThan(0);
      });

      it("produces string-only env vars", () => {
        for (const value of values) {
          expect(typeof value).toBe("string");
        }
      });

      if (template.portMode === "env") {
        it("passes every allocated host port to the server via env", () => {
          for (const port of ports) {
            expect(
              values.some((v) => v.includes(String(port))),
              `port ${port} missing from env: ${JSON.stringify(env)}`,
            ).toBe(true);
          }
        });
      }

      if (template.usesPassword) {
        it("consumes the generated password it promises to show the creator", () => {
          expect(values).toContain(PASSWORD);
        });
      } else {
        it("does not silently embed the password it claims not to use", () => {
          expect(values).not.toContain(PASSWORD);
        });
      }
    });
  }
});
