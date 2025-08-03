package main

import (
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

	// Initialize WebSocket client
	wsClient := client.NewClient(cfg.APIEndpoint, cfg.Token, cfg.ServerName)

	// Connect to server
	if err := wsClient.Connect(); err != nil {
		log.Fatalf("Failed to connect to monitoring server: %v", err)
	}
	defer wsClient.Close()

	// Start heartbeat in background
	go wsClient.StartHeartbeat()

	// Start message listener
	go wsClient.ListenForMessages()

	// Set up graceful shutdown
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)

	// Main monitoring loop
	ticker := time.NewTicker(time.Duration(cfg.CollectionInterval) * time.Second)
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

			// Send metrics to server
			if wsClient.IsConnected() {
				if err := wsClient.SendMetrics(systemMetrics); err != nil {
					log.Printf("Error sending metrics: %v", err)
				}
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
				if wsClient.IsConnected() {
					if err := wsClient.SendAlert(alert); err != nil {
						log.Printf("Error sending alert: %v", err)
					}
				}
			}

			// Log basic stats periodically
			log.Printf("CPU: %.1f%% | Memory: %.1f%% | Disk: %.1f%%",
				systemMetrics.CPU.Usage,
				systemMetrics.Memory.UsedPercent,
				systemMetrics.Disk.UsedPercent)

		case <-interrupt:
			log.Println("Shutdown signal received, stopping agent...")
			return
		}
	}
}
