// Package config loads config.yaml (or ./config/config.yaml) with environment
// overrides: MONITAUR_DATABASE_PASSWORD overrides database.password, etc.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/viper"
)

const (
	envPrefix = "MONITAUR"

	defaultFlushInterval = 30 * time.Minute
	defaultRawWindow     = time.Hour
	defaultRecentWindow  = 24 * time.Hour
	encryptionKeyBytes   = 32
)

type Config struct {
	Server   ServerConfig   `mapstructure:"server"`
	Public   PublicConfig   `mapstructure:"public"`
	Database DatabaseConfig `mapstructure:"database"`
	Firebase FirebaseConfig `mapstructure:"firebase"`
	SMTP     SMTPConfig     `mapstructure:"smtp"`
	Metrics  MetricsConfig  `mapstructure:"metrics"`
	Limits   LimitsConfig   `mapstructure:"limits"`
	Secrets  SecretsConfig  `mapstructure:"secrets"`
	Notify   NotifyConfig   `mapstructure:"notify"`
	Log      LogConfig      `mapstructure:"log"`
}

type ServerConfig struct {
	Port string `mapstructure:"port"`
	Host string `mapstructure:"host"`
	// Comma-separated list of browser origins allowed to call the API.
	AllowOrigins string `mapstructure:"allow_origins"`
	// Release turns off Gin debug output.
	Release bool `mapstructure:"release"`
}

func (s ServerConfig) Origins() []string {
	var out []string
	for _, o := range strings.Split(s.AllowOrigins, ",") {
		if o = strings.TrimSpace(o); o != "" {
			out = append(out, strings.TrimRight(o, "/"))
		}
	}
	return out
}

// PublicConfig holds the URLs users and agents see, used in install snippets
// and notification links.
type PublicConfig struct {
	AppURL    string `mapstructure:"app_url"`
	IngestURL string `mapstructure:"ingest_url"`
}

type DatabaseConfig struct {
	// URL takes precedence over the discrete fields (Neon hands out URLs).
	URL         string `mapstructure:"url"`
	Host        string `mapstructure:"host"`
	Port        string `mapstructure:"port"`
	User        string `mapstructure:"user"`
	Password    string `mapstructure:"password"`
	DBName      string `mapstructure:"dbname"`
	SSLMode     string `mapstructure:"sslmode"`
	MaxConns    int32  `mapstructure:"max_conns"`
	AutoMigrate bool   `mapstructure:"auto_migrate"`
}

// DSN builds a URL with proper escaping. The v1 key=value DSN broke on empty
// or special-character passwords.
func (d DatabaseConfig) DSN() string {
	if d.URL != "" {
		return d.URL
	}
	u := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(d.User, d.Password),
		Host:     d.Host + ":" + d.Port,
		Path:     "/" + d.DBName,
		RawQuery: url.Values{"sslmode": {d.SSLMode}}.Encode(),
	}
	return u.String()
}

type FirebaseConfig struct {
	ServiceAccountPath string `mapstructure:"service_account_path"`
	ProjectID          string `mapstructure:"project_id"`
	// RequireAppCheck rejects API calls without a valid X-Firebase-AppCheck token.
	RequireAppCheck bool `mapstructure:"require_app_check"`
}

type SMTPConfig struct {
	Host       string `mapstructure:"host"`
	Port       string `mapstructure:"port"`
	Username   string `mapstructure:"username"`
	Password   string `mapstructure:"password"`
	From       string `mapstructure:"from"`
	RequireTLS bool   `mapstructure:"require_tls"`
}

func (s SMTPConfig) Enabled() bool { return s.Host != "" && s.From != "" }

type MetricsConfig struct {
	FlushInterval time.Duration `mapstructure:"flush_interval"`
	RawWindow     time.Duration `mapstructure:"raw_window"`
	RecentWindow  time.Duration `mapstructure:"recent_window"`
	JournalDir    string        `mapstructure:"journal_dir"`
}

type LimitsConfig struct {
	DefaultPlan string `mapstructure:"default_plan"`
}

type SecretsConfig struct {
	// Base64 of 32 random bytes; encrypts notification channel configs.
	EncryptionKey string `mapstructure:"encryption_key"`
}

func (s SecretsConfig) Key() ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(s.EncryptionKey)
	if err != nil {
		return nil, fmt.Errorf("secrets.encryption_key is not base64: %w", err)
	}
	if len(key) != encryptionKeyBytes {
		return nil, fmt.Errorf("secrets.encryption_key must decode to %d bytes, got %d", encryptionKeyBytes, len(key))
	}
	return key, nil
}

