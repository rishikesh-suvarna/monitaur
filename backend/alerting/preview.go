package alerting

import (
	"slices"
	"time"

	"backend/metrics"
)

// fallbackBucketSpan is the width assumed for a bucket without a resolution;
// Preview is fed minute buckets.
const fallbackBucketSpan = time.Minute

// PreviewIncident is an incident a rule would have produced. End is zero
// when it would still be open after the last bucket.
type PreviewIncident struct {
	Start, End time.Time
	Peak       float64
}

// Preview replays minute buckets (oldest first) through the rule's state
// machine and returns the incidents it would have opened. It is pure: no
// store, no clock. Threshold rules use the bucket average of their metric.
// Heartbeat rules count a gap of at least For between consecutive buckets
// as one incident; a gap after the last bucket is not reported.
func Preview(r Rule, buckets []metrics.Bucket) []PreviewIncident {
	if len(buckets) == 0 {
		return nil
	}
	bs := buckets
	byStart := func(a, b metrics.Bucket) int { return a.Start.Compare(b.Start) }
	if !slices.IsSortedFunc(bs, byStart) {
		bs = slices.Clone(bs)
		slices.SortStableFunc(bs, byStart)
	}
	if r.Metric == MetricHeartbeat {
		return previewHeartbeat(r, bs)
	}
	return previewThreshold(r, bs)
}

func previewThreshold(r Rule, bs []metrics.Bucket) []PreviewIncident {
	var (
		out []PreviewIncident
		t   tracker
		cur = -1 // index in out of the incident still open
	)
	closeAt := func(end time.Time) {
		out[cur].End, out[cur].Peak = end, t.peak
		cur, t = -1, tracker{}
	}
	for _, b := range bs {
		v, ok := r.bucketValue(b)
		if !ok {
			continue
		}
		start := b.Start
		// The engine's Tick resolves a recovering incident even when no
		// samples arrive; replay that across a gap between buckets.
		if cur >= 0 && t.recovered(r, start) {
			closeAt(t.since.Add(r.AutoResolve))
		}
		switch t.observe(r, v, start, bucketEnd(b)) {
		case fire:
			// The breach held for For at since+For; after a gap in the data
			// the engine would only notice at the next sample.
			out = append(out, PreviewIncident{Start: later(t.since.Add(r.For), start)})
			cur = len(out) - 1
		case resolve:
			if cur >= 0 {
				closeAt(t.since.Add(r.AutoResolve))
			}
		}
		if cur >= 0 {
			out[cur].Peak = t.peak
		}
	}
	return out
}

func previewHeartbeat(r Rule, bs []metrics.Bucket) []PreviewIncident {
	var out []PreviewIncident
	for i := 1; i < len(bs); i++ {
		lastSeen := bucketEnd(bs[i-1])
		back := bs[i].Start
		gap := back.Sub(lastSeen)
		if gap <= 0 || gap < r.For {
			continue
		}
		out = append(out, PreviewIncident{Start: lastSeen.Add(r.For), End: back, Peak: gap.Seconds()})
	}
	return out
}

func bucketEnd(b metrics.Bucket) time.Time {
	span := b.Res.Duration()
	if span <= 0 {
		span = fallbackBucketSpan
	}
	return b.Start.Add(span)
}

func later(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
