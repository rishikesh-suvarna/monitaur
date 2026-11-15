package metrics

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"slices"
	"sync"
	"time"
)

const (
	defaultRawWindow         = time.Hour
	defaultRecentWindow      = 24 * time.Hour
	defaultFlushInterval     = 30 * time.Minute
	defaultMaxPendingBuckets = 200_000
	defaultBucketGrace       = 5 * time.Second

	// rawRingSpacing sizes the raw ring: RawWindow / 4 s. Agents default to
	// 5 s, and sizing for slightly faster arrival keeps a full RawWindow in
	// the ring despite network jitter (900 points, ~29 KB at defaults).
	rawRingSpacing = 4 * time.Second

	// minIntervalSlack tolerates arrival jitter: an agent sending every 5 s
	// against a 5 s minimum lands at 4.98 s about half the time, and those
	// samples must not be dropped. Effective rate stays within 1.11x.
	minIntervalSlack = 0.1

	maxPercent = 100
	// percentRoundingSlack accepts float rounding just over 100 (gopsutil
	// can report 100.0000001); such values are clamped to 100.
	percentRoundingSlack = 0.01
)

var (
	errInvalidSample = errors.New("invalid sample")
	errForgotten     = errors.New("server was forgotten")
)

// Config tunes the store. Zero fields take the defaults from DefaultConfig;
// negative durations or counts are rejected by New.
type Config struct {
	RawWindow         time.Duration    // default 1h
	RecentWindow      time.Duration    // default 24h of minute buckets
	FlushInterval     time.Duration    // default 30m
	MaxPendingBuckets int              // default 200_000
	JournalDir        string           // "" disables the journal
	BucketGrace       time.Duration    // default 5s
	Now               func() time.Time // nil = time.Now (tests inject)
}

func DefaultConfig() Config {
	return Config{
		RawWindow:         defaultRawWindow,
		RecentWindow:      defaultRecentWindow,
		FlushInterval:     defaultFlushInterval,
		MaxPendingBuckets: defaultMaxPendingBuckets,
		BucketGrace:       defaultBucketGrace,
	}
}

