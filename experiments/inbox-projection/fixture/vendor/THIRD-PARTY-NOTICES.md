# Third-party source notices

The fixture vendors selected migration source from Supabase projects. Their license texts are retained byte-for-byte under `licenses/`; `licenses/manifest.json` records official source URLs, immutable commits and SHA-256 hashes. This license manifest is separate from the executable migration manifest and is not applied to PostgreSQL.

| Project | Upstream license | Copied source covered |
| --- | --- | --- |
| Supabase Auth | MIT; Copyright (c) 2021 Supabase <support@supabase.com> | Auth JWT, identity, deleted-at and helper migrations |
| Supabase Storage | Apache License 2.0 | Storage foundation, bucket RLS/public flag/size limits and byte-unit migrations |
| Supabase Realtime | Apache License 2.0 | Two original Ecto migrations plus the explicitly derived role/foundation SQL |
| Supabase Postgres | PostgreSQL License; Copyright (c) 2020, Supabase | Image-provided storage grant migration |

## Exact license copies

- [supabase/auth at `2a2f425554e8eca701722f4aab794ccf3647b27b`](licenses/supabase-auth-2a2f425554e8eca701722f4aab794ccf3647b27b-LICENSE) — [official source](https://raw.githubusercontent.com/supabase/auth/2a2f425554e8eca701722f4aab794ccf3647b27b/LICENSE); SHA-256 `c317de2f5a8987bf1d2f640e4a1b20985480ecc5656be0d676599b5419e0b0c9`.
- [supabase/auth at `3b77d62d71ad810697273a518a48bb0b539be4e6`](licenses/supabase-auth-3b77d62d71ad810697273a518a48bb0b539be4e6-LICENSE) — [official source](https://raw.githubusercontent.com/supabase/auth/3b77d62d71ad810697273a518a48bb0b539be4e6/LICENSE); SHA-256 `c317de2f5a8987bf1d2f640e4a1b20985480ecc5656be0d676599b5419e0b0c9`.
- [supabase/auth at `d8ec8015e50f6199786a9e5f05589888fa8862be`](licenses/supabase-auth-d8ec8015e50f6199786a9e5f05589888fa8862be-LICENSE) — [official source](https://raw.githubusercontent.com/supabase/auth/d8ec8015e50f6199786a9e5f05589888fa8862be/LICENSE); SHA-256 `c317de2f5a8987bf1d2f640e4a1b20985480ecc5656be0d676599b5419e0b0c9`.
- [supabase/auth at `e062eeae0079a6b1a70d5d5da9e5ac5cb8c21194`](licenses/supabase-auth-e062eeae0079a6b1a70d5d5da9e5ac5cb8c21194-LICENSE) — [official source](https://raw.githubusercontent.com/supabase/auth/e062eeae0079a6b1a70d5d5da9e5ac5cb8c21194/LICENSE); SHA-256 `c317de2f5a8987bf1d2f640e4a1b20985480ecc5656be0d676599b5419e0b0c9`.
- [supabase/postgres at `73119f8bfae2bfb07ddfa18240ab8e5f56f737a8`](licenses/supabase-postgres-73119f8bfae2bfb07ddfa18240ab8e5f56f737a8-LICENSE) — [official source](https://raw.githubusercontent.com/supabase/postgres/73119f8bfae2bfb07ddfa18240ab8e5f56f737a8/LICENSE); SHA-256 `fd313c784c2e3c964fe043fdb7bcffa8f84627d53d2cf3a61c61586ff6c3f4c1`.
- [supabase/realtime at `935ddbb25e2bd76c2829fc32b09ba28258ace48e`](licenses/supabase-realtime-935ddbb25e2bd76c2829fc32b09ba28258ace48e-LICENSE) — [official source](https://raw.githubusercontent.com/supabase/realtime/935ddbb25e2bd76c2829fc32b09ba28258ace48e/LICENSE); SHA-256 `56351b5c92da783a59b13835c13dcdae5f6b2da04baaf69f4b02a9429f2c334e`.
- [supabase/storage at `e89d526fa3e3e7600b6a22cedf43aa058924d19a`](licenses/supabase-storage-e89d526fa3e3e7600b6a22cedf43aa058924d19a-LICENSE) — [official source](https://raw.githubusercontent.com/supabase/storage/e89d526fa3e3e7600b6a22cedf43aa058924d19a/LICENSE); SHA-256 `87420ad3debbb44af3e5aac29f5bafd4427eef7a28c6e5eae199bdde1ad7c2e2`.

## Source-to-license mapping

- `storage-foundation.sql` → [supabase/storage license](licenses/supabase-storage-e89d526fa3e3e7600b6a22cedf43aa058924d19a-LICENSE).
- `0007-add-rls-to-buckets.sql` → [supabase/storage license](licenses/supabase-storage-e89d526fa3e3e7600b6a22cedf43aa058924d19a-LICENSE).
- `0008-add-public-to-buckets.sql` → [supabase/storage license](licenses/supabase-storage-e89d526fa3e3e7600b6a22cedf43aa058924d19a-LICENSE).
- `auth-jwt.sql` → [supabase/auth license](licenses/supabase-auth-3b77d62d71ad810697273a518a48bb0b539be4e6-LICENSE).
- `20210909172000_create_identities_table.up.sql` → [supabase/auth license](licenses/supabase-auth-3b77d62d71ad810697273a518a48bb0b539be4e6-LICENSE).
- `20230116124412_add_deleted_at.up.sql` → [supabase/auth license](licenses/supabase-auth-2a2f425554e8eca701722f4aab794ccf3647b27b-LICENSE).
- `20231117164230_add_id_pkey_identities.up.sql` → [supabase/auth license](licenses/supabase-auth-d8ec8015e50f6199786a9e5f05589888fa8862be-LICENSE).
- `realtime-role.sql` → [supabase/realtime license](licenses/supabase-realtime-935ddbb25e2bd76c2829fc32b09ba28258ace48e-LICENSE). The retained `20240401105812_create_realtime_admin_and_move_ownership.ex` original is covered by the same license.
- `realtime-foundation.sql` → [supabase/realtime license](licenses/supabase-realtime-935ddbb25e2bd76c2829fc32b09ba28258ace48e-LICENSE). The retained `20240523004032_redefine_authorization_tables.ex` original is covered by the same license.
- `0013-add-bucket-custom-limits.sql` → [supabase/storage license](licenses/supabase-storage-e89d526fa3e3e7600b6a22cedf43aa058924d19a-LICENSE).
- `0014-use-bytes-for-max-size.sql` → [supabase/storage license](licenses/supabase-storage-e89d526fa3e3e7600b6a22cedf43aa058924d19a-LICENSE).
- `20250623125453_tmp_grant_storage_tables_to_postgres_with_grant_option.sql` → [supabase/postgres license](licenses/supabase-postgres-73119f8bfae2bfb07ddfa18240ab8e5f56f737a8-LICENSE).
- `20220224000811_update_auth_functions.up.sql` → [supabase/auth license](licenses/supabase-auth-e062eeae0079a6b1a70d5d5da9e5ac5cb8c21194-LICENSE).

## Adaptations and release provenance

Original upstream SQL files remain unchanged on disk. At execution, Auth's namespace template is rendered as `auth`; standalone transaction envelopes are normalized to preserve atomic source-file/ledger commits. Storage's existing-role bootstrap option is set by the runner.

`realtime-role.sql` is an extraction of the applicable upstream role SQL and grants; changes for absent predecessor tables are omitted. `realtime-foundation.sql` translates upstream Ecto table/index declarations to SQL and omits drops of absent predecessor tables. These are fixture adaptations, not unmodified upstream migration files; the original Ecto files and their hashes are preserved beside them. Exact mapping and modification descriptions are in the executable `manifest.json`.

The Supabase Postgres image release tag `17.6.1.165` resolves in the official repository to commit `73119f8bfae2bfb07ddfa18240ab8e5f56f737a8`. The [release source SQL](https://raw.githubusercontent.com/supabase/postgres/73119f8bfae2bfb07ddfa18240ab8e5f56f737a8/migrations/db/migrations/20250623125453_tmp_grant_storage_tables_to_postgres_with_grant_option.sql) has SHA-256 `1289f81f7111147fc334fa44ec00c31c871f5ba325c16cc205646ff07507cf04`, matching the vendored image file exactly. Its license therefore comes from that pinned release commit; no current-main license substitution was used.

The official root-directory listings at the selected references contain LICENSE and no separate NOTICE or COPYRIGHT file. This attribution covers the copied fixture source, not a license inventory of every binary dependency in the complete container image.
