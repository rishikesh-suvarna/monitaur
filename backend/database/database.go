// Package database opens the Postgres pool and applies embedded migrations.
package database

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"

	"backend/config"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

const (
	// Neon suspends after 5 min without queries. Idle connections do not keep
	// it awake, but closing them quickly keeps the pool honest after a wake.
	maxConnIdleTime   = time.Minute
	maxConnLifetime   = 30 * time.Minute
	connectTimeout    = 15 * time.Second
	healthCheckPeriod = time.Minute
)

// Open creates a pool without connecting eagerly, so startup does not wake
// the database by itself.
func Open(ctx context.Context, cfg config.DatabaseConfig) (*pgxpool.Pool, error) {
	pcfg, err := pgxpool.ParseConfig(cfg.DSN())
	if err != nil {
		return nil, fmt.Errorf("parse database config: %w", err)
	}
	if cfg.MaxConns > 0 {
		pcfg.MaxConns = cfg.MaxConns
	}
	pcfg.MinConns = 0
	pcfg.MaxConnIdleTime = maxConnIdleTime
	pcfg.MaxConnLifetime = maxConnLifetime
	pcfg.HealthCheckPeriod = healthCheckPeriod
	pcfg.ConnConfig.ConnectTimeout = connectTimeout
	// Exec mode avoids server-side prepared statements, which Neon's pooled
	// (PgBouncer) endpoints do not keep across transactions.
	pcfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec

	pool, err := pgxpool.NewWithConfig(ctx, pcfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	return pool, nil
}

// Migrate applies pending migrations under a Postgres advisory lock, so two
// processes starting at once cannot race.
func Migrate(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		return err
	}
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return err
	}
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()

	provider, err := goose.NewProvider(goose.DialectPostgres, db, sub, goose.WithSessionLocker(locker))
	if err != nil {
		return fmt.Errorf("create migration provider: %w", err)
	}
	results, err := provider.Up(ctx)
	for _, r := range results {
		log.Info("migration applied", "version", r.Source.Version, "file", r.Source.Path, "duration", r.Duration)
	}
	if err != nil {
		var partial *goose.PartialError
		if errors.As(err, &partial) {
			return fmt.Errorf("migration %s failed: %w", partial.Failed.Source.Path, partial.Err)
		}
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}
