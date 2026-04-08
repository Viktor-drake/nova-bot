/**
 * git-push.js — автономный деплой для Claude
 * Использование: node scripts/git-push.js "commit message" [file1 file2 ...]
 * Если файлы не указаны — делает git add -A
 * Пишет результат в scripts/git-output.log
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const LOG = path.join(__dirname, "git-output.log");
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
const message = args[0];
const files = args.slice(1);

if (!message) {
  fs.writeFileSync(LOG, `ERROR: commit message required\nUsage: node scripts/git-push.js "message" [file1 file2]\n`);
  process.exit(1);
}

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: "utf8" });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? -1,
  };
}

const lines = [];
const ts = new Date().toISOString();
lines.push(`=== git-push.js @ ${ts} ===`);
lines.push(`message: "${message}"`);
lines.push(`files: ${files.length ? files.join(", ") : "(all)"}`);
lines.push("");

// git add
const addArgs = files.length ? ["add", ...files] : ["add", "-A"];
lines.push(`> git ${addArgs.join(" ")}`);
const add = run("git", addArgs);
lines.push(add.stdout || add.stderr || "(no output)");
lines.push(`exit: ${add.status}`);
lines.push("");

if (add.status !== 0) {
  lines.push("FAILED at git add");
  fs.writeFileSync(LOG, lines.join("\n"));
  process.exit(1);
}

// git commit
lines.push(`> git commit -m "${message}"`);
const commit = run("git", ["commit", "-m", message]);
lines.push(commit.stdout || commit.stderr || "(no output)");
lines.push(`exit: ${commit.status}`);
lines.push("");

if (commit.status !== 0 && !commit.stdout.includes("nothing to commit")) {
  lines.push("FAILED at git commit");
  fs.writeFileSync(LOG, lines.join("\n"));
  process.exit(1);
}

// git push
lines.push(`> git push`);
const push = run("git", ["push"]);
lines.push(push.stdout || push.stderr || "(no output)");
lines.push(`exit: ${push.status}`);
lines.push("");

if (push.status !== 0) {
  lines.push("FAILED at git push");
} else {
  lines.push("SUCCESS: pushed to main, Vercel will deploy automatically");
}

fs.writeFileSync(LOG, lines.join("\n"));
console.log(fs.readFileSync(LOG, "utf8"));
