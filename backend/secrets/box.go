// Package secrets encrypts small values at rest (notification channel configs
// hold webhook URLs and bot tokens that act as credentials).
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
)

const keySize = 32

var ErrCiphertext = errors.New("ciphertext too short or corrupted")

// Box seals values with AES-256-GCM. The nonce is prepended to the ciphertext.
type Box struct {
	aead cipher.AEAD
}

func NewBox(key []byte) (*Box, error) {
	if len(key) != keySize {
		return nil, fmt.Errorf("key must be %d bytes, got %d", keySize, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

func (b *Box) Seal(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return b.aead.Seal(nonce, nonce, plaintext, nil), nil
}

func (b *Box) Open(sealed []byte) ([]byte, error) {
	n := b.aead.NonceSize()
	if len(sealed) < n {
		return nil, ErrCiphertext
	}
	out, err := b.aead.Open(nil, sealed[:n], sealed[n:], nil)
	if err != nil {
		return nil, ErrCiphertext
	}
	return out, nil
}

// HashToken is how agent tokens and invite tokens are stored and looked up.
// Tokens are 32 random bytes, so an unsalted SHA-256 is not brute-forceable.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

const (
	agentTokenPrefix  = "mt_live_"
	inviteTokenPrefix = "mt_inv_"
	tokenRandomBytes  = 32
	// DisplayPrefixLen is how much of a token the UI may show after creation.
	DisplayPrefixLen = len(agentTokenPrefix) + 4
)

// NewAgentToken returns a token like "mt_live_<64 hex>". The prefix lets
// secret scanners recognise leaked tokens.
func NewAgentToken() (string, error) { return newToken(agentTokenPrefix) }

func NewInviteToken() (string, error) { return newToken(inviteTokenPrefix) }

func newToken(prefix string) (string, error) {
	buf := make([]byte, tokenRandomBytes)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(buf), nil
}

// DisplayPrefix is the part of a token that is safe to keep and show.
func DisplayPrefix(token string) string {
	if len(token) <= DisplayPrefixLen {
		return token
	}
	return token[:DisplayPrefixLen]
}
