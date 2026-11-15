package metrics

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func journalFiles(t *testing.T, dir string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, "*"+journalExt))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

type serverBucketKey struct {
	server int64
	res    Resolution
	start  int64
}

func keysOf(bs []Bucket) []serverBucketKey {
	out := make([]serverBucketKey, 0, len(bs))
	for _, b := range bs {
		out = append(out, serverBucketKey{server: b.ServerID, res: b.Res, start: b.Start.Unix()})
	}
	return out
}

func assertUnique(t *testing.T, bs []Bucket) {
	t.Helper()
	seen := make(map[serverBucketKey]bool)
	for _, k := range keysOf(bs) {
		if seen[k] {
			t.Fatalf("duplicate bucket %+v", k)
		}
		seen[k] = true
	}
}

func TestJournalReplayAfterCrash(t *testing.T) {
	dir := t.TempDir()
	clock := newClock(t0)
	downSink := &fakeSink{}
	downSink.fail(100)
	a := newTestStore(t, Config{JournalDir: dir}, clock, downSink, nil)

	for _, id := range []int64{1, 2} {
		for m := range 3 {
			ingestAt(t, a, clock, id, t0.Add(time.Duration(m)*time.Minute+5*time.Second), float64(10*(m+1)))
		}
	}
	clock.Set(t0.Add(3*time.Minute + 6*time.Second))
	a.tick() // closes 12:02 for both and fsyncs

	// A failed flush rotates the journal but must keep the rotated file.
	if err := a.Flush(context.Background()); err == nil {
		t.Fatal("flush against a down sink succeeded")
	}
	ingestAt(t, a, clock, 1, t0.Add(3*time.Minute+10*time.Second), 40)
	ingestAt(t, a, clock, 1, t0.Add(4*time.Minute), 50) // closes 12:03 into a second file
	clock.Set(t0.Add(4*time.Minute + time.Second))
	a.tick()
	want := keysOf(pendingOf(a))
	if len(want) != 7 || len(journalFiles(t, dir)) != 2 {
		t.Fatalf("setup: %d pending, %d journal files; want 7 and 2", len(want), len(journalFiles(t, dir)))
	}

	// Crash: a is abandoned without Run's shutdown. A new process starts.
	clockB := newClock(t0.Add(5 * time.Minute))
	sink := &fakeSink{}
	b := newTestStore(t, Config{JournalDir: dir}, clockB, sink, nil)

	got := pendingOf(b)
	assertUnique(t, got)
	if gotKeys := keysOf(got); len(gotKeys) != len(want) {
		t.Fatalf("replayed %d buckets, want %d", len(gotKeys), len(want))
	} else {
		for i := range want {
			if gotKeys[i] != want[i] {
				t.Fatalf("replayed bucket %d = %+v, want %+v", i, gotKeys[i], want[i])
			}
		}
	}

	if cpu, _, _ := b.Sparkline(1, 10); len(cpu) != 4 || cpu[0] != 10 || cpu[3] != 40 {
		t.Fatalf("server 1 recent ring after replay = %v, want 4 minutes 10..40", cpu)
	}
	if cpu, _, _ := b.Sparkline(2, 10); len(cpu) != 3 {
		t.Fatalf("server 2 recent ring after replay = %v, want 3 minutes", cpu)
	}
	series := mustSeries(t, b, 1, Range6h)
	if p := pointAt(t, series, t0.Add(time.Minute)); p.CPU == nil || *p.CPU != 20 {
		t.Fatalf("6h series after replay at 12:01 = %v, want 20", p.CPU)
	}

	if err := b.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertUnique(t, sink.buckets())
	if n := len(sink.buckets()); n != 7 {
		t.Fatalf("flushed %d buckets after replay, want 7", n)
	}
	if files := journalFiles(t, dir); len(files) != 0 {
		t.Fatalf("replayed files not deleted after a good flush: %v", files)
	}

	// Replayed minutes of the hour that was open at the crash seed that hour,
	// so its rollup keeps the pre-crash samples.
	b.closeEverything()
	for _, bk := range pendingOf(b) {
		if bk.ServerID == 1 && bk.Res == Hour && bk.Samples != 4 {
			t.Fatalf("server 1 hour after replay has %d samples, want 4", bk.Samples)
		}
	}
}

