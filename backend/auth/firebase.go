package auth

import (
	"context"
	"fmt"
	"strings"

	"backend/config"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/auth"
	"github.com/gin-gonic/gin"
	"google.golang.org/api/option"
)

type FirebaseAuth struct {
	client *auth.Client
}

type UserClaims struct {
	UID   string `json:"uid"`
	Email string `json:"email"`
}

func NewFirebaseAuth(cfg *config.FirebaseConfig) (*FirebaseAuth, error) {
	ctx := context.Background()

	var app *firebase.App
	var err error

	if cfg.ServiceAccountPath != "" {
		// Use service account file
		opt := option.WithCredentialsFile(cfg.ServiceAccountPath)
		app, err = firebase.NewApp(ctx, &firebase.Config{
			ProjectID: cfg.ProjectID,
		}, opt)
	} else {
		// Use default credentials (for production)
		app, err = firebase.NewApp(ctx, &firebase.Config{
			ProjectID: cfg.ProjectID,
		})
	}

	if err != nil {
		return nil, fmt.Errorf("failed to initialize Firebase app: %w", err)
	}

	client, err := app.Auth(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize Firebase Auth client: %w", err)
	}

	return &FirebaseAuth{client: client}, nil
}

// VerifyIDToken verifies a Firebase ID token and returns user claims
func (f *FirebaseAuth) VerifyIDToken(ctx context.Context, idToken string) (*UserClaims, error) {
	token, err := f.client.VerifyIDToken(ctx, idToken)
	if err != nil {
		return nil, fmt.Errorf("failed to verify ID token: %w", err)
	}

	claims := &UserClaims{
		UID:   token.UID,
		Email: token.Claims["email"].(string),
	}

	return claims, nil
}

// AuthMiddleware is a Gin middleware that verifies Firebase tokens
func (f *FirebaseAuth) AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Get token from Authorization header
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			c.JSON(401, gin.H{"error": "Authorization header required"})
			c.Abort()
			return
		}

		// Extract token from "Bearer <token>"
		tokenParts := strings.Split(authHeader, " ")
		if len(tokenParts) != 2 || tokenParts[0] != "Bearer" {
			c.JSON(401, gin.H{"error": "Invalid authorization header format"})
			c.Abort()
			return
		}

		idToken := tokenParts[1]

		// Verify token
		claims, err := f.VerifyIDToken(c.Request.Context(), idToken)
		if err != nil {
			c.JSON(401, gin.H{"error": "Invalid token", "details": err.Error()})
			c.Abort()
			return
		}

		// Set user info in context
		c.Set("user_uid", claims.UID)
		c.Set("user_email", claims.Email)
		c.Next()
	}
}

// OptionalAuthMiddleware is similar to AuthMiddleware but doesn't require auth
func (f *FirebaseAuth) OptionalAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			c.Next()
			return
		}

		tokenParts := strings.Split(authHeader, " ")
		if len(tokenParts) != 2 || tokenParts[0] != "Bearer" {
			c.Next()
			return
		}

		idToken := tokenParts[1]
		claims, err := f.VerifyIDToken(c.Request.Context(), idToken)
		if err != nil {
			c.Next()
			return
		}

		c.Set("user_uid", claims.UID)
		c.Set("user_email", claims.Email)
		c.Next()
	}
}

// GetUserFromContext extracts user info from Gin context
func GetUserFromContext(c *gin.Context) (*UserClaims, bool) {
	uid, exists := c.Get("user_uid")
	if !exists {
		return nil, false
	}

	email, exists := c.Get("user_email")
	if !exists {
		return nil, false
	}

	return &UserClaims{
		UID:   uid.(string),
		Email: email.(string),
	}, true
}

// CreateCustomToken creates a custom token for a user (useful for testing)
func (f *FirebaseAuth) CreateCustomToken(ctx context.Context, uid string) (string, error) {
	token, err := f.client.CustomToken(ctx, uid)
	if err != nil {
		return "", fmt.Errorf("failed to create custom token: %w", err)
	}
	return token, nil
}

// GetUser retrieves user information by UID
func (f *FirebaseAuth) GetUser(ctx context.Context, uid string) (*auth.UserRecord, error) {
	user, err := f.client.GetUser(ctx, uid)
	if err != nil {
		return nil, fmt.Errorf("failed to get user: %w", err)
	}
	return user, nil
}

// DeleteUser deletes a user account
func (f *FirebaseAuth) DeleteUser(ctx context.Context, uid string) error {
	err := f.client.DeleteUser(ctx, uid)
	if err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
	}
	return nil
}
