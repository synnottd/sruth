# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Database

- **No Prisma migrations.** Do not create or run `prisma migrate dev`, `prisma migrate deploy`, or generate migration files. Use `prisma db push` to sync the schema to the database. Delete any existing `prisma/migrations/` directories if encountered during conflict resolution.
- This policy applies until further notice.