type NotifyConfig struct {
	// AllowPrivateWebhooks lets webhooks reach private networks. Only for
	// single-tenant self-hosting; with public sign-up it is an SSRF hole.
	AllowPrivateWebhooks bool `mapstructure:"allow_private_webhooks"`
}

type LogConfig struct {
	Level  string `mapstructure:"level"`
	Format string `mapstructure:"format"` // "json" or "text"
}

func setDefaults(v *viper.Viper) {
	v.SetDefault("server.port", "8080")
	v.SetDefault("server.host", "localhost")
	v.SetDefault("server.allow_origins", "http://localhost:5173")
	v.SetDefault("server.release", false)
	v.SetDefault("public.app_url", "http://localhost:5173")
	v.SetDefault("public.ingest_url", "ws://localhost:8080/agent/connect")
	v.SetDefault("database.host", "localhost")
	v.SetDefault("database.port", "5432")
	v.SetDefault("database.user", "postgres")
	v.SetDefault("database.dbname", "monitaur")
	v.SetDefault("database.sslmode", "require")
	v.SetDefault("database.max_conns", 5)
	v.SetDefault("database.auto_migrate", true)
	v.SetDefault("smtp.port", "587")
	v.SetDefault("smtp.require_tls", true)
	v.SetDefault("metrics.flush_interval", defaultFlushInterval)
	v.SetDefault("metrics.raw_window", defaultRawWindow)
	v.SetDefault("metrics.recent_window", defaultRecentWindow)
	v.SetDefault("metrics.journal_dir", "/var/lib/monitaur/journal")
	v.SetDefault("limits.default_plan", "free")
	v.SetDefault("log.level", "info")
	v.SetDefault("log.format", "json")
}

func LoadConfig() (*Config, error) {
	v := viper.New()
	v.SetConfigName("config")
	v.SetConfigType("yaml")
	v.AddConfigPath(".")
	v.AddConfigPath("./config")
	setDefaults(v)

	v.SetEnvPrefix(envPrefix)
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	if err := v.ReadInConfig(); err != nil {
		var notFound viper.ConfigFileNotFoundError
		if !errors.As(err, &notFound) {
			return nil, err
		}
	}

	// AutomaticEnv only applies to keys viper already knows; bind the ones
	// with no default so env-only deployments work.
	for _, key := range []string{
		"database.url", "database.password", "firebase.service_account_path", "firebase.project_id",
		"firebase.require_app_check", "smtp.host", "smtp.username", "smtp.password", "smtp.from",
		"secrets.encryption_key", "notify.allow_private_webhooks",
	} {
		if err := v.BindEnv(key); err != nil {
			return nil, err
		}
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, err
	}
	return &cfg, cfg.Validate()
}

// Validate fails fast on settings that would otherwise break at first use.
func (c *Config) Validate() error {
	var errs []error
	if _, err := c.Secrets.Key(); err != nil {
		errs = append(errs, err)
	}
	if c.Firebase.ProjectID == "" {
		errs = append(errs, errors.New("firebase.project_id is required"))
	}
	if len(c.Server.Origins()) == 0 {
		errs = append(errs, errors.New("server.allow_origins must list at least one origin"))
	}
	for _, o := range c.Server.Origins() {
		if o == "*" {
			errs = append(errs, errors.New("server.allow_origins must not be \"*\" (credentials are sent)"))
		}
	}
	if c.Metrics.FlushInterval < time.Minute {
		errs = append(errs, errors.New("metrics.flush_interval must be at least 1m"))
	}
	return errors.Join(errs...)
}

// CreateSampleConfig writes a starter config.yaml in the working directory.
func CreateSampleConfig() error {
	v := viper.New()
	setDefaults(v)
	v.Set("database.password", "your_password_here")
	v.Set("firebase.service_account_path", "./firebase-service-account.json")
	v.Set("firebase.project_id", "your-firebase-project-id")
	v.Set("smtp.host", "email-smtp.example.com")
	v.Set("smtp.username", "your_smtp_username")
	v.Set("smtp.password", "your_smtp_password")
	v.Set("smtp.from", "alerts@your-domain.com")
	v.Set("secrets.encryption_key", "generate with: openssl rand -base64 32")
	return v.SafeWriteConfigAs("config.yaml")
}
