// TEST-ONLY fake of `git -C <dir> status --porcelain --untracked-files=no`. FAKE_GIT_MODE: clean | dirty | error.
const mode = process.env.FAKE_GIT_MODE || "clean";
if (mode === "error") {
  process.stderr.write("fatal: not a git repository\n");
  process.exit(128);
}
if (mode === "dirty") process.stdout.write(" M vcpkg.json\n");
process.exit(0);
