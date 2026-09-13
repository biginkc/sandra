import pg from "pg";

// Disposable synthetic database only; never accepts an arbitrary connection URL.
export const DATABASE_URL =
  "postgres://postgres@127.0.0.1:58782/sandra_inbox_t1";
export const ORG_A = "11111111-1111-4111-8111-111111111111";
export const ORG_B = "22222222-2222-4222-8222-222222222222";
export const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
export async function assertFixtureDatabase(): Promise<void> {
  const { rows } = await pool.query(
    "select current_database() as name, marker from inbox_t1.fixture_identity",
  );
  if (
    rows.length !== 1 ||
    rows[0].name !== "sandra_inbox_t1" ||
    rows[0].marker !== "sandra-inbox-stack-t1-owned-synthetic"
  ) {
    throw new Error("Refusing to operate outside the owned Inbox T1 fixture");
  }
}