func (c Config) withDefaults() (Config, error) {
	d := DefaultConfig()
	durations := []struct {
		name string
		v    *time.Duration
		def  time.Duration
	}{
		{"RawWindow", &c.RawWindow, d.RawWindow},
		{"RecentWindow", &c.RecentWindow, d.RecentWindow},
		{"FlushInterval", &c.FlushInterval, d.FlushInterval},
		{"BucketGrace", &c.BucketGrace, d.BucketGrace},
	}
	for _, f := range durations {
		if *f.v < 0 {
			return c, fmt.Errorf("metrics: %s must not be negative, got %s", f.name, *f.v)
		}
		if *f.v == 0 {
			*f.v = f.def
		}
	}
	if c.MaxPendingBuckets < 0 {
		return c, fmt.Errorf("metrics: MaxPendingBuckets must not be negative, got %d", c.MaxPendingBuckets)
	}
	if c.MaxPendingBuckets == 0 {
		c.MaxPendingBuckets = d.MaxPendingBuckets
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c, nil
}

// Stats is a snapshot for /debug/stats. LastFlush and Flushes count
// successful flushes; LastFlushErr is the error of the most recent attempt
// ("" when it succeeded).
type Stats struct {
	Servers        int
	PendingBuckets int
	DroppedBuckets int64
	LastFlush      time.Time
	LastFlushErr   string
	Flushes        int64
}

// Store keeps per-server metric state in memory and writes closed rollups to
// the Sink every FlushInterval (PLAN.md 2.3, B2 write-behind).
//
// Lock order: s.mu is never held while taking another lock; then st.mu, then
// s.qmu, then journal.mu. No mutex is held across Sink or History calls; the
// only thing held across Sink I/O is flushSem, which serializes flushes and
// is never touched by ingest or read paths.
type Store struct {
	cfg     Config
	sink    Sink
	history History
	log     *slog.Logger

	rawCap, recentCap, hourCap int
	// startMinute is when this process began observing. Minute buckets from
	// memFrom (startMinute+1 until the ring evicts) onwards are complete in
	// memory; anything earlier may only exist in History.
	startMinute mins

	mu        sync.RWMutex
	servers   map[int64]*serverState
	forgotten map[int64]struct{} // deleted servers; IDs are never reused

	qmu            sync.Mutex
	pending        []Bucket
	journal        *journal           // nil when JournalDir == ""
	flushing       bool               // a flush snapshot is out at the Sink
	flushForgotten map[int64]struct{} // Forget calls while flushing, filtered on requeue
	dropped        int64
	droppedLogged  int64
	lastFlush      time.Time
	lastFlushErr   string
	flushes        int64

	flushSem chan struct{}

	hooksMu sync.Mutex
	hooks   []func(ctx context.Context)

	cache historyCache
}

// serverState is everything held for one server, guarded by its own mutex so
// ingest for different servers never contends.
type serverState struct {
	mu   sync.Mutex
	id   int64
	dead bool // set by Forget; late holders of the pointer must not write

	hasLast bool
	lastT   int64 // unix nanos of the last accepted sample
	lastRx  uint64
	lastTx  uint64
	latest  Latest

	raw    ring[rawPoint]
	recent ring[cbucket] // closed minute buckets
	hours  ring[cbucket] // closed hour buckets, so 7d/30d see hours not yet flushed

	minute agg
	hour   agg

	lastClosedMinute mins
	lastClosedHour   mins
	memFrom          mins
}

// New builds a store. With a journal, leftover files from a previous process
// are replayed into the pending queue and the recent rings before New
// returns. A nil History makes long ranges memory only.
func New(cfg Config, sink Sink, history History, log *slog.Logger) (*Store, error) {
	if sink == nil {
		return nil, errors.New("metrics: sink is required")
	}
	cfg, err := cfg.withDefaults()
	if err != nil {
		return nil, err
	}
	if log == nil {
		log = slog.Default()
	}
	s := &Store{
		cfg:       cfg,
		sink:      sink,
		history:   history,
		log:       log,
		rawCap:    ceilDiv(cfg.RawWindow, rawRingSpacing),
		recentCap: ceilDiv(cfg.RecentWindow, time.Minute),
		hourCap:   ceilDiv(cfg.RecentWindow, time.Hour),
		servers:   make(map[int64]*serverState),
		forgotten: make(map[int64]struct{}),
		flushSem:  make(chan struct{}, 1),
		cache:     historyCache{entries: make(map[cacheKey]cacheEntry)},
	}
	s.startMinute = minuteOf(s.now())

	if cfg.JournalDir != "" {
		j, files, err := openJournal(cfg.JournalDir, s.now, log)
		if err != nil {
			return nil, fmt.Errorf("metrics: %w", err)
		}
		s.journal = j
		if err := s.replay(files); err != nil {
			return nil, fmt.Errorf("metrics: replay journal: %w", err)
		}
	}
	return s, nil
}

func ceilDiv(a, b time.Duration) int {
	return int((a + b - 1) / b)
}

func (s *Store) now() time.Time {
	return s.cfg.Now().UTC()
}

func (s *Store) newState(id int64) *serverState {
	return &serverState{
		id:               id,
		raw:              newRing[rawPoint](s.rawCap),
		recent:           newRing[cbucket](s.recentCap),
		hours:            newRing[cbucket](s.hourCap),
		lastClosedMinute: noMinute,
		lastClosedHour:   noMinute,
		memFrom:          s.startMinute + 1,
	}
}

func (s *Store) lookup(id int64) *serverState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.servers[id]
}

func (s *Store) stateFor(id int64) (*serverState, error) {
	if st := s.lookup(id); st != nil {
		return st, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, gone := s.forgotten[id]; gone {
		return nil, fmt.Errorf("%w: %d", errForgotten, id)
	}
	st := s.servers[id]
	if st == nil {
		st = s.newState(id)
		s.servers[id] = st
	}
	return st, nil
}

func (s *Store) snapshotStates() []*serverState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*serverState, 0, len(s.servers))
	for _, st := range s.servers {
		out = append(out, st)
	}
	return out
}

