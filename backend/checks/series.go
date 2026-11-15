package checks

import (
	"context"
	"time"
)

type rangeSpec struct {
	step  time.Duration
	steps int
}

var ranges = map[Range]rangeSpec{
	Range24h: {step: 15 * time.Minute, steps: 96},
	Range7d:  {step: time.Hour, steps: 168},
	Range30d: {step: 2 * time.Hour, steps: 360},
}

// Results returns a check's history for a range, oldest first. 24h comes
// from memory (flushed hours from before a restart fill the gap); 7d and 30d
// read hourly rollups once per flush window (cached) plus unflushed deltas.
func (s *Scheduler) Results(ctx context.Context, checkID int64, rng Range) (Series, error) {
	spec, ok := ranges[rng]
	if !ok {
		return Series{}, ErrNotFound
	}
	now := s.now()
	end := now.Truncate(spec.step).Add(spec.step)
	from := end.Add(-time.Duration(spec.steps) * spec.step)
	buckets := make([]agg, spec.steps)
	index := func(t time.Time) int {
		if t.Before(from) || !t.Before(end) {
			return -1
		}
		return int(t.Sub(from) / spec.step)
	}

	if rng == Range24h {
		s.mu.Lock()
		defer s.mu.Unlock()
		st, ok := s.states[checkID]
		if !ok {
			return Series{}, ErrNotFound
		}
		for _, smp := range st.samples {
			if i := index(time.UnixMilli(smp.at)); i >= 0 {
				a := agg{total: 1}
				if smp.ok {
					ms := float64(smp.latencyMS)
					a.ok, a.latSumMS, a.latMaxMS = 1, ms, ms
				}
				buckets[i].add(a)
			}
		}
		// Steps before memory coverage take their hour's flushed totals.
		for _, h := range st.seeded {
			for t := h.Start; t.Before(h.Start.Add(time.Hour)) && t.Before(st.since); t = t.Add(spec.step) {
				if i := index(t); i >= 0 && buckets[i].total == 0 {
					buckets[i] = aggOfHour(h)
				}
			}
		}
		return seriesOf(rng, spec, from, buckets), nil
	}

	s.mu.Lock()
	_, known := s.states[checkID]
	s.mu.Unlock()
	if !known {
		return Series{}, ErrNotFound
	}
	rows, err := s.history(ctx, checkID, rng, from, end)
	if err != nil {
		return Series{}, err
	}
	for _, h := range rows {
		if i := index(h.Start); i >= 0 {
			buckets[i].add(aggOfHour(h))
		}
	}
	s.mu.Lock()
	for k, a := range s.hours {
		if k.checkID != checkID {
			continue
		}
		if i := index(k.start); i >= 0 {
			buckets[i].add(*a)
		}
	}
	s.mu.Unlock()
	return seriesOf(rng, spec, from, buckets), nil
}

// history reads flushed hours, cached until the next flush changes them. A
// read that raced a flush is returned but not cached.
func (s *Scheduler) history(ctx context.Context, checkID int64, rng Range, from, to time.Time) ([]HourRollup, error) {
	key := cacheKey{checkID, rng}
	s.cacheMu.Lock()
	rows, ok := s.cache[key]
	gen := s.cacheGen
	s.cacheMu.Unlock()
	if ok {
		return rows, nil
	}
	rows, err := s.store.ReadHours(ctx, checkID, from, to)
	if err != nil {
		return nil, err
	}
	s.cacheMu.Lock()
	if s.cacheGen == gen {
		s.cache[key] = rows
	}
	s.cacheMu.Unlock()
	return rows, nil
}

func aggOfHour(h HourRollup) agg {
	return agg{total: h.Total, ok: h.OK, latSumMS: float64(h.LatencyAvgMS) * float64(h.OK), latMaxMS: float64(h.LatencyMaxMS)}
}

func seriesOf(rng Range, spec rangeSpec, from time.Time, buckets []agg) Series {
	points := make([]Point, len(buckets))
	for i, b := range buckets {
		p := Point{T: from.Add(time.Duration(i) * spec.step).UTC()}
		if b.total > 0 {
			up := float64(b.ok) * percent / float64(b.total)
			p.UpPct = &up
		}
		if b.ok > 0 {
			avg, mx := b.latSumMS/float64(b.ok), b.latMaxMS
			p.LatencyAvg, p.LatencyMax = &avg, &mx
		}
		points[i] = p
	}
	return Series{Range: rng, StepSeconds: int(spec.step / time.Second), Points: points}
}
