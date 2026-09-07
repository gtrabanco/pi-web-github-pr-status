import { describe, expect, it } from "bun:test";
import { validatePluginPackage } from "./validate-package.ts";

function pkg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "@gtrabanco/pi-web-github-pr-status",
    version: "0.1.0",
    type: "module",
    piWeb: { plugins: [{ id: "github-pr-status", browserRoot: "dist", module: "dist/index.js" }] },
    ...overrides,
  };
}

describe("validatePluginPackage", () => {
  it("accepts the shipped metadata", () => {
    const result = validatePluginPackage(pkg());
    expect(result).toEqual([]);
  });

  it("rejects missing or malformed piWeb metadata", () => {
    expect(validatePluginPackage({})).toContain("piWeb.plugins must be an array of objects");
    expect(validatePluginPackage(pkg({ piWeb: {} }))).toContain("piWeb.plugins must be an array of objects");
    expect(validatePluginPackage(pkg({ piWeb: { plugins: ["x"] } })).length).toBeGreaterThan(0);
  });

  it("rejects reserved or invalid plugin ids", () => {
    expect(validatePluginPackage(pkg({ piWeb: { plugins: [{ id: "core", module: "m.js", browserRoot: "." }] } }))).toContain(
      'plugin id "core" is reserved for the host',
    );
    expect(validatePluginPackage(pkg({ piWeb: { plugins: [{ id: "machine.1", module: "m.js", browserRoot: "." }] } }))).toContain(
      'plugin id "machine.1" is reserved for the host',
    );
    expect(
      validatePluginPackage(pkg({ piWeb: { plugins: [{ id: "Bad_ID", module: "m.js", browserRoot: "." }] } })).join("\n"),
    ).toMatch(/invalid plugin id/);
  });

  it("requires module or serverModule, and browserRoot exactly for browser entries", () => {
    expect(validatePluginPackage(pkg({ piWeb: { plugins: [{ id: "x" }] } }))).toContain(
      "plugin x must declare module or serverModule",
    );
    expect(validatePluginPackage(pkg({ piWeb: { plugins: [{ id: "x", serverModule: "s.js", browserRoot: "dist" }] } })).join("\n")).toMatch(
      /server-only entry must not declare browserRoot/,
    );
    expect(validatePluginPackage(pkg({ piWeb: { plugins: [{ id: "x", module: "m.js" }] } })).join("\n")).toMatch(
      /browser entry must declare a browserRoot/,
    );
  });

  it("rejects unsafe module paths and modules outside browserRoot", () => {
    const outside = pkg({ piWeb: { plugins: [{ id: "x", browserRoot: "dist/browser", module: "dist/index.js" }] } });
    expect(validatePluginPackage(outside).join("\n")).toMatch(/module must live inside browserRoot/);
    const traversal = pkg({ piWeb: { plugins: [{ id: "x", browserRoot: "dist", module: "../evil.js" }] } });
    expect(validatePluginPackage(traversal).length).toBeGreaterThan(0);
    const nodeModules = pkg({ piWeb: { plugins: [{ id: "x", browserRoot: ".", module: "node_modules/x/index.js" }] } });
    expect(validatePluginPackage(nodeModules).length).toBeGreaterThan(0);
    const backslash = pkg({ piWeb: { plugins: [{ id: "x", browserRoot: "dist", module: "dist\\index.js" }] } });
    expect(validatePluginPackage(backslash).length).toBeGreaterThan(0);
  });

  it("requires type module for .js server modules", () => {
    const withServer = pkg({
      type: "commonjs",
      piWeb: { plugins: [{ id: "x", browserRoot: "dist", module: "dist/index.js", serverModule: "dist/server.js" }] },
    });
    expect(validatePluginPackage(withServer)).toContain(
      "package type must be module when a .js serverModule is declared",
    );
    const withMjs = pkg({ piWeb: { plugins: [{ id: "x", browserRoot: "dist", module: "dist/index.js", serverModule: "dist/server.mjs" }] } });
    expect(validatePluginPackage(withMjs)).toEqual([]);
  });

  it("rejects duplicate plugin ids", () => {
    const duplicated = pkg({
      piWeb: {
        plugins: [
          { id: "x", browserRoot: "dist", module: "dist/index.js" },
          { id: "x", browserRoot: "dist", module: "dist/other.js" },
        ],
      },
    });
    expect(validatePluginPackage(duplicated).join("\n")).toMatch(/duplicate plugin id/);
  });
});
