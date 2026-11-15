package metrics

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type source int

const (
	sourceRaw source = iota + 1
	sourceMinute
	sourceHour
)

const (
	liveWindow = 15 * time.Minute
	liveStep   = 5 * time.Second
	step1h     = 10 * time.Second
	step6h     = time.Minute
	step24h    = 4 * time.Minute
	step7d     = time.Hour
	step30d    = 2 * time.Hour
	day        = 24 * time.Hour
)

type rangeSpec struct {
	window time.Duration
	step   time.Duration
	source source
}

// rangeSpecs keeps every range at or under 360 points (PLAN.md 2.3.3).
var rangeSpecs = map[Range]rangeSpec{
	RangeLive: {window: liveWindow, step: liveStep, source: sourceRaw},
	Range1h:   {window: time.Hour, step: step1h, source: sourceRaw},
	Range6h:   {window: 6 * time.Hour, step: step6h, source: sourceMinute},
	Range24h:  {window: day, step: step24h, source: sourceMinute},
	Range7d:   {window: 7 * day, step: step7d, source: sourceHour},
	Range30d:  {window: 30 * day, step: step30d, source: sourceHour},
}

// grid is the fixed step layout of one Series. Steps are aligned to the
// Unix epoch; the last step is the one containing now (partial).
type grid struct {
	first int64 // unix nanos of the first step start
	step  int64
	n     int
}

func newGrid(now time.Time, spec rangeSpec) grid {
	step := int64(spec.step)
	last := floorDiv(now.UnixNano(), step) * step
	n := int(spec.window / spec.step)
	return grid{first: last - int64(n-1)*step, step: step, n: n}
}

func (g grid) end() int64 { return g.first + int64(g.n)*g.step }

func (g grid) index(t int64) (int, bool) {
	if t < g.first || t >= g.end() {
		return 0, false
	}
	return int((t - g.first) / g.step), true
}

// Series returns every metric for one range in fixed steps; a step without
// data has nil fields. Sources:
//   - live, 1h: the raw ring, averaged per step.
//   - 6h, 24h: closed minute buckets plus the open minute, sample weighted.
//     Minutes from before this process started (memFrom) come from History
//     once, cached until the next successful flush.
//   - 7d, 30d: History hour buckets (cached the same way) merged with the
//     hours still in memory: closed but maybe unflushed hours, the open hour
//     and the open minute, so the newest hours never lag behind the flush.
//
// A History error is returned rather than silently serving partial data.
func (s *Store) Series(ctx context.Context, serverID int64, r Range) (Series, error) {
	spec, ok := rangeSpecs[r]
	if !ok {
		return Series{}, fmt.Errorf("%w: %q", ErrUnknownRange, r)
	}
	now := s.now()
	g := newGrid(now, spec)
	accs := make([]stepAcc, g.n)

	var err error
	switch spec.source {
	case sourceRaw:
		s.accumulateRaw(serverID, now, g, accs)
	case sourceMinute:
		err = s.accumulateMinutes(ctx, serverID, r, g, accs)
	case sourceHour:
		err = s.accumulateHours(ctx, serverID, r, g, accs)
	}
	if err != nil {
		return Series{}, err
	}
	return buildSeries(r, spec, g, accs), nil
}

func (s *Store) accumulateRaw(serverID int64, now time.Time, g grid, accs []stepAcc) {
	st := s.lookup(serverID)
	if st == nil {
		return
	}
	lo := max(g.first, now.UnixNano()-int64(s.cfg.RawWindow))
	st.mu.Lock()
	defer st.mu.Unlock()
	for i := st.raw.size() - 1; i >= 0; i-- {
		p, x := st.raw.at(i)
		if p.t < lo {
			break
		}
		if idx, ok := g.index(p.t); ok {
			accs[idx].addPoint(p, x)
		}
	}
}

func (s *Store) accumulateMinutes(ctx context.Context, serverID int64, r Range, g grid, accs []stepAcc) error {
	st := s.lookup(serverID)
	memFrom := s.startMinute + 1
	if st != nil {
		st.mu.Lock()
		memFrom = st.memFrom
		st.mu.Unlock()
	}

	var hist map[mins]fbucket
	if s.history != nil && g.first < memFrom.nanos() {
		from, to := time.Unix(0, g.first).UTC(), memFrom.time()
		bs, err := s.historyBuckets(ctx, cacheKey{server: serverID, r: r}, Minute, from, to, true)
		if err != nil {
			return err
		}
		hist = indexBuckets(bs, g.first, memFrom.nanos())
	}

	if st != nil {
		st.mu.Lock()
		for i := st.recent.size() - 1; i >= 0; i-- {
			b := bucketAt(&st.recent, i)
			if b.start.nanos() < g.first {
				break
			}
			addMerged(accs, g, b, hist)
		}
		if st.minute.open {
			addMerged(accs, g, st.minute.bucket(), hist)
		}
		st.mu.Unlock()
	}
	for _, b := range hist {
		addBucket(accs, g, b)
	}
	return nil
}