// Ingest records a sample. minInterval > 0 drops samples arriving faster
// (returns ErrTooFrequent), with 10% slack for jitter. A sample whose
// timestamp is not after the previous accepted one also gets ErrTooFrequent.
//
// Sample.Time is used when it is within BucketGrace of the store clock;
// otherwise (zero, skewed or delayed) the receive time is used, so one
// agent's clock cannot reopen a closed minute or starve its rollups.
func (s *Store) Ingest(serverID int64, smp Sample, minInterval time.Duration) (Point, error) {
	if serverID <= 0 {
		return Point{}, fmt.Errorf("%w: server id %d", errInvalidSample, serverID)
	}
	if err := validateSample(&smp); err != nil {
		return Point{}, err
	}
	st, err := s.stateFor(serverID)
	if err != nil {
		return Point{}, err
	}

	st.mu.Lock()
	defer st.mu.Unlock()
	if st.dead {
		return Point{}, fmt.Errorf("%w: %d", errForgotten, serverID)
	}

	// Read the clock under the lock so receive times are ordered per server.
	now := s.now()
	t := s.sampleTime(smp.Time, now)
	tn := t.UnixNano()
	var elapsed time.Duration
	if st.hasLast {
		elapsed = time.Duration(tn - st.lastT)
		if elapsed <= 0 {
			return Point{}, fmt.Errorf("%w: timestamp %s is not after the previous sample", ErrTooFrequent, t.Format(time.RFC3339Nano))
		}
		if minInterval > 0 && float64(elapsed) < float64(minInterval)*(1-minIntervalSlack) {
			return Point{}, fmt.Errorf("%w: %s since the previous sample, minimum %s", ErrTooFrequent, elapsed, minInterval)
		}
	}

	p := rawPoint{
		t:    tn,
		cpu:  float32(smp.CPUPercent),
		mem:  float32(smp.MemPercent),
		disk: float32(smp.DiskPercent),
	}
	if st.hasLast {
		p.in = counterRate(smp.NetRxTotal, st.lastRx, elapsed)
		p.out = counterRate(smp.NetTxTotal, st.lastTx, elapsed)
	}

	st.raw.push(p)
	closed := st.observe(p, &smp)

	st.hasLast, st.lastT, st.lastRx, st.lastTx = true, tn, smp.NetRxTotal, smp.NetTxTotal
	st.latest = Latest{
		Point:          p.point(),
		CPUCores:       smp.CPUCores,
		MemTotalBytes:  smp.MemTotalBytes,
		MemUsedBytes:   smp.MemUsedBytes,
		DiskTotalBytes: smp.DiskTotalBytes,
		DiskUsedBytes:  smp.DiskUsedBytes,
		UptimeSeconds:  smp.UptimeSeconds,
		ReceivedAt:     now,
	}
	if len(closed) > 0 {
		s.enqueue(closed)
	}
	return st.latest.Point, nil
}

func (s *Store) sampleTime(t, now time.Time) time.Time {
	if t.IsZero() {
		return now
	}
	if d := t.Sub(now); d > s.cfg.BucketGrace || d < -s.cfg.BucketGrace {
		return now
	}
	return t.UTC()
}

func validateSample(smp *Sample) error {
	var err error
	if smp.CPUPercent, err = checkPercent("cpu_percent", smp.CPUPercent); err != nil {
		return err
	}
	if smp.MemPercent, err = checkPercent("mem_percent", smp.MemPercent); err != nil {
		return err
	}
	if smp.DiskPercent, err = checkPercent("disk_percent", smp.DiskPercent); err != nil {
		return err
	}
	if smp.CPUCores < 0 {
		return fmt.Errorf("%w: cpu_cores %d is negative", errInvalidSample, smp.CPUCores)
	}
	if smp.UptimeSeconds < 0 {
		return fmt.Errorf("%w: uptime_seconds %d is negative", errInvalidSample, smp.UptimeSeconds)
	}
	return nil
}

func checkPercent(name string, v float64) (float64, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, fmt.Errorf("%w: %s is not a finite number", errInvalidSample, name)
	}
	if v < 0 || v > maxPercent+percentRoundingSlack {
		return 0, fmt.Errorf("%w: %s %g is outside [0, %d]", errInvalidSample, name, v, maxPercent)
	}
	return min(v, maxPercent), nil
}

// counterRate turns cumulative counters into bytes/s. A counter that went
// backwards means the host rebooted (or the interface reset): report 0, not a
// huge negative or wrapped value.
func counterRate(cur, prev uint64, elapsed time.Duration) float32 {
	if cur < prev || elapsed <= 0 {
		return 0
	}
	return float32(float64(cur-prev) / elapsed.Seconds())
}

// observe adds a point to the open minute, closing the previous minute first
// when the point belongs to a later one. Returns buckets that closed.
func (st *serverState) observe(p rawPoint, smp *Sample) []Bucket {
	m := minuteOfNanos(p.t)
	var closed []Bucket
	if st.minute.open && m > st.minute.start {
		closed = st.closeMinute(closed)
	}
	if m <= st.lastClosedMinute || (st.minute.open && m < st.minute.start) {
		// That minute is already rolled up (only reachable around a journal
		// replay); the raw ring still has the point.
		return closed
	}
	if !st.minute.open {
		st.minute.begin(m)
	}
	st.minute.addPoint(p, smp)
	return closed
}

