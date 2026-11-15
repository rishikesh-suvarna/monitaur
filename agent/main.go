package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"agent/client"
	"agent/config"
	"agent/metrics"
)

var (
	Version = "dev" // Set during build
)

// systemd sends SIGKILL after TimeoutStopSec (90 s by default); stay well under it.
const shutdownTimeout = 5 * time.Second

func main() {
	var (
		createConfig = flag.Bool("init", false, "Create sample config.json file")
		version      = flag.Bool("version", false, "Show version information")
		showHelp     = flag.Bool("help", false, "Show help information")
	)
	flag.Parse()

	// Show version
	if *version {
		fmt.Printf("Monitaur Agent v%s\n", Version)
		return
	}

	// Show help
	if *showHelp {
		fmt.Printf("Monitaur Agent v%s\n\n", Version)
		fmt.Println("Usage:")
		fmt.Println("  monitaur-agent [options]")
		fmt.Println("")
		fmt.Println("Options:")
		fmt.Println("  -init           Create sample config.json file")
		fmt.Println("  -config string  Path to config file")
		fmt.Println("  -version        Show version information")
		fmt.Println("  -help           Show this help message")
		fmt.Println("")
		fmt.Println("Configuration:")
		fmt.Println("  The agent looks for config.json in:")
		fmt.Println("  - Current directory")
		fmt.Println("  - /etc/monitaur/")
		fmt.Println("  - ~/.monitaur/")
		fmt.Println("")
		fmt.Println("For more information, visit: https://github.com/yourusername/monitaur")
		return
	}

	// Create sample config if requested
	if *createConfig {
		if err := config.CreateSampleConfig(); err != nil {
			log.Fatalf("Failed to create config: %v", err)
		}
		log.Println("Sample config.json created. Please edit it with your token.")
		return
	}

	// Load configuration
	cfg, err := config.LoadConfig()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	log.Printf("Starting Monitaur Agent v%s for: %s", Version, cfg.ServerName)
	log.Printf("Collection interval: %d seconds", cfg.CollectionInterval)

	// Initialize metrics collector
	collector := metrics.NewCollector(cfg.ServerName)

	wsClient, err := client.NewClient(cfg.APIEndpoint, cfg.Token, cfg.ServerName, Version)
	if err != nil {
		log.Fatalf("Invalid api_endpoint in config: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The client dials, reconnects, and shuts down on its own. A backend that
	// is down at boot is retried instead of exiting the agent.
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		wsClient.Run(ctx)
	}()

	// Main monitoring loop
	configuredInterval := time.Duration(cfg.CollectionInterval) * time.Second
	interval := configuredInterval
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	log.Println("Agent started successfully. Press Ctrl+C to stop.")

	for {
		select {
		case <-ticker.C:
			// Collect metrics
			systemMetrics, err := collector.CollectMetrics()
			if err != nil {
				log.Printf("Error collecting metrics: %v", err)
				continue
			}

			// While disconnected samples are dropped; the client logs the outage.
			if err := wsClient.SendMetrics(systemMetrics); err != nil && !errors.Is(err, client.ErrNotConnected) {
				log.Printf("Error sending metrics: %v", err)
			}

			// Check for alerts
			alerts := collector.CheckAlerts(systemMetrics, metrics.AlertThresholds{
				CPU:    cfg.AlertThresholds.CPU,
				Memory: cfg.AlertThresholds.Memory,
				Disk:   cfg.AlertThresholds.Disk,
			})

			// Send alerts
			for _, alert := range alerts {
				log.Printf("ALERT: %s", alert.Message)
				if err := wsClient.SendAlert(alert); err != nil && !errors.Is(err, client.ErrNotConnected) {
					log.Printf("Error sending alert: %v", err)
				}
			}

			// Log basic stats periodically
			log.Printf("CPU: %.1f%% | Memory: %.1f%% | Disk: %.1f%%",
				systemMetrics.CPU.Usage,
				systemMetrics.Memory.UsedPercent,
				systemMetrics.Disk.UsedPercent)

		case update := <-wsClient.ConfigUpdates():
			// The backend pushes its minimum interval (for example a plan
			// limit). It can only slow collection down: the agent never
			// samples faster than config.json asks for.
			next := max(configuredInterval, update.CollectionInterval)
			if next != interval {
				log.Printf("Collection interval changed from %s to %s (server minimum %s, configured %s)",
					interval, next, update.CollectionInterval, configuredInterval)
				interval = next
				ticker.Reset(interval)
			}

		case <-ctx.Done():
			log.Println("Shutdown signal received, stopping agent...")
			select {
			case <-clientDone:
			case <-time.After(shutdownTimeout):
				log.Println("Timed out waiting for the connection to close")
			}
			return
		}
	}
}