func (s *Store) accumulateHours(ctx context.Context, serverID int64, r Range, g grid, accs []stepAcc) error {
	var hist map[mins]fbucket
	if s.history != nil {
		from, to := time.Unix(0, g.first).UTC(), time.Unix(0, g.end()).UTC()
		// Hours closed after this fetch stay in memory until a flush, and a
		// flush clears the cache, so the cached copy never needs extending.
		bs, err := s.historyBuckets(ctx, cacheKey{server: serverID, r: r}, Hour, from, to, false)
		if err != nil {
			return err
		}
		hist = indexBuckets(bs, g.first, g.end())
	}

	if st := s.lookup(serverID); st != nil {
		st.mu.Lock()
		for i := st.hours.size() - 1; i >= 0; i-- {
			b := bucketAt(&st.hours, i)
			if b.start.nanos() < g.first {
				break
			}
			addMerged(accs, g, b, hist)
		}
		if st.hour.open {
			addMerged(accs, g, st.hour.bucket(), hist)
		}
		// The open minute is not in the hour aggregate yet.
		if st.minute.open {
			addBucket(accs, g, st.minute.bucket())
		}
		st.mu.Unlock()
	}
	for _, b := range hist {
		addBucket(accs, g, b)
	}
	return nil
}

func indexBuckets(bs []fbucket, from, to int64) map[mins]fbucket {
	out := make(map[mins]fbucket, len(bs))
	for _, b := range bs {
		if n := b.start.nanos(); n >= from && n < to {
			out[b.start] = fuller(out[b.start], b)
		}
	}
	return out
}

// addMerged adds a memory bucket, resolving a collision with the History
// copy of the same period. The History entry is consumed either way.
func addMerged(accs []stepAcc, g grid, b fbucket, hist map[mins]fbucket) {
	if h, ok := hist[b.start]; ok {
		delete(hist, b.start)
		b = fuller(b, h)
	}
	addBucket(accs, g, b)
}

func addBucket(accs []stepAcc, g grid, b fbucket) {
	if idx, ok := g.index(b.start.nanos()); ok {
		accs[idx].addBucket(b)
	}
}

func buildSeries(r Range, spec rangeSpec, g grid, accs []stepAcc) Series {
	const fields = 9
	points := make([]SeriesPoint, g.n)
	vals := make([]float32, fields*g.n) // one allocation backs every non-nil field
	for i := range points {
		points[i].T = time.Unix(0, g.first+int64(i)*g.step).UTC()
		a := accs[i]
		if a.w == 0 {
			continue
		}
		v := vals[i*fields : (i+1)*fields : (i+1)*fields]
		v[0] = float32(a.cpu / a.w)
		v[1] = float32(a.mem / a.w)
		v[2] = float32(a.disk / a.w)
		v[3] = float32(a.in / a.w)
		v[4] = float32(a.out / a.w)
		points[i].CPU, points[i].Mem, points[i].Disk = &v[0], &v[1], &v[2]
		points[i].NetInBps, points[i].NetOutBps = &v[3], &v[4]
		if a.xw == 0 {
			continue // only older agents reported in this step: null, not 0
		}
		v[5] = float32(a.load1 / a.xw)
		v[6] = float32(a.swap / a.xw)
		v[7] = float32(a.read / a.xw)
		v[8] = float32(a.write / a.xw)
		points[i].Load1, points[i].Swap = &v[5], &v[6]
		points[i].DiskReadBps, points[i].DiskWriteBps = &v[7], &v[8]
	}
	return Series{
		Range:       r,
		StepSeconds: int(spec.step / time.Second),
		From:        points[0].T,
		To:          points[len(points)-1].T,
		Points:      points,
		Stats: map[string]Stat{
			SeriesCPU:    statOf(points, func(p SeriesPoint) *float32 { return p.CPU }),
			SeriesMem:    statOf(points, func(p SeriesPoint) *float32 { return p.Mem }),
			SeriesDisk:   statOf(points, func(p SeriesPoint) *float32 { return p.Disk }),
			SeriesNetIn:  statOf(points, func(p SeriesPoint) *float32 { return p.NetInBps }),
			SeriesNetOut: statOf(points, func(p SeriesPoint) *float32 { return p.NetOutBps }),

			SeriesLoad1:     statOf(points, func(p SeriesPoint) *float32 { return p.Load1 }),
			SeriesSwap:      statOf(points, func(p SeriesPoint) *float32 { return p.Swap }),
			SeriesDiskRead:  statOf(points, func(p SeriesPoint) *float32 { return p.DiskReadBps }),
			SeriesDiskWrite: statOf(points, func(p SeriesPoint) *float32 { return p.DiskWriteBps }),
		},
	}
}

