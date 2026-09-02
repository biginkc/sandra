import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "sandra-esign-nav-mutations-"));
chmodSync(sandbox, 0o700);

const sourceFile =
  "src/app/(dashboard)/settings/esign-templates/[templateId]/edit/embedded-editor-navigation-history.ts";
const specFile = "e2e/synthetic/esign-editor-navigation-history.spec.ts";
const mutations = [
  {
    name: "history return preserves the take-once initial session",
    from: "        onBeforeReturnToLibrary?.();",
    to: "        void onBeforeReturnToLibrary;",
    test: "Forward reuses the take-once session for an unfinished initial draft",
  },
  {
    name: "history restoration preserves a legitimate Forward entry",
    from: "    if (hasLegitimateForwardEntry(navigation, editorUrl)) return;",
    to: "    if (false && hasLegitimateForwardEntry(navigation, editorUrl)) return;",
    test: "Back restoration preserves the legitimate Forward destination",
  },
  {
    name: "replacement editor finds the preceding library past old guards",
    from: "    : findPrecedingTemplateLibraryEntry(entries, currentEntry);",
    to: "    : entries.find((entry) => entry.index === currentEntry.index - 1);",
    test: "Back from a restarted replacement returns to the library",
  },
];

try {
  execFileSync(
    "rsync",
    [
      "-a",
      "--exclude=.git",
      "--exclude=.next",
      "--exclude=.env*",
      "--exclude=node_modules",
      "--exclude=playwright-report",
      "--exclude=test-results",
      `${root}/`,
      `${sandbox}/`,
    ],
    { stdio: "inherit" },
  );
  symlinkSync(join(root, "node_modules"), join(sandbox, "node_modules"));

  runTest();
  const target = join(sandbox, sourceFile);
  const original = readFileSync(target, "utf8");
  for (const [index, mutation] of mutations.entries()) {
    const occurrences = original.split(mutation.from).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `${mutation.name}: expected one mutation target, found ${occurrences}`,
      );
    }
    writeFileSync(target, original.replace(mutation.from, mutation.to));
    let killed = false;
    try {
      runTest(mutation.test);
    } catch (error) {
      const output = `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`;
      if (!output.includes(mutation.test) || !output.includes("failed")) {
        throw new Error(
          `INVALID KILL ${index + 1}/3: ${mutation.name} failed outside its owning assertion`,
          { cause: error },
        );
      }
      killed = true;
    } finally {
      writeFileSync(target, original);
    }
    if (!killed) throw new Error(`SURVIVED ${index + 1}/3: ${mutation.name}`);
    console.log(`KILLED ${index + 1}/3: ${mutation.name}`);
  }
  console.log("OK: 3/3 navigation-history mutations killed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

function runTest(testName) {
  const args = [
    "playwright",
    "test",
    "--config",
    "playwright.synthetic.config.ts",
    specFile,
    "--workers=1",
  ];
  if (testName) args.push("--grep", testName);
  execFileSync("npx", args, {
    cwd: sandbox,
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    stdio: "pipe",
    timeout: 60_000,
  });
}