func (st *serverState) closeMinute(out []Bucket) []Bucket {
	b := st.minute.bucket()
	st.minute = agg{}
	// Absorb first: if this minute starts a new hour, the previous hour is
	// emitted before it, keeping pending chronological per server.
	out = st.absorbMinute(b, out)
	return append(out, b.toBucket(st.id, Minute))
}

// absorbMinute files a closed minute into the recent ring and the hour
// aggregate. Shared by closing and journal replay.
func (st *serverState) absorbMinute(b cbucket, out []Bucket) []Bucket {
	st.lastClosedMinute = b.start
	if old, evicted := st.recent.push(b); evicted {
		st.memFrom = max(st.memFrom, old.start+1)
	}
	h := b.start.hour()
	if st.hour.open && h > st.hour.start {
		out = st.closeHour(out)
	}
	if h <= st.lastClosedHour || (st.hour.open && h < st.hour.start) {
		return out
	}
	if !st.hour.open {
		st.hour.begin(h)
	}
	st.hour.addBucket(b)
	return out
}

func (st *serverState) closeHour(out []Bucket) []Bucket {
	b := st.hour.bucket()
	st.hour = agg{}
	st.lastClosedHour = b.start
	st.hours.push(b)
	return append(out, b.toBucket(st.id, Hour))
}

// closeDue closes the open minute once now > minuteEnd + grace, and the open
// hour once its hour (plus grace, so its last minute is in) has passed.
func (st *serverState) closeDue(nowN int64, grace time.Duration, out []Bucket) []Bucket {
	g := int64(grace)
	if st.minute.open && nowN > (st.minute.start+1).nanos()+g {
		out = st.closeMinute(out)
	}
	if st.hour.open && nowN > (st.hour.start+minutesPerHour).nanos()+g {
		out = st.closeHour(out)
	}
	return out
}

func (st *serverState) closeAll(out []Bucket) []Bucket {
	if st.minute.open {
		out = st.closeMinute(out)
	}
	if st.hour.open {
		out = st.closeHour(out)
	}
	return out
}

// enqueue journals and queues closed buckets. Callers hold st.mu so a
// concurrent Forget either sees these buckets in pending or runs first and
// marks the state dead.
func (s *Store) enqueue(bs []Bucket) {
	s.qmu.Lock()
	defer s.qmu.Unlock()
	if s.journal != nil {
		// Errors are logged inside the journal; the buckets still flush from memory.
		_ = s.journal.append(bs)
	}
	s.pending = append(s.pending, bs...)
	s.enforceCapLocked()
}

// enforceCapLocked drops the oldest pending buckets beyond MaxPendingBuckets.
func (s *Store) enforceCapLocked() {
	over := len(s.pending) - s.cfg.MaxPendingBuckets
	if over <= 0 {
		return
	}
	clear(s.pending[:over])
	s.pending = s.pending[over:]
	s.dropped += int64(over)
}

// tick is the 1 s housekeeping step: close due buckets for every server, then
// fsync the journal once for everything appended since the last tick.
func (s *Store) tick() {
	nowN := s.now().UnixNano()
	var scratch []Bucket
	for _, st := range s.snapshotStates() {
		st.mu.Lock()
		if !st.dead {
			scratch = st.closeDue(nowN, s.cfg.BucketGrace, scratch[:0])
			if len(scratch) > 0 {
				s.enqueue(scratch)
			}
		}
		st.mu.Unlock()
	}
	s.syncJournal()
}

// closeEverything closes every open minute and hour, partial or not. Used on
// shutdown so a clean stop loses nothing.
func (s *Store) closeEverything() {
	var scratch []Bucket
	for _, st := range s.snapshotStates() {
		st.mu.Lock()
		if !st.dead {
			scratch = st.closeAll(scratch[:0])
			if len(scratch) > 0 {
				s.enqueue(scratch)
			}
		}
		st.mu.Unlock()
	}
	s.syncJournal()
}

func (s *Store) syncJournal() {
	if s.journal == nil {
		return
	}
	// Errors are logged inside the journal (once until it recovers).
	_ = s.journal.sync()
}

