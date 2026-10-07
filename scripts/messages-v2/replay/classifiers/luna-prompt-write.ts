#!/usr/bin/env tsx
/** npm run replay:luna-prompt: regenerates scripts/messages-v2/replay/luna-prompt.md. */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { renderLunaPromptMarkdown } from "./luna-prompt";

const out = path.resolve(process.cwd(), "scripts/messages-v2/replay/luna-prompt.md");
writeFileSync(out, renderLunaPromptMarkdown());
console.log(`wrote ${out}`);
