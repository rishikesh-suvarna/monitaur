package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/appcheck"
	fbauth "firebase.google.com/go/v4/auth"
	"google.golang.org/api/option"

	"backend/config"
)

const millisPerSecond = 1000

// FirebaseVerifier implements Verifier with the Admin SDK.
type FirebaseVerifier struct {
	auth     *fbauth.Client
	appCheck *appcheck.Client
}

func NewFirebaseVerifier(ctx context.Context, cfg config.FirebaseConfig) (*FirebaseVerifier, error) {
	var opts []option.ClientOption
	if cfg.ServiceAccountPath != "" {
		opts = append(opts, option.WithCredentialsFile(cfg.ServiceAccountPath))
	}
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: cfg.ProjectID}, opts...)
	if err != nil {
		return nil, fmt.Errorf("init firebase app: %w", err)
	}
	client, err := app.Auth(ctx)
	if err != nil {
		return nil, fmt.Errorf("init firebase auth: %w", err)
	}
	v := &FirebaseVerifier{auth: client}
	if cfg.RequireAppCheck {
		if v.appCheck, err = app.AppCheck(ctx); err != nil {
			return nil, fmt.Errorf("init app check: %w", err)
		}
	}
	return v, nil
}

func (f *FirebaseVerifier) VerifyIDToken(ctx context.Context, token string) (Claims, error) {
	t, err := f.auth.VerifyIDToken(ctx, token)
	if err != nil {
		return Claims{}, err
	}
	email, _ := t.Claims["email"].(string) // phone/anonymous accounts have none
	name, _ := t.Claims["name"].(string)
	verified, _ := t.Claims["email_verified"].(bool)
	return Claims{
		UID:           t.UID,
		Email:         email,
		Name:          name,
		Provider:      t.Firebase.SignInProvider,
		EmailVerified: verified,
		IssuedAt:      time.Unix(t.IssuedAt, 0),
	}, nil
}

func (f *FirebaseVerifier) TokensValidAfter(ctx context.Context, uid string) (time.Time, error) {
	u, err := f.auth.GetUser(ctx, uid)
	if err != nil {
		return time.Time{}, err
	}
	return time.Unix(u.TokensValidAfterMillis/millisPerSecond, 0), nil
}

func (f *FirebaseVerifier) RevokeSessions(ctx context.Context, uid string) error {
	return f.auth.RevokeRefreshTokens(ctx, uid)
}

func (f *FirebaseVerifier) DeleteUser(ctx context.Context, uid string) error {
	err := f.auth.DeleteUser(ctx, uid)
	if fbauth.IsUserNotFound(err) {
		return nil
	}
	return err
}

func (f *FirebaseVerifier) VerifyAppCheck(token string) error {
	if f.appCheck == nil {
		return errors.New("app check not configured")
	}
	if token == "" {
		return errors.New("missing app check token")
	}
	_, err := f.appCheck.VerifyToken(token)
	return err
}
