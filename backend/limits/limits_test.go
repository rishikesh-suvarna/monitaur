package limits

import (
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func TestRateLimiter(t *testing.T) {
	c := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	r := NewRateLimiter(c.now)

	tests := []struct {
		name      string
		advance   time.Duration
		wantAllow bool
	}{
		{"burst 1", 0, true},
		{"burst 2", 0, true},
		{"burst exhausted", 0, false},
		{"half a token after 0.5s at 60/min", 500 * time.Millisecond, false},
		{"one token after 1s", 500 * time.Millisecond, true},
		{"empty again", 0, false},
	}
	for _, tt := range tests {
		c.t = c.t.Add(tt.advance)
		if got := r.Allow("user:1", 60, 2); got != tt.wantAllow {
			t.Fatalf("%s: Allow = %v, want %v", tt.name, got, tt.wantAllow)
		}
	}
	if !r.Allow("user:2", 60, 2) {
		t.Fatal("keys must be independent")
	}
	if !r.Allow("anything", 0, 0) {
		t.Fatal("perMinute 0 means unlimited")
	}
	c.t = c.t.Add(sweepIdleAfter + time.Second)
	r.Sweep()
	if len(r.buckets) != 0 {
		t.Fatalf("sweep left %d buckets", len(r.buckets))
	}
}

func TestEmailBudget(t *testing.T) {
	limits := map[int64]int{1: 2, 2: 0}
	b := NewEmailBudget(func(org int64) int { return limits[org] })
	day1 := time.Date(2026, 1, 1, 23, 0, 0, 0, time.UTC)

	for i, want := range []bool{true, true, false, false} {
		if got := b.AllowEmail(1, day1); got != want {
			t.Fatalf("send %d: %v, want %v", i, got, want)
		}
	}
	if b.SentToday(1, day1) != 2 {
		t.Fatalf("SentToday = %d", b.SentToday(1, day1))
	}
	if !b.AllowEmail(1, day1.Add(2*time.Hour)) {
		t.Fatal("budget must reset at UTC midnight")
	}
	for range 100 {
		if !b.AllowEmail(2, day1) {
			t.Fatal("limit 0 means unlimited")
		}
	}
}
