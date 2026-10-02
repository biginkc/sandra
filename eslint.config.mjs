import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Independently pinned integration lab; checked through its own package.
    "experiments/inbox-stack/**",
  ]),
  // The Search page UI may only call the Search-owned server entry points
  // (src/app/(dashboard)/search/actions.ts). The legacy Prospects/Leads/Campaign
  // actions stay untouched and must not be reachable from Search components.
  {
    files: [
      "src/app/(dashboard)/properties/prospects-table.tsx",
      "src/app/(dashboard)/properties/bulk-sms-modal.tsx",
      "src/app/(dashboard)/properties/bulk-tag-modal.tsx",
      "src/app/(dashboard)/properties/batch-create-modal.tsx",
      "src/app/(dashboard)/properties/promote-leads-dialog.tsx",
      "src/app/(dashboard)/properties/_components/use-debounced-filters.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "./actions",
                "./dnc-safe-actions",
                "./promote-leads-actions",
                "./_actions/*",
                "../leads/actions",
                "../campaigns/actions",
                "@/app/(dashboard)/properties/actions",
                "@/app/(dashboard)/properties/dnc-safe-actions",
                "@/app/(dashboard)/properties/promote-leads-actions",
                "@/app/(dashboard)/properties/_actions/*",
                "@/app/(dashboard)/leads/actions",
                "@/app/(dashboard)/campaigns/actions",
              ],
              message: "Search components must import server actions only from src/app/(dashboard)/search/actions.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
