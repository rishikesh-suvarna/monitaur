package config

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/viper"
)

const (
	sampleConfigFile = "config.json"
	// The config holds the server token, so only its owner may read it.
	configFileMode os.FileMode = 0o600
)

type Config struct {
	Token              string          `json:"token" mapstructure:"token"`
	APIEndpoint        string          `json:"api_endpoint" mapstructure:"api_endpoint"`
	CollectionInterval int             `json:"collection_interval" mapstructure:"collection_interval"`
	ServerName         string          `json:"server_name" mapstructure:"server_name"`
	AlertThresholds    AlertThresholds `json:"alert_thresholds" mapstructure:"alert_thresholds"`
}

type AlertThresholds struct {
	CPU    float64 `json:"cpu" mapstructure:"cpu"`
	Memory float64 `json:"memory" mapstructure:"memory"`
	Disk   float64 `json:"disk" mapstructure:"disk"`
}

func LoadConfig() (*Config, error) {
	viper.SetConfigName("config")
	viper.SetConfigType("json")
	viper.AddConfigPath(".")
	viper.AddConfigPath("/etc/monitaur/")
	viper.AddConfigPath("$HOME/.monitaur/")

	// Set defaults
	viper.SetDefault("api_endpoint", "ws://localhost:8080/agent/connect")
	viper.SetDefault("collection_interval", 5)
	viper.SetDefault("server_name", getHostname())
	viper.SetDefault("alert_thresholds.cpu", 80.0)
	viper.SetDefault("alert_thresholds.memory", 85.0)
	viper.SetDefault("alert_thresholds.disk", 90.0)

	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); ok {
			return nil, fmt.Errorf("config file not found. Please create config.json with your token or run with -init flag")
		}
		return nil, fmt.Errorf("error reading config file: %w", err)
	}

	var config Config
	if err := viper.Unmarshal(&config); err != nil {
		return nil, fmt.Errorf("error unmarshaling config: %w", err)
	}

	// Use hostname as server name if not specified
	if config.ServerName == "" {
		config.ServerName = getHostname()
	}
	if err := config.validate(); err != nil {
		return nil, err
	}
	return &config, nil
}

const (
	minCollectionInterval = 1
	maxCollectionInterval = 86400 // one day
)

// validate fails fast on values that would otherwise crash later
// (time.NewTicker panics on a non-positive interval).
func (c *Config) validate() error {
	if c.Token == "" {
		return fmt.Errorf("token is required in config.json")
	}
	if c.CollectionInterval < minCollectionInterval || c.CollectionInterval > maxCollectionInterval {
		return fmt.Errorf("collection_interval must be between %d and %d seconds, got %d",
			minCollectionInterval, maxCollectionInterval, c.CollectionInterval)
	}
	if c.APIEndpoint == "" {
		return fmt.Errorf("api_endpoint is required in config.json")
	}
	return nil
}

func getHostname() string {
	hostname, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return hostname
}

// CreateSampleConfig creates a sample configuration file
func CreateSampleConfig() error {
	config := Config{
		Token:              "your-server-token-here",
		APIEndpoint:        "ws://localhost:8080/agent/connect",
		CollectionInterval: 5,
		ServerName:         getHostname(),
		AlertThresholds: AlertThresholds{
			CPU:    80.0,
			Memory: 85.0,
			Disk:   90.0,
		},
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	if err := os.WriteFile(sampleConfigFile, data, configFileMode); err != nil {
		return err
	}
	// WriteFile applies the mode only when it creates the file; an existing
	// config.json keeps its old (possibly world-readable) mode without this.
	return os.Chmod(sampleConfigFile, configFileMode)
}
