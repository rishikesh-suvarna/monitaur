// Package testdb gives each test its own throwaway Postgres database.
// Tests are skipped unless MONITAUR_TEST_DATABASE_URL points at a server
// where the user may CREATE DATABASE (CI runs a postgres service container).
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"backend/database"
)

const (
	envURL       = "MONITAUR_TEST_DATABASE_URL"
	setupTimeout = 30 * time.Second
)

// New creates an empty database and returns a pool to it. Migrations are not
// applied, so tests can stage legacy schemas first.
func New(t *testing.T) *pgxpool.Pool {
	t.Helper()
	admin := os.Getenv(envURL)
	if admin == "" {
		t.Skipf("%s not set; skipping database test", envURL)
	}
	ctx, cancel := context.WithTimeout(context.Background(), setupTimeout)
	defer cancel()

	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		t.Fatal(err)
	}
	name := "monitaur_t_" + hex.EncodeToString(buf)

	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	_ = conn.Close(ctx)

	u, err := url.Parse(admin)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		ctx, cancel := context.WithTimeout(context.Background(), setupTimeout)
		defer cancel()
		conn, err := pgx.Connect(ctx, admin)
		if err != nil {
			return
		}
		defer conn.Close(ctx)
		_, _ = conn.Exec(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
	})
	return pool
}

// Migrated is New plus all migrations.
func Migrated(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := New(t)
	ctx, cancel := context.WithTimeout(context.Background(), setupTimeout)
	defer cancel()
	if err := database.Migrate(ctx, pool, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}