func writeJournalFile(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), journalFilePerm); err != nil {
		t.Fatal(err)
	}
}

func bucketLine(t *testing.T, b Bucket) string {
	t.Helper()
	raw, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestJournalReplayDedupeTombstoneAndTornLine(t *testing.T) {
	dir := t.TempDir()
	m := func(id int64, start time.Time, samples int) Bucket {
		return Bucket{ServerID: id, Res: Minute, Start: start, Samples: samples, CPUAvg: float32(samples)}
	}
	writeJournalFile(t, filepath.Join(dir, "100"+journalExt),
		bucketLine(t, m(1, t0, 2)),
		bucketLine(t, m(1, t0.Add(time.Minute), 3)),
		bucketLine(t, m(3, t0, 1)),
	)
	writeJournalFile(t, filepath.Join(dir, "200"+journalExt),
		bucketLine(t, m(1, t0, 5)), // same bucket, fuller copy
		`{"forget":3}`,
		bucketLine(t, Bucket{ServerID: 1, Res: Hour, Start: t0, Samples: 8}),
		`{"server_id":1,"res":1,"sta`, // torn final write
	)

	clock := newClock(t0.Add(90 * time.Second))
	s := newTestStore(t, Config{JournalDir: dir}, clock, nil, nil)

	got := pendingOf(s)
	want := []bucketID{{Minute, "12:00:00", 5}, {Minute, "12:01:00", 3}, {Hour, "12:00:00", 8}}
	if !equalIDs(idsOf(got), want) {
		t.Fatalf("replayed %v, want %v", idsOf(got), want)
	}
	for _, b := range got {
		if b.ServerID != 1 {
			t.Fatalf("tombstoned server %d replayed", b.ServerID)
		}
	}
	if _, err := s.Ingest(3, sampleAt(clock.Now(), 1), 0); !errors.Is(err, errForgotten) {
		t.Fatalf("Ingest for a tombstoned server err = %v, want errForgotten", err)
	}

	// A sample inside an already replayed minute and hour must not produce a
	// second bucket for either.
	if _, err := s.Ingest(1, sampleAt(clock.Now(), 1), 0); err != nil {
		t.Fatal(err)
	}
	s.closeEverything()
	assertUnique(t, pendingOf(s))
	if n := len(pendingOf(s)); n != len(want) {
		t.Fatalf("pending grew to %d after closing replayed periods", n)
	}
}

func TestJournalFileNamesUniqueWithFrozenClock(t *testing.T) {
	dir := t.TempDir()
	clock := newClock(t0) // never advances
	sink := &fakeSink{}
	s := newTestStore(t, Config{JournalDir: dir}, clock, sink, nil)

	sink.fail(2)
	for i := range 2 {
		s.enqueue(syntheticBuckets(1, int64(i+1)))
		s.syncJournal()
		_ = s.Flush(context.Background())
	}
	if files := journalFiles(t, dir); len(files) != 2 {
		t.Fatalf("journal files = %v, want 2 distinct files", files)
	}
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if files := journalFiles(t, dir); len(files) != 0 {
		t.Fatalf("files left after a good flush: %v", files)
	}
	if n := len(sink.buckets()); n != 2 {
		t.Fatalf("sink got %d buckets, want 2", n)
	}
}

func TestForgetSurvivesJournalReplay(t *testing.T) {
	dir := t.TempDir()
	clock := newClock(t0)
	a := newTestStore(t, Config{JournalDir: dir}, clock, nil, nil)
	for _, id := range []int64{1, 2} {
		ingestAt(t, a, clock, id, t0, 10)
		ingestAt(t, a, clock, id, t0.Add(time.Minute), 10)
	}
	a.Forget(1)
	a.syncJournal()

	b := newTestStore(t, Config{JournalDir: dir}, newClock(t0.Add(2*time.Minute)), nil, nil)
	for _, bk := range pendingOf(b) {
		if bk.ServerID == 1 {
			t.Fatal("bucket of a forgotten server came back on replay")
		}
	}
	if n := len(pendingOf(b)); n != 1 {
		t.Fatalf("pending after replay = %d, want 1", n)
	}
}
