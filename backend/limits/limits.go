// Package limits enforces per-tenant rate limits and daily budgets in memory,
// so enforcing them never costs a database round trip.
package limits

import (
	"sync"
	"time"
)

const sweepIdleAfter = 10 * time.Minute

// RateLimiter is a token bucket per key (user, IP, agent token).
type RateLimiter struct {
	mu      sync.Mutex
	now     func() time.Time
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

func NewRateLimiter(now func() time.Time) *RateLimiter {
	if now == nil {
		now = time.Now
	}
	return &RateLimiter{now: now, buckets: map[string]*bucket{}}
}

// Allow spends one token from key's bucket, refilled at perMinute with the
// given burst capacity. perMinute <= 0 means unlimited.
func (r *RateLimiter) Allow(key string, perMinute, burst int) bool {
	if perMinute <= 0 {
		return true
	}
	if burst <= 0 {
		burst = 1
	}
	now := r.now()
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.buckets[key]
	if !ok {
		b = &bucket{tokens: float64(burst), last: now}
		r.buckets[key] = b
	}
	elapsed := now.Sub(b.last).Minutes()
	b.tokens = min(float64(burst), b.tokens+elapsed*float64(perMinute))
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Sweep drops idle buckets so memory stays bounded under key churn.
func (r *RateLimiter) Sweep() {
	cutoff := r.now().Add(-sweepIdleAfter)
	r.mu.Lock()
	defer r.mu.Unlock()
	for k, b := range r.buckets {
		if b.last.Before(cutoff) {
			delete(r.buckets, k)
		}
	}
}

// EmailBudget implements notify.Limits: alert emails per org per UTC day.
// Counts reset on restart, which errs on the side of delivering alerts.
type EmailBudget struct {
	mu       sync.Mutex
	limitFor func(orgID int64) int
	counts   map[int64]dayCount
}

type dayCount struct {
	day   string
	count int
}

func NewEmailBudget(limitFor func(orgID int64) int) *EmailBudget {
	return &EmailBudget{limitFor: limitFor, counts: map[int64]dayCount{}}
}

func (e *EmailBudget) AllowEmail(orgID int64, now time.Time) bool {
	limit := e.limitFor(orgID)
	day := now.UTC().Format(time.DateOnly)
	e.mu.Lock()
	defer e.mu.Unlock()
	c := e.counts[orgID]
	if c.day != day {
		c = dayCount{day: day}
	}
	if limit > 0 && c.count >= limit {
		e.counts[orgID] = c
		return false
	}
	c.count++
	e.counts[orgID] = c
	return true
}

func (e *EmailBudget) SentToday(orgID int64, now time.Time) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	if c := e.counts[orgID]; c.day == now.UTC().Format(time.DateOnly) {
		return c.count
	}
	return 0
}
