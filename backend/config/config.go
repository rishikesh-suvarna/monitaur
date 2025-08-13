package config

import (
	"log"

	"github.com/spf13/viper"
)

type Config struct {
	Server   ServerConfig   `mapstructure:"server"`
	Database DatabaseConfig `mapstructure:"database"`
	Firebase FirebaseConfig `mapstructure:"firebase"`
	SMTP     SMTPConfig     `mapstructure:"smtp"`
}

type ServerConfig struct {
	Port         string `mapstructure:"port"`
	Host         string `mapstructure:"host"`
	AllowOrigins string `mapstructure:"allow_origins"`
}

type DatabaseConfig struct {
	Host     string `mapstructure:"host"`
	Port     string `mapstructure:"port"`
	User     string `mapstructure:"user"`
	Password string `mapstructure:"password"`
	DBName   string `mapstructure:"dbname"`
	SSLMode  string `mapstructure:"sslmode"`
}

type FirebaseConfig struct {
	ServiceAccountPath string `mapstructure:"service_account_path"`
	ProjectID          string `mapstructure:"project_id"`
}

type SMTPConfig struct {
	Host     string `mapstructure:"host"`
	Port     string `mapstructure:"port"`
	Username string `mapstructure:"username"`
	Password string `mapstructure:"password"`
	From     string `mapstructure:"from"`
}

func LoadConfig() (*Config, error) {
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath(".")
	viper.AddConfigPath("./config")

	// Set defaults
	viper.SetDefault("server.port", "8080")
	viper.SetDefault("server.host", "localhost")
	viper.SetDefault("server.allow_origins", "*")
	viper.SetDefault("database.host", "localhost")
	viper.SetDefault("database.port", "5432")
	viper.SetDefault("database.user", "postgres")
	viper.SetDefault("database.dbname", "monitaur")
	viper.SetDefault("database.sslmode", "disable")
	viper.SetDefault("smtp.host", "email-smtp.ap-south-1.amazonaws.com")
	viper.SetDefault("smtp.port", "587")
	viper.SetDefault("smtp.from", "rowan@ideamagix.in")

	// Allow environment variables
	viper.AutomaticEnv()

	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); ok {
			log.Println("Config file not found, using defaults and environment variables")
		} else {
			return nil, err
		}
	}

	var config Config
	if err := viper.Unmarshal(&config); err != nil {
		return nil, err
	}

	return &config, nil
}

// CreateSampleConfig creates a sample configuration file
func CreateSampleConfig() error {
	viper.Set("server.port", "8080")
	viper.Set("server.host", "localhost")
	viper.Set("server.allow_origins", "*")

	viper.Set("database.host", "localhost")
	viper.Set("database.port", "5432")
	viper.Set("database.user", "postgres")
	viper.Set("database.password", "your_password_here")
	viper.Set("database.dbname", "monitaur")
	viper.Set("database.sslmode", "disable")

	viper.Set("firebase.service_account_path", "./firebase-service-account.json")
	viper.Set("firebase.project_id", "your-firebase-project-id")

	viper.Set("smtp.host", "your_smtp_host_here")
	viper.Set("smtp.port", "your_smtp_port_here")
	viper.Set("smtp.username", "your_smtp_username_here")
	viper.Set("smtp.password", "your_smtp_password_here")
	viper.Set("smtp.from", "your_smtp_from_here")

	return viper.WriteConfigAs("config.yaml")
}
