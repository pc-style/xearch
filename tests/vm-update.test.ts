import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xearch-vm-update-"));
  temporary.push(root);
  const home = join(root, "home");
  const code = join(root, "code");
  const data = join(root, "data");
  const bin = join(home, ".local/bin");
  const log = join(root, "commands");
  const marker = join(data, "update-applied-sha");
  const installed = join(bin, "xearch-search");
  const write = (path: string, contents: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  };
  const executable = (path: string, contents: string) => {
    write(path, contents);
    chmodSync(path, 0o755);
  };
  mkdirSync(data, { recursive: true });
  mkdirSync(join(code, "search"), { recursive: true });
  write(log, "");
  write(join(root, "head"), "old-sha\n");
  write(installed, "previous binary\n");
  write(join(code, ".env.local"), "fixture environment\n");
  const dropIn = join(home, ".config/systemd/user/xearch-search-indexer.service.d/runtime.conf");
  write(dropIn, "fixture runtime override\n");
  write(join(data, "search/state/users.json"), '{"preserved":true}\n');
  // Let the old updater reach its unsafe operations when running regressions.
  for (const name of ["test.service", "test.timer", "test.path"]) {
    write(join(code, "deploy/systemd", name), "legacy unit\n");
  }
  for (const name of ["vm-update.sh", "reindex.sh"]) {
    executable(join(code, "scripts", name), '#!/bin/sh\nprintf "reindex\\n" >> "$TEST_LOG"\n');
  }
  const mock = (name: string, body: string) => {
    executable(
      join(bin, name),
      `#!/bin/bash\nset -eu\nprintf '%s\\n' "${name} $*" >> "$TEST_LOG"\n${body}\n`,
    );
  };
  mock(
    "git",
    `case "$1" in
  rev-parse) cat "$TEST_ROOT/head" ;;
  fetch) exit "\${TEST_FETCH_STATUS:-0}" ;;
  merge) printf 'new-sha\\n' > "$TEST_ROOT/head" ;;
  diff) exit "\${TEST_DIFF_STATUS:-1}" ;;
  *) exit 99 ;;
esac`,
  );
  mock("bun", 'exit "${TEST_BUN_STATUS:-0}"');
  mock(
    "cargo",
    `if [ "\${TEST_BUILD_STATUS:-0}" != 0 ]; then exit "$TEST_BUILD_STATUS"; fi
mkdir -p target/release
cp "$TEST_ROOT/binary" target/release/xearch-search
chmod +x target/release/xearch-search`,
  );
  executable(
    join(root, "binary"),
    `#!/bin/bash
printf 'binary %s\\n' "$*" >> "$TEST_LOG"
if [ "\${TEST_INVALID_BINARY:-0}" = 1 ]; then exit 1; fi
case "$*" in
  --help) printf '%s\\n' '--base-dir watch serve' ;;
  'watch --help'|'serve --help') exit 0 ;;
  *) printf 'import\\n' >> "$TEST_LOG" ;;
esac`,
  );
  mock(
    "systemctl",
    `if [ "\${TEST_SYSTEMCTL_STATUS:-0}" != 0 ]; then exit "$TEST_SYSTEMCTL_STATUS"; fi
case "$*" in
  *--property=LoadState*) printf '%s\\n' "\${TEST_LOAD_STATE:-loaded}" ;;
  *--property=ActiveState*) printf '%s\\n' "\${TEST_WATCHER_STATE:-active}" ;;
  *is-active*xearch-search-indexer*) exit "\${TEST_INDEXER_STATUS:-0}" ;;
  *is-active*xearch-search.service*) exit "\${TEST_SEARCH_STATUS:-0}" ;;
  *restart*) exit "\${TEST_RESTART_STATUS:-0}" ;;
  *disable*|*stop*) exit "\${TEST_RETIRE_STATUS:-0}" ;;
esac`,
  );
  mock("pgrep", 'exit "${TEST_PGREP_STATUS:-1}"');
  mock("curl", 'exit "${TEST_HEALTH_STATUS:-0}"');
  mock("sleep", "exit 0");
  const run = (
    script = "vm-update.sh",
    env: Record<string, string | undefined> = {},
    args: string[] = [],
  ) =>
    spawnSync("/bin/bash", [join(scripts, script), ...args], {
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XEARCH_CODE: code,
        XEARCH_DATA: data,
        XEARCH_SEARCH_BIN: join(root, "binary"),
        TEST_ROOT: root,
        TEST_LOG: log,
        ...env,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
  return {
    root,
    home,
    code,
    data,
    marker,
    installed,
    dropIn,
    write,
    run,
    commands: () => readFileSync(log, "utf8"),
    clearLog: () => write(log, ""),
  };
}

describe("vm-update", () => {
  it("retires legacy writers, installs the validated watcher binary, and only restarts search services", () => {
    const f = fixture();
    const result = f.run("vm-update.sh", {}, ["--force"]);
    expect(result.status, result.stderr).toBe(0);
    const commands = f.commands();
    expect(commands).toContain(
      "systemctl --user disable --now xearch-reindex.timer xearch-reindex.path",
    );
    expect(commands).toContain("systemctl --user stop xearch-reindex.service");
    expect(commands).toContain("binary watch --help");
    expect(commands).toContain("systemctl --user try-restart xearch-search-indexer.service");
    expect(commands).toContain("systemctl --user try-restart xearch-search.service");
    expect(commands.indexOf("stop xearch-reindex.service")).toBeLessThan(
      commands.indexOf("try-restart"),
    );
    expect(commands).not.toMatch(
      /xearch-capture|xearch-production-worker|xearch-frontend|daemon-reload|\benable\b|\bimport\b|^reindex$/m,
    );
    expect(commands).not.toMatch(/convex|deploy|upload/);
    expect(readFileSync(f.installed, "utf8")).toBe(readFileSync(join(f.root, "binary"), "utf8"));
    expect(readFileSync(f.marker, "utf8")).toBe("new-sha\n");
    expect(readFileSync(f.dropIn, "utf8")).toBe("fixture runtime override\n");
    expect(readFileSync(join(f.code, ".env.local"), "utf8")).toBe("fixture environment\n");
    expect(readFileSync(join(f.data, "search/state/users.json"), "utf8")).toBe(
      '{"preserved":true}\n',
    );
    expect(existsSync(join(f.home, ".config/systemd/user/test.service"))).toBe(false);
  });

  it("retries a failed build at unchanged HEAD and skips only after a successful application", () => {
    const f = fixture();
    expect(f.run("vm-update.sh", { TEST_BUILD_STATUS: "1" }).status).not.toBe(0);
    expect(existsSync(f.marker)).toBe(false);
    expect(readFileSync(f.installed, "utf8")).toBe("previous binary\n");
    expect(f.commands()).not.toContain("systemctl");
    f.clearLog();
    const retry = f.run();
    expect(retry.status, retry.stderr).toBe(0);
    expect(f.commands()).toContain("cargo build --release --locked -p xearch-search");
    expect(readFileSync(f.marker, "utf8")).toBe("new-sha\n");
    f.clearLog();
    expect(f.run().status).toBe(0);
    expect(f.commands()).not.toMatch(/cargo|bun|systemctl|binary/);
  });

  it.each([
    { TEST_BUN_STATUS: "1" },
    { TEST_INVALID_BINARY: "1" },
    { TEST_SYSTEMCTL_STATUS: "1" },
    { TEST_RETIRE_STATUS: "1" },
    { TEST_FETCH_STATUS: "1" },
  ])("does not install or mark a failed preparation as applied: %j", (env) => {
    const f = fixture();
    f.write(f.marker, "old-sha\n");
    expect(f.run("vm-update.sh", env).status).not.toBe(0);
    expect(readFileSync(f.marker, "utf8")).toBe("old-sha\n");
    expect(readFileSync(f.installed, "utf8")).toBe("previous binary\n");
    expect(f.commands()).not.toContain("try-restart");
  });

  it.each([{ TEST_RESTART_STATUS: "1" }, { TEST_HEALTH_STATUS: "1" }])(
    "retries partial application after service failure: %j",
    (env) => {
      const f = fixture();
      f.write(f.marker, "old-sha\n");
      expect(f.run("vm-update.sh", env).status).not.toBe(0);
      expect(readFileSync(f.marker, "utf8")).toBe("old-sha\n");
      f.clearLog();
      expect(f.run().status).toBe(0);
      expect(f.commands()).toContain("try-restart xearch-search-indexer.service");
      expect(f.commands()).not.toMatch(/\bimport\b|^reindex$/m);
    },
  );

  it("does not start inactive services or require their health endpoints", () => {
    const f = fixture();
    const result = f.run("vm-update.sh", { TEST_SEARCH_STATUS: "3", TEST_INDEXER_STATUS: "3" });
    expect(result.status, result.stderr).toBe(0);
    expect(f.commands()).not.toMatch(/try-restart|curl|--user start|--user enable/);
    expect(readFileSync(f.marker, "utf8")).toBe("new-sha\n");
  });

  it("does not rebuild or restart search for unrelated changes, but honors force", () => {
    const f = fixture();
    f.write(f.marker, "old-sha\n");
    expect(f.run("vm-update.sh", { TEST_DIFF_STATUS: "0" }).status).toBe(0);
    expect(f.commands()).not.toMatch(/cargo|try-restart|curl/);
    expect(readFileSync(f.marker, "utf8")).toBe("new-sha\n");
    f.clearLog();
    expect(f.run("vm-update.sh", { TEST_DIFF_STATUS: "0" }, ["--force"]).status).toBe(0);
    expect(f.commands()).toContain("try-restart xearch-search-indexer.service");
  });

  it("handles absent legacy units without reinstalling them", () => {
    const f = fixture();
    expect(f.run("vm-update.sh", { TEST_LOAD_STATE: "not-found" }).status).toBe(0);
    expect(f.commands()).not.toMatch(/--user disable|--user stop|daemon-reload/);
  });
});

describe("reindex", () => {
  it.each(["active", "activating", "deactivating", "reloading"])(
    "refuses imports while the watcher is %s, before creating directories",
    (state) => {
      const f = fixture();
      // The fixture's state file exists, but no index/archive has been created.
      const result = f.run("reindex.sh", { TEST_WATCHER_STATE: state });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/watcher/i);
      expect(f.commands()).not.toContain("binary");
      expect(existsSync(join(f.data, "search/index"))).toBe(false);
      expect(existsSync(join(f.data, "search/archive"))).toBe(false);
    },
  );

  it("fails closed if the watcher state cannot be checked", () => {
    const f = fixture();
    expect(f.run("reindex.sh", { TEST_SYSTEMCTL_STATUS: "1" }).status).not.toBe(0);
    expect(existsSync(join(f.data, "search/index"))).toBe(false);
  });

  it.each(["0", "2"])(
    "refuses a manual watcher or a failed process check (status %s)",
    (status) => {
      const f = fixture();
      const result = f.run("reindex.sh", {
        TEST_WATCHER_STATE: "inactive",
        TEST_PGREP_STATUS: status,
      });
      expect(result.status).not.toBe(0);
      expect(f.commands()).not.toContain("binary");
      expect(existsSync(join(f.data, "search/index"))).toBe(false);
    },
  );

  it("allows explicit offline imports and skips captures with receipts", () => {
    const f = fixture();
    f.write(join(f.data, ".local-captures/raw/capture.json"), "{}\n");
    const result = f.run("reindex.sh", { TEST_WATCHER_STATE: "inactive" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 new capture(s)");
    expect(f.commands()).toContain(" import --input ");
    expect(f.commands()).not.toMatch(/restart|--user stop|--user start/);
    const digest = createHash("sha256").update("{}\n").digest("hex");
    f.write(join(f.data, "search/archive", `${digest}.receipt.json`), "{}\n");
    f.clearLog();
    const repeated = f.run("reindex.sh", { TEST_WATCHER_STATE: "inactive" });
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(repeated.stdout).toContain("0 new capture(s)");
    expect(f.commands()).not.toContain("binary");
  });
});