// replay loads leftover journal files into pending and the per-server rings.
// Minutes of an hour that never closed seed that hour's aggregate so the hour
// rollup keeps what survived the crash.
func (s *Store) replay(files []string) error {
	if len(files) == 0 {
		return nil
	}
	buckets, forgotten, err := readJournalFiles(files, s.log)
	if err != nil {
		return err
	}
	for id := range forgotten {
		s.forgotten[id] = struct{}{}
	}

	s.qmu.Lock()
	s.pending = append(s.pending, buckets...)
	s.enforceCapLocked()
	s.qmu.Unlock()

	byServer := make(map[int64][]Bucket)
	for _, b := range buckets {
		byServer[b.ServerID] = append(byServer[b.ServerID], b)
	}
	var closed []Bucket
	for id, list := range byServer {
		slices.SortFunc(list, func(a, b Bucket) int { return a.Start.Compare(b.Start) })
		st := s.newState(id)
		for _, b := range list {
			if b.Res != Hour {
				continue
			}
			cb := compactBucket(b)
			if cb.start > st.lastClosedHour {
				st.hours.push(cb)
				st.lastClosedHour = cb.start
			}
		}
		for _, b := range list {
			if b.Res != Minute {
				continue
			}
			if cb := compactBucket(b); cb.start > st.lastClosedMinute {
				closed = st.absorbMinute(cb, closed)
			}
		}
		s.servers[id] = st
	}
	if len(closed) > 0 {
		s.enqueue(closed)
	}
	s.log.Info("metrics journal replayed",
		"files", len(files), "buckets", len(buckets), "servers", len(byServer))
	return nil
}

// Latest returns the most recent accepted sample for a server.
func (s *Store) Latest(serverID int64) (Latest, bool) {
	st := s.lookup(serverID)
	if st == nil {
		return Latest{}, false
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if !st.hasLast {
		return Latest{}, false
	}
	return st.latest, true
}

// LastSeen returns the receive time of the last accepted sample for every
// server that has one, for the flush-window last_seen batch update.
func (s *Store) LastSeen() map[int64]time.Time {
	states := s.snapshotStates()
	out := make(map[int64]time.Time, len(states))
	for _, st := range states {
		st.mu.Lock()
		if st.hasLast && !st.dead {
			out[st.id] = st.latest.ReceivedAt
		}
		st.mu.Unlock()
	}
	return out
}

// Forget drops everything held for a deleted server: rings, aggregates,
// pending buckets and cached history. Later Ingest calls for the same ID are
// rejected, since server IDs are never reused and a stray bucket for a
// deleted server would fail the rollup foreign key on every flush.
func (s *Store) Forget(serverID int64) {
	s.mu.Lock()
	st := s.servers[serverID]
	delete(s.servers, serverID)
	s.forgotten[serverID] = struct{}{}
	s.mu.Unlock()

	if st != nil {
		st.mu.Lock()
		st.dead = true
		// Release the memory now; readers holding a stale pointer see empty rings.
		st.raw, st.recent, st.hours = newRing[rawPoint](0), newRing[cbucket](0), newRing[cbucket](0)
		st.minute, st.hour = agg{}, agg{}
		st.mu.Unlock()
	}

	s.qmu.Lock()
	s.pending = slices.DeleteFunc(s.pending, func(b Bucket) bool { return b.ServerID == serverID })
	if s.flushing {
		if s.flushForgotten == nil {
			s.flushForgotten = make(map[int64]struct{})
		}
		s.flushForgotten[serverID] = struct{}{}
	}
	if s.journal != nil {
		_ = s.journal.appendForget(serverID)
	}
	s.qmu.Unlock()

	s.cache.forget(serverID)
}

// OnFlush registers a housekeeping hook. Hooks run in registration order after
// every flush attempt with the flush's context. A hook must not call Flush.
func (s *Store) OnFlush(fn func(ctx context.Context)) {
	if fn == nil {
		return
	}
	s.hooksMu.Lock()
	defer s.hooksMu.Unlock()
	s.hooks = append(s.hooks, fn)
}

func (s *Store) Stats() Stats {
	s.mu.RLock()
	servers := len(s.servers)
	s.mu.RUnlock()

	s.qmu.Lock()
	defer s.qmu.Unlock()
	return Stats{
		Servers:        servers,
		PendingBuckets: len(s.pending),
		DroppedBuckets: s.dropped,
		LastFlush:      s.lastFlush,
		LastFlushErr:   s.lastFlushErr,
		Flushes:        s.flushes,
	}
}