// statOf is min/avg/max over non-nil points and the last non-nil value.
// Every key is always present; all zeros means no data in the range.
func statOf(points []SeriesPoint, field func(SeriesPoint) *float32) Stat {
	var (
		st    Stat
		sum   float64
		count int
	)
	for _, p := range points {
		v := field(p)
		if v == nil {
			continue
		}
		if count == 0 {
			st.Min, st.Max = *v, *v
		}
		st.Min, st.Max = min(st.Min, *v), max(st.Max, *v)
		sum += float64(*v)
		count++
		st.Now = *v
	}
	if count > 0 {
		st.Avg = float32(sum / float64(count))
	}
	return st
}

// Sparkline returns the minute buckets (closed plus the current partial)
// that fall in the last n minutes, oldest first. Missing minutes are skipped,
// not zero filled, so an offline server shows a short line, not a flat one.
func (s *Store) Sparkline(serverID int64, n int) (cpu, mem, disk []float32) {
	if n <= 0 {
		return nil, nil, nil
	}
	st := s.lookup(serverID)
	if st == nil {
		return nil, nil, nil
	}
	n = min(n, s.recentCap+1) // keeps lo from underflowing for absurd n
	hi := minuteOf(s.now())
	lo := hi - mins(n-1)

	st.mu.Lock()
	picked := make([]cbucket, 0, n)
	if st.minute.open && st.minute.start >= lo && st.minute.start <= hi {
		picked = append(picked, st.minute.bucket().cbucket)
	}
	for i := st.recent.size() - 1; i >= 0 && len(picked) < n; i-- {
		b, _ := st.recent.at(i)
		if b.start < lo {
			break
		}
		if b.start <= hi {
			picked = append(picked, b)
		}
	}
	st.mu.Unlock()

	if len(picked) == 0 {
		return nil, nil, nil
	}
	cpu = make([]float32, len(picked))
	mem = make([]float32, len(picked))
	disk = make([]float32, len(picked))
	for i, b := range picked {
		j := len(picked) - 1 - i // picked is newest first
		cpu[j], mem[j], disk[j] = b.cpuAvg, b.memAvg, b.diskAvg
	}
	return cpu, mem, disk
}

type cacheKey struct {
	server int64
	r      Range
}

type cacheEntry struct {
	from, to time.Time
	buckets  []fbucket
}

// historyCache holds History results per (server, range) until the next
// successful flush. The generation guards against a read that started before
// a flush storing its now-stale result after the flush cleared the cache.
type historyCache struct {
	mu      sync.Mutex
	gen     uint64
	entries map[cacheKey]cacheEntry
}

func (c *historyCache) get(k cacheKey, from, to time.Time, needTo bool) ([]fbucket, uint64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[k]
	if !ok || e.from.After(from) || (needTo && e.to.Before(to)) {
		return nil, c.gen, false
	}
	return e.buckets, c.gen, true
}

func (c *historyCache) put(k cacheKey, gen uint64, e cacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if gen == c.gen {
		c.entries[k] = e
	}
}

func (c *historyCache) invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	clear(c.entries)
}

func (c *historyCache) forget(serverID int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++ // an in-flight read for this server must not repopulate it
	for k := range c.entries {
		if k.server == serverID {
			delete(c.entries, k)
		}
	}
}

// historyBuckets reads persisted buckets in [from, to), served from the cache
// when a previous read covers the range. needTo requires the cached copy to
// reach `to` (minute backfill); hour ranges extend from memory instead.
func (s *Store) historyBuckets(ctx context.Context, k cacheKey, res Resolution, from, to time.Time, needTo bool) ([]fbucket, error) {
	cached, gen, ok := s.cache.get(k, from, to, needTo)
	if ok {
		return cached, nil
	}
	raw, err := s.history.ReadBuckets(ctx, k.server, res, from, to)
	if err != nil {
		return nil, fmt.Errorf("metrics: read %s history for server %d: %w", k.r, k.server, err)
	}
	bs := make([]fbucket, 0, len(raw))
	for _, b := range raw {
		if b.Start.Before(from) || !b.Start.Before(to) {
			continue
		}
		bs = append(bs, compactBucket(b))
	}
	s.cache.put(k, gen, cacheEntry{from: from, to: to, buckets: bs})
	return bs, nil
}
