# Family gift catalogue

Private present ideas and buying coordination for a family. Built with SvelteKit, the Node adapter, TypeScript, Drizzle and SQLite on local disk.

## Local development

Use Node 26 LTS (26.13.0 or later in the same major version):

```sh
npm ci
npm run db:migrate
npm run dev
```

`DATABASE_PATH` selects the SQLite file; the default is `./data/gifts.sqlite`. Keep the database on local disk. The database factory enables foreign keys and WAL, and applies versioned migrations through `npm run db:migrate`. Local household storage and environment files are ignored by Git.

## Verification

```sh
npm run check
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
```

Integration tests create isolated temporary databases. Browser tests and device acceptance are added with their application flows. Model tests prove persistence and catalogue constraints; they do not establish authentication, permissions or device behaviour.

Generate a migration after changing the Drizzle schema with `npx drizzle-kit generate --name descriptive_name`. Review the generated SQL before applying it. Production deployment and backup instructions will accompany the complete application.
