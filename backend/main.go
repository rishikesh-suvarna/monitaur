package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"backend/app"
	"backend/auth"
	"backend/config"
	"backend/database"
)

const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 30 * time.Second
	idleTimeout       = 120 * time.Second
	shutdownTimeout   = 25 * time.Second
)

func main() {
	initConfig := flag.Bool("init", false, "write a sample config.yaml and exit")
	migrateOnly := flag.Bool("migrate", false, "apply database migrations and exit")
	flag.Parse()

	if *initConfig {
		if err := config.CreateSampleConfig(); err != nil {
			slog.Error("create sample config", "err", err)
			os.Exit(1)
		}
		slog.Info("wrote config.yaml; edit it, then start the server")
		return
	}
	if err := run(*migrateOnly); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(migrateOnly bool) error {
	cfg, err := config.LoadConfig()
	if err != nil {
		return err
	}
	log := newLogger(cfg.Log)
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := database.Open(ctx, cfg.Database)
	if err != nil {
		return err
	}
	defer pool.Close()

	if migrateOnly || cfg.Database.AutoMigrate {
		if err := database.Migrate(ctx, pool, log); err != nil {
			return err
		}
	}
	if migrateOnly {
		return nil
	}

	verifier, err := auth.NewFirebaseVerifier(ctx, cfg.Firebase)
	if err != nil {
		return err
	}
	application, err := app.New(ctx, cfg, log, pool, verifier)
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              net.JoinHostPort(cfg.Server.Host, cfg.Server.Port),
		Handler:           application.Handler(),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		// No WriteTimeout: SSE and agent WebSockets are long-lived. Handlers
		// bound their own work instead.
		IdleTimeout: idleTimeout,
		// Request contexts end on SIGTERM, so SSE handlers return and
		// Shutdown does not wait for them.
		BaseContext: func(net.Listener) context.Context { return ctx },
	}

	appDone := make(chan struct{})
	go func() {
		defer close(appDone)
		application.Run(ctx)
	}()

	serveErr := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	select {
	case <-ctx.Done():
		log.Info("shutting down")
	case err := <-serveErr:
		stop()
		return err
	}

	application.Shutdown()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Warn("http shutdown", "err", err)
	}
	select {
	case <-appDone: // includes the final metrics flush
	case <-shutdownCtx.Done():
		log.Warn("timed out waiting for background work")
	}
	return nil
}

func newLogger(cfg config.LogConfig) *slog.Logger {
	var level slog.Level
	if err := level.UnmarshalText([]byte(cfg.Level)); err != nil {
		level = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: level}
	if strings.EqualFold(cfg.Format, "text") {
		return slog.New(slog.NewTextHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, opts))
}
