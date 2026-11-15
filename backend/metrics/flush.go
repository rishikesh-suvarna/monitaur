package metrics

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"time"
)

const (
	tickInterval         = time.Second
	flushBatchSize       = 1000
	shutdownFlushTimeout = 20 * time.Second
)

// Run closes buckets every second, flushes every FlushInterval, and on
// ctx.Done closes every open minute and hour (partial buckets included) and
// does a final flush with a fresh 20 s context. It returns the final flush
// error, so nil means a clean shutdown lost nothing.
func (s *Store) Run(ctx context.Context) error {
	tick := time.NewTicker(tickInterval)
	defer tick.Stop()
	flushTick := time.NewTicker(s.cfg.FlushInterval)
	defer flushTick.Stop()

	// Periodic flushes run beside the tick loop: a flush can take seconds
	// while Neon wakes up, and bucket closing must not stall behind it.
	var wg sync.WaitGroup
	inFlight := make(chan struct{}, 1)
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return s.shutdown()
		case <-tick.C:
			s.tick()
		case <-flushTick.C:
			select {
			case inFlight <- struct{}{}:
				wg.Add(1)
				go func() {
					defer wg.Done()
					defer func() { <-inFlight }()
					// Flush logs and records its own error; the next interval retries.
					_ = s.Flush(ctx)
				}()
			default:
				s.log.Warn("metrics flush still running; skipping this interval")
			}
		}
	}
}

func (s *Store) shutdown() error {
	s.closeEverything()
	ctx, cancel := context.WithTimeout(context.Background(), shutdownFlushTimeout)
	defer cancel()
	err := s.Flush(ctx)
	if s.journal != nil {
		s.journal.close()
	}
	if err != nil {
		return fmt.Errorf("metrics: final flush: %w", err)
	}
	return nil
}

// Flush writes every pending bucket to the Sink in batches. On error the
// unwritten remainder goes back to the front of the queue (order kept) for
// the next attempt. Hooks run after every attempt, even an empty one.
func (s *Store) Flush(ctx context.Context) error {
	select {
	case s.flushSem <- struct{}{}:
	case <-ctx.Done():
		return fmt.Errorf("metrics: wait for running flush: %w", ctx.Err())
	}
	defer func() { <-s.flushSem }()

	s.qmu.Lock()
	var rotated []string
	if s.journal != nil {
		rotated = s.journal.rotate()
	}
	batch := s.pending
	s.pending = nil
	s.flushing = true
	newlyDropped := s.dropped - s.droppedLogged
	s.droppedLogged = s.dropped
	s.qmu.Unlock()

	if newlyDropped > 0 {
		s.log.Warn("metrics pending queue over cap; dropped oldest buckets",
			"dropped", newlyDropped, "cap", s.cfg.MaxPendingBuckets)
	}

	written, err := s.writeBatches(ctx, batch)

	s.qmu.Lock()
	if err != nil {
		rest := batch[written:]
		if len(s.flushForgotten) > 0 {
			rest = slices.DeleteFunc(rest, func(b Bucket) bool {
				_, gone := s.flushForgotten[b.ServerID]
				return gone
			})
		}
		s.pending = slices.Concat(rest, s.pending)
		s.enforceCapLocked()
		s.lastFlushErr = err.Error()
	} else {
		s.lastFlush = s.now()
		s.lastFlushErr = ""
		s.flushes++
	}
	s.flushing = false
	s.flushForgotten = nil
	pendingNow := len(s.pending)
	s.qmu.Unlock()

	if err != nil {
		s.log.Warn("metrics flush failed; will retry next interval",
			"err", err, "written", written, "pending", pendingNow)
	} else {
		if s.journal != nil {
			s.journal.removeRotated(rotated)
		}
		// DB rollups only change at flush time, so cached History is now stale.
		s.cache.invalidate()
		s.log.Debug("metrics flushed", "buckets", written)
	}

	s.runHooks(ctx)
	if err != nil {
		return fmt.Errorf("metrics: flush: %w", err)
	}
	return nil
}

func (s *Store) writeBatches(ctx context.Context, batch []Bucket) (int, error) {
	for i := 0; i < len(batch); i += flushBatchSize {
		if err := ctx.Err(); err != nil {
			return i, err
		}
		end := min(i+flushBatchSize, len(batch))
		if err := s.sink.WriteBuckets(ctx, batch[i:end]); err != nil {
			return i, fmt.Errorf("write buckets %d-%d of %d: %w", i, end, len(batch), err)
		}
	}
	return len(batch), nil
}

func (s *Store) runHooks(ctx context.Context) {
	s.hooksMu.Lock()
	hooks := slices.Clone(s.hooks)
	s.hooksMu.Unlock()
	for _, fn := range hooks {
		fn(ctx)
	}
}
