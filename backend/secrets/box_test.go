package secrets

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func testKey() []byte { return bytes.Repeat([]byte{7}, keySize) }

func TestBoxRoundTripAndTamper(t *testing.T) {
	box, err := NewBox(testKey())
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := box.Seal([]byte(`{"webhook_url":"https://hooks.slack.com/x"}`))
	if err != nil {
		t.Fatal(err)
	}
	got, err := box.Open(sealed)
	if err != nil || !strings.Contains(string(got), "hooks.slack.com") {
		t.Fatalf("Open = %q, %v", got, err)
	}

	tests := []struct {
		name   string
		mutate func([]byte) []byte
	}{
		{"flipped byte", func(b []byte) []byte { c := bytes.Clone(b); c[len(c)-1] ^= 1; return c }},
		{"truncated", func(b []byte) []byte { return b[:5] }},
		{"empty", func([]byte) []byte { return nil }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := box.Open(tt.mutate(sealed)); !errors.Is(err, ErrCiphertext) {
				t.Fatalf("Open(tampered) error = %v, want ErrCiphertext", err)
			}
		})
	}
}

func TestNewBoxRejectsWrongKeySize(t *testing.T) {
	for _, n := range []int{0, 16, 31, 33} {
		if _, err := NewBox(make([]byte, n)); err == nil {
			t.Fatalf("NewBox(%d bytes) succeeded", n)
		}
	}
}

func TestTokens(t *testing.T) {
	a, err := NewAgentToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := NewAgentToken()
	if a == b || !strings.HasPrefix(a, agentTokenPrefix) || len(a) != len(agentTokenPrefix)+2*tokenRandomBytes {
		t.Fatalf("unexpected tokens %q %q", a, b)
	}
	if got := DisplayPrefix(a); got != a[:DisplayPrefixLen] {
		t.Fatalf("DisplayPrefix = %q", got)
	}
	// Matching the SQL migration's sha256() is asserted in the store
	// integration test against a real migrated database.
	if h := HashToken("11111111-1111-1111-1111-111111111111"); len(h) != 64 {
		t.Fatalf("hash length = %d", len(h))
	}
}
