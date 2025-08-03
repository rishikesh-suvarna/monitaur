package main

import (
	"flag"
	"log"
	"net/http"

	"backend/auth"
	"backend/config"
	"backend/database"
	"backend/handlers"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

func main() {
	var (
		createConfig = flag.Bool("init", false, "Create sample config.yaml file")
		migrate      = flag.Bool("migrate", false, "Run database migrations")
	)
	flag.Parse()

	// Create sample config if requested
	if *createConfig {
		if err := config.CreateSampleConfig(); err != nil {
			log.Fatalf("Failed to create config: %v", err)
		}
		log.Println("Sample config.yaml created. Please edit it with your settings.")
		return
	}

	// Load configuration
	cfg, err := config.LoadConfig()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Initialize database
	db, err := database.NewDatabase(&cfg.Database)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}

	// Run migrations if requested
	if *migrate {
		if err := db.AutoMigrate(); err != nil {
			log.Fatalf("Failed to run migrations: %v", err)
		}
		log.Println("Database migrations completed successfully")
		return
	}

	// Initialize Firebase Auth
	firebaseAuth, err := auth.NewFirebaseAuth(&cfg.Firebase)
	if err != nil {
		log.Fatalf("Failed to initialize Firebase Auth: %v", err)
	}

	// Initialize handlers
	wsHandler := handlers.NewWebSocketHandler(db)
	apiHandler := handlers.NewAPIHandler(db, firebaseAuth, wsHandler)
	dashboardHandler := handlers.NewDashboardHandler(db, wsHandler)

	// Initialize Gin router
	if gin.Mode() == gin.ReleaseMode {
		gin.SetMode(gin.ReleaseMode)
	}
	router := gin.Default()

	// CORS middleware
	corsConfig := cors.DefaultConfig()
	corsConfig.AllowOrigins = []string{cfg.Server.AllowOrigins}
	corsConfig.AllowHeaders = []string{"Origin", "Content-Length", "Content-Type", "Authorization"}
	corsConfig.AllowMethods = []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"}
	router.Use(cors.New(corsConfig))

	// Health check endpoint
	router.GET("/health", apiHandler.HealthCheck)

	// Agent WebSocket endpoint (no auth required, uses token authentication)
	router.GET("/agent/connect", wsHandler.HandleAgentConnection)

	// API routes (require Firebase authentication)
	api := router.Group("/api/v1")
	api.Use(firebaseAuth.AuthMiddleware())
	{
		// User routes
		api.GET("/profile", apiHandler.GetUserProfile)

		// Server management routes
		api.GET("/servers", apiHandler.GetUserServers)
		api.POST("/servers", apiHandler.CreateServer)
		api.DELETE("/servers/:id", apiHandler.DeleteServer)

		// Metrics routes
		api.GET("/servers/:id/metrics", apiHandler.GetServerMetrics)

		// Alert routes
		api.GET("/servers/:id/alerts", apiHandler.GetServerAlerts)
		api.PUT("/alerts/:id/resolve", apiHandler.ResolveAlert)

		// Dashboard routes
		api.GET("/dashboard", dashboardHandler.GetDashboardData)
		api.GET("/servers/:id/dashboard", dashboardHandler.GetServerDashboard)
		api.GET("/servers/:id/chart", dashboardHandler.GetMetricsChart)
	}

	// Start server
	serverAddr := cfg.Server.Host + ":" + cfg.Server.Port
	log.Printf("Starting server on %s", serverAddr)

	srv := &http.Server{
		Addr:    serverAddr,
		Handler: router,
	}

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Failed to start server: %v", err)
	}
}
