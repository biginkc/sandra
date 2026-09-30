This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

### Sequences production canary runbook

The dispatch guard requires `SEQUENCE_CANARY_USER_ID`,
`SEQUENCE_CANARY_PROPERTY_ID`, and `SEQUENCE_CANARY_CONTACT_ID` in **both**
GitHub Actions secrets and Vercel production environment variables. Keep
`SEQUENCE_CANARY_SCHEDULE_ENABLED` unset or `false` until the owner gates and
production checks pass. A missing Vercel value makes dispatch fail closed.

For a read-only runner check, dispatch **Sequences V1 Prod Canary** with
`mode=preflight-only` and existing message and webhook event UUIDs. This mode
compares the runner's `PROD_SUPABASE_URL` hostname with
`copflsklaefwzipsrjqz.supabase.co` and SELECTs those two rows. It does not
enroll, send, or clean up. Use `mode=full` only for the authorized send window;
scheduled runs use full mode when the schedule variable is `true`.

### Outbox regression record

`npm run test:outbox-regression` requires the owned disposable Supabase stack on
`127.0.0.1:55421` (API) and `127.0.0.1:55422` (DB), plus its test credentials
and `E2E_DISPOSABLE_DATABASE=1`. The runner starts and stops its loopback fault
proxy on `127.0.0.1:54321` (API) and `127.0.0.1:54322` (DB). These four ports
must be available to their respective processes.

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
