#!/usr/bin/env node
// Unconditional CLI entrypoint for scripts/check-migration-safety.mjs.
//
// This file's only job is to call main(). There is no "is this being run
// directly or merely imported" check -- deliberately. Round 1 of this gate
// had one (comparing `fileURLToPath(import.meta.url)` against
// `resolve(process.argv[1])`), and it broke twice: first because the repo
// path contains a space, then again under adversarial review because
// invoking the file THROUGH A SYMLINK produces the same mismatch -- both
// silently skipped main() entirely, exiting 0 with no gate output. That is a
// fail-open on the exact control this script exists to enforce.
//
// Splitting entrypoint from library removes the class of bug rather than
// patching the comparison a third time: this file always runs main() when
// executed, full stop, regardless of how it was invoked (direct path,
// symlink, npm script). check-migration-safety.mjs is imported here for its
// exports and never decides on its own whether to run.
import { main } from "./check-migration-safety.mjs";

main();
