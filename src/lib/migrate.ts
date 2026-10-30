import init from '../../migrations/0001_init.sql'

/**
 * Schema migrations, applied by the Worker on first use in each isolate. Deploys are a plain
 * `wrangler deploy` (Workers Builds on push to main), so there is no separate migration step.
 *
 * To change the schema, add migrations/000N_name.sql and append it here. Never edit an applied file.
 */
const MIGRATIONS: [name: string, sql: string][] = [['0001_init', init]]

function statements(sql: string): string[] {
    return sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter(Boolean)
}

async function migrate(db: D1Database): Promise<void> {
    await db.prepare('CREATE TABLE IF NOT EXISTS _schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)').run()
    const { results } = await db.prepare('SELECT name FROM _schema_migrations').all<{ name: string }>()
    const applied = new Set(results.map((r) => r.name))

    for (const [name, sql] of MIGRATIONS) {
        if (applied.has(name)) continue
        // A batch is one transaction: if another isolate applied this migration concurrently, the
        // _schema_migrations insert (or the DDL itself) fails and everything here rolls back.
        try {
            await db.batch([
                ...statements(sql).map((s) => db.prepare(s)),
                db.prepare('INSERT INTO _schema_migrations (name, applied_at) VALUES (?, ?)').bind(name, Date.now()),
            ])
        } catch (error) {
            const done = await db.prepare('SELECT 1 FROM _schema_migrations WHERE name = ?').bind(name).first()
            if (!done) throw error
        }
    }
}

let ready: Promise<void> | undefined

export function ensureSchema(db: D1Database): Promise<void> {
    ready ??= migrate(db).catch((error) => {
        ready = undefined
        throw error
    })
    return ready
}
