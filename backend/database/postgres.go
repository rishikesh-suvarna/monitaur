package database

import (
	"fmt"
	"log"
	"time"

	"backend/config"
	"backend/models"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type Database struct {
	DB *gorm.DB
}

func NewDatabase(cfg *config.DatabaseConfig) (*Database, error) {
	dsn := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
		cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.DBName, cfg.SSLMode)

	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Info),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to connect to database: %w", err)
	}

	// Configure connection pool
	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("failed to get sql.DB: %w", err)
	}

	sqlDB.SetMaxOpenConns(25)
	sqlDB.SetMaxIdleConns(5)
	sqlDB.SetConnMaxLifetime(time.Hour)

	// Check what database we're actually connected to
	var actualDBName string
	err = db.Raw("SELECT current_database()").Scan(&actualDBName).Error
	if err != nil {
		log.Printf("Warning: Could not determine connected database name: %v", err)
		log.Printf("Connected to PostgreSQL database (config says: %s)", cfg.DBName)
	} else {
		log.Printf("Connected to PostgreSQL database: %s", actualDBName)
		if actualDBName != cfg.DBName {
			log.Printf("WARNING: Connected to '%s' but config specifies '%s'", actualDBName, cfg.DBName)
		}
	}

	return &Database{DB: db}, nil
}

// AutoMigrate runs database migrations
func (d *Database) AutoMigrate() error {
	log.Println("Running database migrations...")

	// Migrate tables in order to handle foreign key dependencies
	err := d.DB.AutoMigrate(
		&models.User{},
		&models.Server{},
		&models.Metric{},
		&models.Alert{},
	)
	if err != nil {
		return fmt.Errorf("failed to run migrations: %w", err)
	}

	// Create TimescaleDB hypertable for metrics (if TimescaleDB is available)
	if err := d.createHypertable(); err != nil {
		log.Printf("Warning: Could not create TimescaleDB hypertable: %v", err)
		log.Println("This is normal if TimescaleDB extension is not installed")
	}

	log.Println("Database migrations completed")
	return nil
}

// createHypertable creates a TimescaleDB hypertable for metrics
func (d *Database) createHypertable() error {
	// Check if TimescaleDB extension is available
	var extensionExists bool
	err := d.DB.Raw("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')").Scan(&extensionExists).Error
	if err != nil {
		return err
	}

	if !extensionExists {
		return fmt.Errorf("TimescaleDB extension not found")
	}

	// Check if hypertable already exists
	var hypertableExists bool
	err = d.DB.Raw("SELECT EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'metrics')").Scan(&hypertableExists).Error
	if err != nil {
		return err
	}

	if !hypertableExists {
		// Create hypertable
		err = d.DB.Exec("SELECT create_hypertable('metrics', 'time', if_not_exists => TRUE)").Error
		if err != nil {
			return err
		}
		log.Println("Created TimescaleDB hypertable for metrics")
	}

	return nil
}

// User operations
func (d *Database) CreateUser(user *models.User) error {
	return d.DB.Create(user).Error
}

func (db *Database) GetUserByID(userID uint) (*models.User, error) {
	var user models.User
	err := db.DB.First(&user, userID).Error
	return &user, err
}

func (d *Database) GetUserByUID(uid string) (*models.User, error) {
	var user models.User
	err := d.DB.Where("firebase_uid = ?", uid).First(&user).Error
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (d *Database) GetOrCreateUser(uid, email string) (*models.User, error) {
	user, err := d.GetUserByUID(uid)
	if err == gorm.ErrRecordNotFound {
		// Create new user
		log.Printf("Creating new user: %s (%s)", email, uid)
		user = &models.User{
			FirebaseUID: uid,
			Email:       email,
		}
		if err := d.CreateUser(user); err != nil {
			log.Printf("Failed to create user: %v", err)
			return nil, err
		}
		log.Printf("Successfully created user with ID: %d", user.ID)
	} else if err != nil {
		log.Printf("Error getting user: %v", err)
		return nil, err
	} else {
		log.Printf("Found existing user: %s (ID: %d)", user.Email, user.ID)
	}
	return user, nil
}

// Server operations
func (d *Database) CreateServer(server *models.Server) error {
	return d.DB.Create(server).Error
}

func (db *Database) GetServerByID(serverID uint) (*models.Server, error) {
	var server models.Server
	err := db.DB.First(&server, serverID).Error
	return &server, err
}

func (d *Database) GetServerByToken(token string) (*models.Server, error) {
	var server models.Server
	err := d.DB.Where("token = ?", token).First(&server).Error
	if err != nil {
		return nil, err
	}
	return &server, nil
}

func (d *Database) GetUserServers(userUID string) ([]models.Server, error) {
	// First get the user to get their ID
	user, err := d.GetUserByUID(userUID)
	if err != nil {
		return nil, err
	}

	var servers []models.Server
	err = d.DB.Where("user_id = ?", user.ID).Find(&servers).Error
	return servers, err
}

func (d *Database) UpdateServerLastSeen(serverID uint) error {
	now := time.Now()
	return d.DB.Model(&models.Server{}).Where("id = ?", serverID).Updates(map[string]interface{}{
		"last_seen": &now,
		"status":    "online",
	}).Error
}

func (d *Database) UpdateServerStatus(serverID uint, status string) error {
	return d.DB.Model(&models.Server{}).Where("id = ?", serverID).Update("status", status).Error
}

// Metric operations
func (d *Database) CreateMetric(metric *models.Metric) error {
	return d.DB.Create(metric).Error
}

func (d *Database) GetServerMetrics(serverID uint, since time.Time) ([]models.Metric, error) {
	var metrics []models.Metric
	err := d.DB.Where("server_id = ? AND time >= ?", serverID, since).
		Order("time DESC").
		Find(&metrics).Error
	return metrics, err
}

func (d *Database) GetLatestMetrics(serverID uint) (*models.Metric, error) {
	var metric models.Metric
	err := d.DB.Where("server_id = ?", serverID).
		Order("time DESC").
		First(&metric).Error
	if err != nil {
		return nil, err
	}
	return &metric, nil
}

// Alert operations
func (d *Database) CreateAlert(alert *models.Alert) error {
	return d.DB.Create(alert).Error
}

func (d *Database) GetServerAlerts(serverID uint, limit int) ([]models.Alert, error) {
	var alerts []models.Alert
	query := d.DB.Where("server_id = ?", serverID).Order("created_at DESC")
	if limit > 0 {
		query = query.Limit(limit)
	}
	err := query.Find(&alerts).Error
	return alerts, err
}

func (d *Database) GetUnresolvedAlerts(serverID uint) ([]models.Alert, error) {
	var alerts []models.Alert
	err := d.DB.Where("server_id = ? AND resolved = false", serverID).
		Order("created_at DESC").
		Find(&alerts).Error
	return alerts, err
}

func (d *Database) ResolveAlert(alertID uint) error {
	return d.DB.Model(&models.Alert{}).Where("id = ?", alertID).Update("resolved", true).Error
}
