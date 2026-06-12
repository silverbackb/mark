#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const __dir = join(fileURLToPath(import.meta.url), "..", "..");
const SKILL_NAME = "mark-sbb";
const MCP_NAME = "mark";
let PKG_VERSION = "0.0.0";
try {
    PKG_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")).version;
}
catch { }
function installSkill(skillsDir) {
    const src = join(__dir, "assets", "skills", SKILL_NAME, "SKILL.md");
    if (!existsSync(src))
        return false;
    const dest = join(skillsDir, SKILL_NAME, "SKILL.md");
    mkdirSync(join(skillsDir, SKILL_NAME), { recursive: true });
    copyFileSync(src, dest);
    return true;
}
function registerMcp(configPath, serverBinPath) {
    if (!existsSync(configPath))
        return false;
    try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!config.mcpServers)
            config.mcpServers = {};
        if (config.mcpServers[MCP_NAME])
            return false; // already registered
        config.mcpServers[MCP_NAME] = {
            command: "node",
            args: [serverBinPath],
            env: { MARK_PORT: "7331" },
        };
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
        return true;
    }
    catch {
        return false;
    }
}
const home = homedir();
const serverBin = join(__dir, "dist", "index.js");
const skillTargets = [
    { name: "Claude Code", dir: join(home, ".claude", "skills") },
];
const mcpTargets = [
    { name: "Claude Code", config: join(home, ".claude.json") },
];
const skillInstalled = [];
for (const t of skillTargets) {
    if (installSkill(t.dir))
        skillInstalled.push(t.name);
}
const mcpRegistered = [];
for (const t of mcpTargets) {
    if (registerMcp(t.config, serverBin))
        mcpRegistered.push(t.name);
}
console.log(`\n@silverbackbase/mark v${PKG_VERSION} — init\n`);
if (skillInstalled.length)
    skillInstalled.forEach(n => console.log(`  skill installed — ${n}`));
else
    console.log("  skill already installed or target not found");
if (mcpRegistered.length)
    mcpRegistered.forEach(n => console.log(`  MCP registered — ${n}`));
else
    console.log("  MCP already registered or config not found");
console.log("\nRestart Claude Code for changes to take effect.\n");
//# sourceMappingURL=init.js.map